/**
 * Budget for a gateway (LiteLLM) account: the cap, what has been spent, and when
 * the cycle resets.
 *
 * This is the `/usage` equivalent for an account that has no subscription plan. The
 * Stanford gateway is LiteLLM, which reports a key's budget in RESPONSE HEADERS:
 *
 *   x-litellm-key-max-budget: 5000.0
 *   x-litellm-key-spend:      2604.364591400006
 *
 * Three awkward facts shape everything here:
 *
 * 1. THE PROBE COSTS MONEY. Those headers only appear on a billed inference call.
 *    /key/info would carry the same numbers plus `budget_reset_at`, but this key is
 *    restricted to `llm_api_routes` and is refused. The free routes that ARE allowed
 *    (/v1/models, /v1/messages/count_tokens) return 200 with no budget headers at
 *    all -- both checked. So: smallest possible request, and a cache TTL an order of
 *    magnitude longer than the free Claude probe's. One probe is ~$0.000025, so a
 *    five-minute TTL is about $0.22/month regardless of how many agents ask.
 *
 * 2. THE KEY CANNOT USE CHEAP MODELS. claude-haiku-* comes back 403
 *    `key_model_access_denied`, and a 403 carries no budget headers either. The
 *    allowed set is claude-opus-5-5, gpt-6-astra, gpt-6-sol, so the probe uses the
 *    same model the standalone cron watcher has used since the cap was first hit.
 *
 * 3. THE RESET DAY IS NOT EXPOSED. Nothing in the headers says when the cycle turns
 *    over, and the endpoint that would is barred. So it is LEARNED: every reading is
 *    compared with the last, and a spend that has gone DOWN can only mean the cycle
 *    reset in between. Until that has been seen once, this reports the reset as
 *    unknown rather than assuming the 1st of the month -- a guessed date would be
 *    indistinguishable from a known one at the point it matters.
 */
import { execOnHost } from './hosts.js';
import { getSetting, setSetting } from './db.js';

// Ten times the Claude probe's TTL, because this one is billed. Budget moves slowly
// at these amounts; freshness is worth far less than not paying per page view.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, value }

// A spend drop below this is treated as noise rather than a cycle reset. Spend only
// ever rises within a cycle, so any real decrease is a reset; the floor just avoids
// reacting to a float round-trip.
const RESET_EPSILON = 0.01;

const STATE_KEY = 'gateway_budget_state';

/**
 * Smallest useful request on an allowed model. max_tokens:1 and a two-character
 * prompt: the measured cost of exactly this call is $0.000025.
 */
