/**
 * AWS spend by project, metered by Maestro itself.
 *
 * Why a meter and not the bill: the only AWS identity Maestro has (the default
 * profile in ~/.aws) can describe EC2 but cannot read Cost Explorer, Budgets or
 * CloudTrail (all checked 2026-11-13). Agents launch instances with their own
 * scoped keys (aws-svc-key), and every launch is required to carry the tag
 * `project=<name>` on the instance and its volume, so "what has project X spent"
 * is answerable from EC2 alone: instance-seconds x price, plus disk GB-hours.
 *
 * How: every POLL_MS, DescribeInstances/Volumes/Snapshots in each enabled region.
 * Each resource carries an `accounted_until`; a poll charges the interval from
 * there to now (or to the moment it stopped) and splits it across UTC days in
 * aws_meter_ledger. Terminated instances stay visible for about an hour, and the
 * stop/terminate time is in StateTransitionReason, so a run shorter than one poll
 * is still charged for its true length.
 *
 * What it does NOT see, so the number is a floor: data transfer, public IPv4
 * ($0.005/h per address), EBS IOPS/throughput above the gp3 baseline, S3, and
 * anything before the meter started (`since` in every answer). Snapshots are
 * charged at their full source-volume size, which overstates incremental ones.
 * When the account grants ce:GetCostAndUsage, `billed()` returns the real bill
 * grouped by the same tag and supersedes this; until then it says why it can't.
 *
 * Prices follow pricing.js rule 1: an instance type not in the table is charged
 * null and reported as unpriced hours, never guessed. Spot instances are charged
 * the current spot price for their type and AZ (DescribeSpotPriceHistory), which
 * is what spot bills. Overrides: setting `aws_pricing_overrides` =
 * {"m7i.8xlarge": 1.6128, ...} (USD per hour, on-demand).
 */
import {
  EC2Client, DescribeRegionsCommand, DescribeInstancesCommand, DescribeVolumesCommand,
  DescribeSnapshotsCommand, DescribeSpotPriceHistoryCommand,
} from '@aws-sdk/client-ec2';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { getDb, getSetting, setSetting, getProject } from './db.js';

const POLL_MS = 5 * 60 * 1000;
const HOME_REGION = 'us-east-2';

// On-demand Linux USD/hour for the `.large` size, us-east-1/us-east-2/us-west-2
// (identical in those three). Sizes scale linearly within a family.
export const AWS_PRICING_VERIFIED_ON = '2026-11-13 (list prices; Pricing API not readable by this key)';
const LARGE = {
  m7i: 0.1008, c7i: 0.08925, r7i: 0.1323, m7a: 0.11592, c7a: 0.10264, r7a: 0.15215,
  m6i: 0.096, c6i: 0.085, r6i: 0.126, m6a: 0.0864, c6a: 0.0765, r6a: 0.1134,
  m5: 0.096, c5: 0.085, r5: 0.126, t3: 0.0832, t3a: 0.0752, t4g: 0.0672,
  m7g: 0.0816, c7g: 0.0725, r7g: 0.1071,
};
const SIZE = { nano: 1 / 16, micro: 1 / 8, small: 1 / 4, medium: 1 / 2, large: 1 };
// USD per GB-month.
const EBS = { gp3: 0.08, gp2: 0.10, io1: 0.125, io2: 0.125, st1: 0.045, sc1: 0.015, standard: 0.05 };
const SNAPSHOT = 0.05;
const HOURS_PER_MONTH = 730;

export function onDemandHourly(type) {
  try {
    const o = JSON.parse(getSetting('aws_pricing_overrides') || '{}');
    if (o[type] != null) return Number(o[type]);
  } catch { /* a bad override must not stop the meter */ }
  const m = /^([a-z0-9]+)\.(\w+)$/.exec(String(type || ''));
  if (!m || LARGE[m[1]] == null) return null;
  const s = m[2];
  let mult = SIZE[s];
  if (mult == null && s === 'xlarge') mult = 2;
  if (mult == null) { const n = /^(\d+)xlarge$/.exec(s); if (n) mult = 2 * Number(n[1]); }
  return mult == null ? null : Math.round(LARGE[m[1]] * mult * 1e5) / 1e5;
}

function ensureTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS aws_meter (
      resource_id TEXT PRIMARY KEY, kind TEXT, project TEXT, name TEXT, region TEXT,
      detail TEXT, lifecycle TEXT, first_seen TEXT, last_seen TEXT, state TEXT,
      accounted_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS aws_meter_ledger (
      day TEXT, project TEXT, kind TEXT, resource_id TEXT, usd REAL, hours REAL,
      unpriced_hours REAL DEFAULT 0,
      PRIMARY KEY (day, resource_id)
    );`);
}

const tagOf = (tags, k) => (tags || []).find((t) => t.Key === k)?.Value || null;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Charge [from, to) to a resource, split at UTC midnights. rate = USD/hour or null. */
function charge(r, from, to, rate) {
  if (!(to > from)) return;
  const db = getDb();
  const up = db.prepare(`INSERT INTO aws_meter_ledger (day, project, kind, resource_id, usd, hours, unpriced_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, resource_id) DO UPDATE SET usd = usd + excluded.usd, hours = hours + excluded.hours,
      unpriced_hours = unpriced_hours + excluded.unpriced_hours, project = excluded.project`);
  for (let a = from; a < to; ) {
    const d = new Date(a);
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const b = Math.min(to, midnight);
    const h = (b - a) / 3600000;
    up.run(dayOf(a), r.project, r.kind, r.id, rate == null ? 0 : h * rate, h, rate == null ? h : 0);
    a = b;
  }
}

// "User initiated (2026-11-13 15:20:40 GMT)" -> ms
function transitionTime(reason) {
  const m = /\((\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) GMT\)/.exec(reason || '');
  return m ? Date.parse(m[1].replace(' ', 'T') + 'Z') : null;
}

const spotCache = new Map(); // `${region}|${az}|${type}` -> { at, price }
async function spotPrice(ec2, region, az, type) {
  const k = `${region}|${az}|${type}`;
  const c = spotCache.get(k);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.price;
  let price = null;
  try {
    const r = await ec2.send(new DescribeSpotPriceHistoryCommand({
      InstanceTypes: [type], AvailabilityZone: az, ProductDescriptions: ['Linux/UNIX'], StartTime: new Date(),
    }));
    const p = r.SpotPriceHistory?.[0]?.SpotPrice;
    price = p ? Number(p) : null;
  } catch { /* fall through: unpriced */ }
  spotCache.set(k, { at: Date.now(), price });
  return price;
}

function upsert(r, now) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM aws_meter WHERE resource_id = ?').get(r.id);
  if (!row) {
    db.prepare(`INSERT INTO aws_meter (resource_id, kind, project, name, region, detail, lifecycle, first_seen, last_seen, state, accounted_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(r.id, r.kind, r.project, r.name, r.region, r.detail, r.lifecycle, now, now, r.state);
  } else {
    db.prepare('UPDATE aws_meter SET project = ?, name = ?, detail = ?, last_seen = ?, state = ? WHERE resource_id = ?')
      .run(r.project, r.name, r.detail, now, r.state, r.id);
  }
  return row ? row.accounted_until : null;
}

function advance(id, until) {
  getDb().prepare('UPDATE aws_meter SET accounted_until = ? WHERE resource_id = ?').run(until, id);
}

