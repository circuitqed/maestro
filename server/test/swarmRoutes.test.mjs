/**
 * The BROWSER-facing router, against a throwaway database and a real listener.
 *
 * swarm.test.mjs proves the gates refuse correctly and swarmApi.test.mjs proves the
 * agent cannot talk its way past them. This one covers the other direction: the
 * router a human drives may approve spend, so what matters is that it can only ever
 * narrow a request, that grants (the authorization boundary) are admin-only, and that
 * the numbers it hands the UI are the ones the UI claims to be showing -- separate
 * spent and reserved, worker counts that are not double-counted, and a `stalled`
 * verdict that matches what the runner would reap.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmroutes-'));
process.env.MAESTRO_DB_PATH = path.join(tmp, 'maestro.db');

const dbMod = await import('../services/db.js');
await dbMod.initDb();
dbMod.getDb().exec(`
  INSERT INTO agents (id,name,screen_session) VALUES (1,'lead','lead');
`);

const S = await import('../services/swarm.js');
S.initSwarmTables();
// Production inits both: swarm.js owns the money tables, swarmRunner the work
// queue. Without the second, anything that touches items 500s in here only.
(await import('../services/swarmRunner.js')).initSwarmItems();
dbMod.setSetting('swarm_enabled', '1');
S.grantSwarm(1, { maxWorkers: 6, maxSpendUsd: 4.0, accountDir: '/home/dave/.claude-accts/stanford-api' });

const router = (await import('../routes/swarms.js')).default;

// Role is swapped per request by the tests; requireAuth itself is covered elsewhere.
let role = 'admin';
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 1, username: 'dave', role }; next(); });
app.use('/api/swarms', router);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

const call = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
};

const mkSwarm = (name, over = {}) => {
  const s = S.createSwarm({
    name, spawnerAgentId: 1, items: ['a', 'b', 'c', 'd'],
    maxWorkers: 4, maxSpendUsd: 3, perWorkerUsd: 0.4, itemsPerWorker: 1, ...over,
  });
  return s;
};

console.log('\n-- reading');

const a = mkSwarm('alpha');
let r = await call('GET', '/api/swarms');
ok(r.status === 200 && r.body.swarms.length === 1, 'GET / lists swarms');
ok(r.body.global && r.body.global.enabled === true, 'GET / carries the global ledger');
const view = r.body.swarms[0];
ok(view.ledger.spent === 0 && view.ledger.reserved === 0 && view.ledger.cap === 3,
   'spent, reserved and cap are three separate numbers');
ok(view.estimate.floorUsd === 0.3 && view.estimate.ceilingUsd === 1.6,
   'the estimate carries floor and ceiling separately', JSON.stringify(view.estimate));
ok(view.grant && view.grant.maxWorkers === 6, 'the grant rides along for the approval card');
ok(view.spawner.name === 'lead', 'the spawner is named, not just its id');

console.log('\n-- approving, and only ever downwards');

r = await call('POST', `/api/swarms/${a.id}/approve`, { maxWorkers: 99 });
ok(r.status === 200 && r.body.state === 'running', 'approve starts the swarm');
ok(S.getSwarm(a.id).max_workers === 4,
   'a LARGER maxWorkers is ignored: approval cannot widen past the grant clamp');

const b = mkSwarm('beta');
r = await call('POST', `/api/swarms/${b.id}/approve`, { maxWorkers: 2 });
ok(S.getSwarm(b.id).max_workers === 2, 'a smaller maxWorkers narrows the swarm');
ok(S.getSwarm(b.id).max_concurrent <= 2,
   'concurrency follows it down, so the swarm cannot advertise parallelism it lacks');

r = await call('POST', `/api/swarms/${b.id}/approve`, {});
ok(r.status === 409 && r.body.code === 'STATE', 'approving twice is a 409, not a silent no-op');

console.log('\n-- counts, money and the stalled verdict');

const w0 = S.admitWorker(a.id, { idx: 0, sessionName: 'swarm-aaaaaaaa-0' });
const w1 = S.admitWorker(a.id, { idx: 1, sessionName: 'swarm-aaaaaaaa-1' });
const w2 = S.admitWorker(a.id, { idx: 2, sessionName: 'swarm-aaaaaaaa-2' });
S.finishWorker(w0.id, { state: 'done', result: 'x'.repeat(5000), costUsd: 0.2 });
S.finishWorker(w1.id, { state: 'over_budget', costUsd: 0.4, errorSignature: 'budget_exhausted' });
S.setWorkerState(w2.id, 'running');
dbMod.getDb().prepare("UPDATE swarm_workers SET deadline_at = datetime('now','-60 seconds') WHERE id = ?").run(w2.id);

r = await call('GET', `/api/swarms/${a.id}`);
const d = r.body;
ok(d.counts.done === 1 && d.counts.failures === 1 && d.counts.live === 1,
   'roll-ups count each worker exactly once', JSON.stringify(d.counts));
ok(d.counts.byState.done === 1 && d.counts.byState.over_budget === 1,
   'per-state detail lives under byState, where it cannot collide with the roll-ups');
ok(d.ledger.spent === 0.6 && d.ledger.reserved === 0.4,
   'spent is reported, in-flight work is reserved at its full ceiling', JSON.stringify(d.ledger));

const stalled = d.workers.find((w) => w.id === w2.id);
ok(stalled.attention === 'stalled' && stalled.state === 'running',
   'a running worker past its deadline is flagged stalled WITHOUT lying about its state');
ok(stalled.remainingS < 0, 'its countdown goes negative rather than stopping at zero');
ok(d.workers.find((w) => w.id === w1.id).attention === 'over_budget',
   'a budget stop is its own attention reason, not "failed"');
ok(d.workers.find((w) => w.id === w0.id).attention === null, 'a finished worker needs nobody');

const done = d.workers.find((w) => w.id === w0.id);
ok(done.resultChars === 5000 && done.result.length === 1200 && done.resultTruncated === true,
   'results are truncated for the poll, and say so', `${done.result.length}`);

// The creation event carries the whole batch; a 2s poll must not drag it along.
S.logSwarmEvent(a.id, 'items', JSON.stringify(Array.from({ length: 400 }, () => 'x'.repeat(200))));
r = await call('GET', `/api/swarms/${a.id}`);
ok(!r.body.events.some((e) => e.kind === 'items'), 'the items event is kept out of the event tail');
ok(r.body.events.every((e) => !e.note || e.note.length <= 300), 'event notes are clipped');

console.log('\n-- brakes a human can reach');

r = await call('POST', `/api/swarms/${a.id}/concurrency`, { n: 99 });
ok(r.status === 200 && S.getSwarm(a.id).max_concurrent === 4,
   'concurrency clamps to the worker count instead of erroring at the top of the range');
r = await call('POST', `/api/swarms/${a.id}/concurrency`, { n: 0 });
ok(r.status === 400, 'zero concurrency is refused — that is what pause is for');

r = await call('POST', `/api/swarms/${a.id}/pause`, { paused: true });
ok(r.body.paused === true, 'pause is reflected back immediately');

r = await call('POST', `/api/swarms/${a.id}/cancel`);
ok(r.body.state === 'cancelled' && /cancelled by dave/.test(r.body.haltReason),
   'cancel records WHO, and narrows halted to cancelled');
// Changed deliberately. Cancel used to halt admissions and leave live workers
// running -- the response said "1 worker(s) still finishing" while that worker
// kept billing. A person pressing cancel is trying to stop spending, so cancel
// now kills what is live and frees its slot and reservation.
ok(S.getWorker(w2.id).state === 'cancelled',
   'cancelling kills live workers rather than leaving them billing');
ok(r.body.note.includes('killed'), 'the answer says how many were killed', r.body.note);

r = await call('POST', `/api/swarms/${a.id}/cancel`);
ok(r.status === 200 && r.body.alreadyFinished === true, 'cancelling twice is idempotent');
r = await call('POST', `/api/swarms/${a.id}/pause`, { paused: true });
ok(r.status === 409, 'a finished swarm cannot be paused');

const pending = mkSwarm('denied');
r = await call('POST', `/api/swarms/${pending.id}/cancel`);
ok(r.body.state === 'cancelled' && /denied by dave/.test(r.body.haltReason),
   'denying a pending swarm reads as denied, not as a brake that tripped');

r = await call('GET', '/api/swarms/nope');
ok(r.status === 404 && r.body.code === 'NO_SWARM', 'an unknown swarm is a 404');

console.log('\n-- grants are the authorization boundary');

role = 'user';
r = await call('POST', '/api/swarms/grants', { agentId: 1, maxWorkers: 99, maxSpendUsd: 999, accountDir: '/tmp/x' });
ok(r.status === 403, 'a non-admin cannot widen a grant');
r = await call('DELETE', '/api/swarms/grants/1');
ok(r.status === 403, 'a non-admin cannot revoke one either');
r = await call('GET', '/api/swarms/grants');
ok(r.status === 403, 'nor list them');
ok(S.getGrant(1).max_workers === 6, 'the grant is untouched by all of that');

r = await call('GET', `/api/swarms/${b.id}`);
ok(r.body.grant && r.body.grant.accountDir === undefined,
   'a non-admin sees the grant LIMITS but not the account path');

role = 'admin';
r = await call('GET', '/api/swarms/grants');
ok(r.status === 200 && r.body.length === 1 && r.body[0].agent.name === 'lead',
   'GET /grants resolves ahead of GET /:id and names the agent');
r = await call('POST', '/api/swarms/grants', { agentId: 1, maxWorkers: 3, maxSpendUsd: 2, accountDir: 'relative' });
ok(r.status === 400 && r.body.code === 'BAD_ACCOUNT', 'a relative account dir is refused');
r = await call('POST', '/api/swarms/grants', { agentId: 99, maxWorkers: 3, maxSpendUsd: 2, accountDir: '/tmp/x' });
ok(r.status === 404 && r.body.code === 'NO_AGENT', 'granting to an unknown agent is a 404');
r = await call('POST', '/api/swarms/grants', { maxWorkers: 3, maxSpendUsd: 2, accountDir: '/tmp/x' });
ok(r.status === 404 && r.body.code === 'NO_AGENT',
   'a missing agentId answers "unknown agent", not a 500 about parameter binding');
r = await call('POST', '/api/swarms/grants', { agentId: 1, maxWorkers: 3, maxSpendUsd: 2, accountDir: '/tmp/acct' });
ok(r.status === 200 && S.getGrant(1).max_workers === 3, 'an admin can rewrite a grant');
r = await call('DELETE', '/api/swarms/grants/1');
ok(r.status === 200 && S.getGrant(1) === null, 'and revoke it');

r = await call('GET', `/api/swarms/${b.id}`);
ok(r.body.grant === null, 'a swarm whose grant was revoked says so rather than inventing limits');

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