const PROBE = `
import json, os, sys, urllib.request, urllib.error
cfg, base = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else "claude-opus-5-5"
try:
    d = json.load(open(os.path.join(cfg, "settings.json")))
    env = d.get("env") or {}
    tok = env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") \\
          or d.get("ANTHROPIC_AUTH_TOKEN") or d.get("ANTHROPIC_API_KEY")
except Exception as e:
    print(json.dumps({"ok": False, "reason": "cannot read settings.json: %s" % str(e)[:60]})); raise SystemExit
if not tok:
    print(json.dumps({"ok": False, "reason": "no API token in settings.json"})); raise SystemExit

# A short fingerprint of the key, so two config dirs holding the SAME key are
# recognised as one budget rather than two. Computed here and truncated: the token
# itself never leaves the host, and 12 hex chars cannot be walked back to it.
import hashlib
fp = hashlib.sha256(tok.encode()).hexdigest()[:12]

body = json.dumps({"model": model, "max_tokens": 1,
                   "messages": [{"role": "user", "content": "hi"}]}).encode()
req = urllib.request.Request(base.rstrip("/") + "/v1/messages", data=body,
                             headers={"authorization": "Bearer " + tok,
                                      "content-type": "application/json",
                                      "anthropic-version": "2023-06-01"})
# The headers we want ride on BOTH a 200 and a 429 -- and a 429 is free, which is how
# the cap stayed readable for the four days the key sat over budget.
try:
    r = urllib.request.urlopen(req, timeout=25)
    headers, status = r.headers, r.status
except urllib.error.HTTPError as e:
    headers, status = e.headers, e.code
except Exception as e:
    print(json.dumps({"ok": False, "reason": str(e)[:80]})); raise SystemExit

def num(name):
    v = headers.get(name)
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

cap, spend = num("x-litellm-key-max-budget"), num("x-litellm-key-spend")
if cap is None and spend is None:
    print(json.dumps({"ok": False, "reason": "gateway returned no budget headers (HTTP %s)" % status}))
else:
    print(json.dumps({"ok": True, "kind": "gateway", "cap": cap, "spend": spend,
                      "keyFingerprint": fp,
                      "status": status, "probeCostUsd": num("x-litellm-response-cost"),
                      "overBudget": status == 429}))
`;

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function readState() {
  try {
    const raw = getSetting(STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Fold a reading into the stored history and return what we know about the cycle.
 *
 * Spend rises monotonically inside a cycle, so a decrease is proof a reset happened
 * between the two readings. Once two resets have been seen the day-of-month is
 * known; after one, the day is known but not yet confirmed as recurring.
 */
function recordAndDescribe(key, cap, spend) {
  const state = readState();
  const prev = state[key];
  const now = new Date().toISOString();
  const resets = (prev && prev.resets) || [];

  if (prev && typeof prev.spend === 'number' && typeof spend === 'number'
      && spend < prev.spend - RESET_EPSILON) {
    // The turnover happened somewhere between the previous reading and this one.
    resets.push({ detectedAt: now, after: prev.at, droppedFrom: prev.spend, to: spend });
  }

  state[key] = { cap, spend, at: now, resets: resets.slice(-12) };
  try {
    setSetting(STATE_KEY, JSON.stringify(state));
  } catch {
    /* losing the history must not fail the reading */
  }

  const days = [...new Set(resets.map((r) => new Date(r.detectedAt).getUTCDate()))];
  return {
    resetsObserved: resets.length,
    lastResetAt: resets.length ? resets[resets.length - 1].detectedAt : null,
    // One consistent day across every observed reset is a real monthly cycle. Two
    // different days means it is not simply day-of-month, so claim nothing.
    resetDayOfMonth: resets.length && days.length === 1 ? days[0] : null,
    firstSeenAt: (prev && prev.firstSeenAt) || (prev && prev.at) || now,
  };
}

/**
 * @param {object|null} host   null => local
 * @param {string} configDir   the account's config dir on that host
 * @param {string} baseUrl     the gateway base URL
 * @returns {Promise<object>} never throws; `ok:false` with a reason instead
 */
export async function gatewayUsage(host, configDir, baseUrl, { force = false } = {}) {
  if (!configDir || !baseUrl) return { ok: false, reason: 'not a gateway account' };
  if (getSetting('usage_probe_disabled') === '1') {
    return { ok: false, reason: 'usage probing disabled' };
  }

  const key = `${host ? host.id : 'local'}:${configDir}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value;
  try {
    const { stdout } = await execOnHost(
      host,
      `python3 -c ${q(PROBE)} ${q(configDir)} ${q(baseUrl)}`,
      { timeout: 40000 }
    );
    value = JSON.parse(String(stdout).trim().split('\n').pop());
  } catch (err) {
    value = { ok: false, reason: String(err.message || err).slice(0, 90) };
  }

  if (value.ok) {
    const { cap, spend } = value;
    value.remaining = cap !== null && spend !== null ? Math.round((cap - spend) * 1e6) / 1e6 : null;
    value.utilization = cap ? Math.round((spend / cap) * 1000) / 10 : null;
    // History is keyed by the KEY, not the host that asked. The same key installed on
    // two hosts is one budget on one cycle; two histories would each have to rediscover
    // the same reset, and would disagree whenever one host had not been probed lately.
    const historyKey = value.keyFingerprint ? `api:${value.keyFingerprint}` : key;
    Object.assign(value, recordAndDescribe(historyKey, cap, spend));
  }
  value.checkedAt = new Date().toISOString();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Drop cached gateway readings, e.g. after a cap change. */
export function forgetGatewayUsage() {
  cache.clear();
}