async function pollRegion(region, startedAt) {
  const ec2 = new EC2Client({ region });
  const now = Date.now();
  const iso = new Date(now).toISOString();
  // A resource first seen is charged from its own start: launch, create and
  // stop/terminate times are exact in the API, so a run that ended before the meter
  // first looked is still known in full. What the meter cannot know is a resource
  // that was gone before it looked -- that is what `since` means.
  const floor = (t) => t;

  let token;
  do {
    const out = await ec2.send(new DescribeInstancesCommand({ NextToken: token }));
    for (const res of out.Reservations || []) for (const i of res.Instances || []) {
      const r = {
        id: i.InstanceId, kind: 'instance', project: tagOf(i.Tags, 'project'), name: tagOf(i.Tags, 'Name'),
        region, detail: i.InstanceType, lifecycle: i.InstanceLifecycle || 'on-demand', state: i.State?.Name,
      };
      const prev = upsert(r, iso);
      const launched = new Date(i.LaunchTime).getTime();
      let end;
      if (r.state === 'running' || r.state === 'pending' || r.state === 'shutting-down' || r.state === 'stopping') end = now;
      else end = transitionTime(i.StateTransitionReason) || null; // stopped/terminated
      const from = Math.max(prev ?? floor(launched), launched);
      if (end == null) { if (prev == null) advance(r.id, now); continue; }
      const rate = r.lifecycle === 'spot'
        ? await spotPrice(ec2, region, i.Placement?.AvailabilityZone, i.InstanceType)
        : onDemandHourly(i.InstanceType);
      charge(r, from, end, rate);
      advance(r.id, Math.max(end, from));
    }
    token = out.NextToken;
  } while (token);

  token = undefined;
  do {
    const out = await ec2.send(new DescribeVolumesCommand({ NextToken: token }));
    for (const v of out.Volumes || []) {
      const r = {
        id: v.VolumeId, kind: 'volume', project: tagOf(v.Tags, 'project'), name: tagOf(v.Tags, 'Name'),
        region, detail: `${v.Size} GB ${v.VolumeType}`, lifecycle: null, state: v.State,
      };
      const prev = upsert(r, iso);
      const from = prev ?? floor(new Date(v.CreateTime).getTime());
      const perGbMonth = EBS[v.VolumeType];
      charge(r, from, now, perGbMonth == null ? null : (v.Size * perGbMonth) / HOURS_PER_MONTH);
      advance(r.id, now);
    }
    token = out.NextToken;
  } while (token);

  token = undefined;
  do {
    const out = await ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ['self'], NextToken: token }));
    for (const s of out.Snapshots || []) {
      const r = {
        id: s.SnapshotId, kind: 'snapshot', project: tagOf(s.Tags, 'project'), name: tagOf(s.Tags, 'Name') || s.Description || null,
        region, detail: `${s.VolumeSize} GB`, lifecycle: null, state: s.State,
      };
      const prev = upsert(r, iso);
      const from = prev ?? floor(new Date(s.StartTime).getTime());
      charge(r, from, now, (s.VolumeSize * SNAPSHOT) / HOURS_PER_MONTH);
      advance(r.id, now);
    }
    token = out.NextToken;
  } while (token);
}

let regions = null;
let lastPoll = null;
let lastError = null;

async function poll() {
  ensureTables();
  let startedAt = Number(getSetting('aws_meter_started_at') || 0);
  if (!startedAt) { startedAt = Date.now(); setSetting('aws_meter_started_at', String(startedAt)); }
  if (!regions) {
    const r = await new EC2Client({ region: HOME_REGION }).send(new DescribeRegionsCommand({}));
    regions = (r.Regions || []).map((x) => x.RegionName);
  }
  const errs = [];
  await Promise.all(regions.map((rg) => pollRegion(rg, startedAt).catch((e) => errs.push(`${rg}: ${e.name || e.message}`))));
  lastPoll = new Date().toISOString();
  lastError = errs.length ? errs.join('; ') : null;
}

let timer = null;
let running = false;
export function startAwsMeter(intervalMs = POLL_MS) {
  if (timer || getSetting('aws_meter') === 'off') return;
  const run = async () => {
    if (running) return;
    running = true;
    try { await poll(); } catch (e) { lastError = e.name || e.message; } finally { running = false; }
  };
  setTimeout(run, 20000).unref?.();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
}

const monthStart = () => new Date().toISOString().slice(0, 8) + '01';
const daysAgo = (n) => dayOf(Date.now() - n * 86400000);

/**
 * Metered spend. `project` null => every project (untagged as "(untagged)").
 * Windows: today (UTC), last 7 days incl. today, month to date.
 */
export function metered(project = null) {
  ensureTables();
  const db = getDb();
  const since = Number(getSetting('aws_meter_started_at') || 0);
  const where = project == null ? '' : 'AND project = @project';
  const sum = (from) => db.prepare(`SELECT COALESCE(project, '(untagged)') AS project, kind,
      SUM(usd) AS usd, SUM(hours) AS hours, SUM(unpriced_hours) AS unpriced
      FROM aws_meter_ledger WHERE day >= @from ${where} GROUP BY 1, 2`).all({ from, project });
  const shape = (rows) => {
    const out = {};
    for (const r of rows) {
      const p = (out[r.project] ||= { usd: 0, byKind: {}, unpricedHours: 0 });
      p.usd += r.usd;
      p.byKind[r.kind] = Math.round(r.usd * 100) / 100;
      p.unpricedHours += r.unpriced;
    }
    for (const p of Object.values(out)) p.usd = Math.round(p.usd * 100) / 100;
    return out;
  };
  const running = db.prepare(`SELECT resource_id AS id, project, name, region, detail AS type, lifecycle
      FROM aws_meter WHERE kind = 'instance' AND state IN ('pending', 'running') ${project == null ? '' : 'AND project = @project'}`)
    .all({ project }).map((r) => ({ ...r, usdPerHour: r.lifecycle === 'spot' ? null : onDemandHourly(r.type) }));
  return {
    source: 'metered',
    since: since ? new Date(since).toISOString() : null,
    lastPoll, lastError,
    today: shape(sum(dayOf(Date.now()))),
    last7d: shape(sum(daysAgo(6))),
    monthToDate: shape(sum(monthStart())),
    running,
    pricing: AWS_PRICING_VERIFIED_ON,
    notCounted: 'data transfer, public IPv4, EBS IOPS above baseline, S3, and anything before `since`',
  };
}

// --- The real bill, once the account allows it ------------------------------------
// Cost Explorer charges $0.01 per request, so one answer serves everyone for 6 h.
const BILLED_TTL_MS = 6 * 3600 * 1000;
let billedCache = null;
export async function billed() {
  if (billedCache && Date.now() - billedCache.at < BILLED_TTL_MS) return billedCache.value;
  let value;
  try {
    const ce = new CostExplorerClient({ region: 'us-east-1' });
    const end = dayOf(Date.now() + 86400000);
    const r = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: monthStart(), End: end }, Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'], GroupBy: [{ Type: 'TAG', Key: 'project' }],
    }));
    const byProject = {};
    for (const t of r.ResultsByTime || []) for (const g of t.Groups || []) {
      const k = g.Keys[0].replace(/^project\$/, '') || '(untagged)';
      byProject[k] = Math.round(Number(g.Metrics.UnblendedCost.Amount) * 100) / 100;
    }
    value = { ok: true, source: 'cost-explorer', monthToDate: byProject, note: 'lags about a day; tag grouping counts only from when `project` was activated as a cost allocation tag' };
  } catch (e) {
    value = {
      ok: false,
      reason: e.name === 'AccessDeniedException'
        ? "the bill is not readable yet: Maestro's AWS key needs ce:GetCostAndUsage"
        : `Cost Explorer: ${e.name || e.message}`,
    };
  }
  billedCache = { at: Date.now(), value };
  return value;
}

/**
 * The AWS `project` tag an agent's spend is filed under: config.awsProject, else
 * its tmux session or its Maestro project's name, matched against tags actually
 * seen with punctuation and case ignored ("emsim" finds "em-sim"). null if none.
 */
export function awsProjectFor(agent) {
  const cfg = agent.config || {};
  if (cfg.awsProject) return cfg.awsProject;
  ensureTables();
  const tags = getDb().prepare('SELECT DISTINCT project FROM aws_meter WHERE project IS NOT NULL').all().map((r) => r.project);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const project = agent.project_id ? getProject(agent.project_id) : null;
  for (const cand of [agent.screen_session, agent.name, project && project.name]) {
    const hit = tags.find((t) => norm(t) === norm(cand));
    if (hit) return hit;
  }
  return null;
}

export const _internals = { poll, charge, transitionTime, onDemandHourly };
