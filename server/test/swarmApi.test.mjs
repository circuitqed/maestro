/**
 * The agent-facing and worker-facing HTTP surfaces, against a throwaway database
 * and a real listener. swarm.test.mjs proves the gates refuse correctly; this
 * proves the routers don't quietly undo that -- that identity comes from the
 * session and not the body, that a swarm can only be read by the agent that owns
 * it, that a worker token closes exactly one row exactly once, and that a dead
 * gateway stops everything.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmapi-'));
process.env.MAESTRO_DB_PATH = path.join(tmp, 'maestro.db');

const dbMod = await import('../services/db.js');
await dbMod.initDb();
dbMod.getDb().exec(`
  INSERT INTO agents (id,name,screen_session) VALUES (1,'lead','lead'),(2,'other','other');
`);
dbMod.setSetting('agent_api_token', 'test-token');

const S = await import('../services/swarm.js');
S.initSwarmTables();
dbMod.setSetting('swarm_enabled', '1');
S.grantSwarm(1, { maxWorkers: 4, maxSpendUsd: 2.0, accountDir: '/home/dave/.claude-accts/stanford-api' });

const swarmApi = (await import('../routes/swarmApi.js')).default;
const swarmReport = (await import('../routes/swarmReport.js')).default;

const app = express();
app.use(express.json());
app.use('/api/agent', swarmApi);
app.use('/api/swarm-report', swarmReport);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

async function call(method, url, { session = 'lead', token = 'test-token', body, workerToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers['X-Maestro-Agent-Token'] = token;
  if (session !== null) headers['X-Maestro-Session'] = session;
  if (workerToken) headers['X-Maestro-Worker-Token'] = workerToken;
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- identity is not optional ----------------------------------------------
ok((await call('GET', '/api/agent/swarms', { token: 'wrong' })).status === 401, 'bad agent token => 401');
ok((await call('GET', '/api/agent/swarms', { session: null })).status === 400, 'missing session => 400');
ok((await call('GET', '/api/agent/swarms', { session: 'ghost' })).status === 404, 'unknown session => 404');

// ---- creation: bad batches ---------------------------------------------------
let r = await call('POST', '/api/agent/swarms', { body: { name: 'x', items: [] } });
ok(r.status === 400 && r.body.code === 'EMPTY', 'no items => 400 EMPTY', JSON.stringify(r.body));
r = await call('POST', '/api/agent/swarms', { body: { name: 'x', items: 'one two' } });
ok(r.status === 400 && r.body.code === 'BAD_ITEMS', 'items must be an array', JSON.stringify(r.body));
r = await call('POST', '/api/agent/swarms', { body: { name: 'x', items: ['a'], hostId: 3 } });
ok(r.status === 400 && r.body.code === 'BAD_HOST', 'remote swarms are refused, not downgraded');

// ---- creation: clamped, estimated, pending ----------------------------------
r = await call('POST', '/api/agent/swarms', {
  body: { name: 'audit', items: new Array(40).fill(0).map((_, i) => `item ${i}`), maxWorkers: 40, maxSpendUsd: 999, itemsPerWorker: 2 },
});
const A = r.body;
ok(r.status === 200 && A.state === 'pending_approval', 'create lands in pending_approval', JSON.stringify(r.body));
ok(A.maxWorkers === 4 && A.maxSpendUsd === 2.0, 'clamped to the grant', `${A.maxWorkers}/${A.maxSpendUsd}`);
ok(A.clamped.length === 2, 'the clamps are reported back, not silent', JSON.stringify(A.clamped));
ok(A.estimate.floorUsd === 0.30 && A.estimate.ceilingUsd === 1.60,
   'estimate: 4 workers = $0.30 floor / $1.60 ceiling', JSON.stringify(A.estimate));
ok(A.approvalRequired === true, 'the response says a human must approve');
// 4 workers x 2 items cannot touch 40 items, and a lead that is not told so will
// collate 8 answers as if they were the whole batch.
ok(A.coverage.capacity === 8 && A.warnings.some((w) => w.startsWith('coverage:')),
   'short coverage is called out, not left for the lead to notice', JSON.stringify(A.warnings));

// The items themselves have to survive until the runner needs them, after approval.
const itemsEvent = dbMod.getDb()
  .prepare("SELECT note FROM swarm_worker_events WHERE swarm_id = ? AND kind = 'items'").get(A.id);
ok(itemsEvent && JSON.parse(itemsEvent.note).length === 40, 'the 40 items are persisted for the runner');

// ---- ownership ---------------------------------------------------------------
r = await call('GET', `/api/agent/swarms/${A.id}`, { session: 'other' });
ok(r.status === 403 && r.body.code === 'NOT_YOURS', 'another agent cannot read the swarm');
r = await call('POST', `/api/agent/swarms/${A.id}/cancel`, { session: 'other', body: {} });
ok(r.status === 403, 'another agent cannot cancel it either');
ok((await call('GET', '/api/agent/swarms', { session: 'other' })).body.length === 0, 'list is scoped to the caller');
ok((await call('GET', '/api/agent/swarms')).body.length === 1, 'the spawner sees its own swarm');
ok((await call('GET', '/api/agent/swarms/nope')).status === 404, 'unknown swarm => 404');

// ---- worker reports ----------------------------------------------------------
S.approveSwarm(A.id);
const w1 = S.admitWorker(A.id, { idx: 0, prompt: 'item 0' });

r = await call('POST', '/api/swarm-report', { workerToken: 'nope', body: { state: 'done' } });
ok(r.status === 401, 'an unknown worker token reports nothing');
r = await call('POST', '/api/swarm-report', { workerToken: w1.report_token, body: { worker_id: 'someone-else', state: 'done' } });
ok(r.status === 400 && r.body.code === 'WORKER_MISMATCH', 'the token wins over the body id');

r = await call('POST', '/api/swarm-report', {
  workerToken: w1.report_token,
  body: { worker_id: w1.id, state: 'done', result: 'found three', cost_usd: 0.07, elapsed_s: 31, exit_code: 0, tokens: { cache_read_input_tokens: 21311 } },
});
ok(r.status === 200 && S.getWorker(w1.id).state === 'done' && S.getWorker(w1.id).cost_usd === 0.07,
   'a valid report closes the worker', JSON.stringify(r.body));
r = await call('POST', '/api/swarm-report', { workerToken: w1.report_token, body: { state: 'done', cost_usd: 0.001 } });
ok(r.status === 409 && r.body.code === 'ALREADY_REPORTED', 'the token is spent: a replay cannot rewrite the cost');

// A worker that reports nonsense is still closed out: a live row holds a budget
// reservation and a concurrency slot forever.
const w2 = S.admitWorker(A.id, { idx: 1 });
r = await call('POST', '/api/swarm-report', { workerToken: w2.report_token, body: { state: 'confused' } });
ok(r.status === 200 && S.getWorker(w2.id).state === 'failed'
   && S.getWorker(w2.id).terminal_reason === 'bad_report:confused',
   'an unparseable state becomes failed, not a leaked slot', S.getWorker(w2.id).terminal_reason);

// ---- results -----------------------------------------------------------------
r = await call('GET', `/api/agent/swarms/${A.id}/results`);
ok(r.body.counts.done === 1 && r.body.counts.failed === 1, 'results count both outcomes', JSON.stringify(r.body.counts));
ok(r.body.results.find((x) => x.idx === 0).result === 'found three', 'the result text comes back for collation');
ok(r.body.complete === false, 'a running swarm is never reported complete');

// ---- cancel ------------------------------------------------------------------
const B = (await call('POST', '/api/agent/swarms', { body: { name: 'second', items: ['a', 'b'] } })).body;
S.approveSwarm(B.id);
r = await call('POST', `/api/agent/swarms/${B.id}/cancel`, { body: {} });
ok(r.status === 200 && r.body.state === 'cancelled', 'cancel reaches the cancelled state, not halted', JSON.stringify(r.body));
ok(S.getSwarm(B.id).halt_reason.includes('lead'), 'who cancelled it is recorded');
r = await call('POST', `/api/agent/swarms/${B.id}/cancel`, { body: {} });
ok(r.body.alreadyFinished === true, 'cancelling twice is not an error');

// ---- the dead gateway stops the world ---------------------------------------
const w3 = S.admitWorker(A.id, { idx: 2 });
r = await call('POST', '/api/swarm-report', {
  workerToken: w3.report_token,
  body: { state: 'failed', terminal_reason: 'gateway_budget_exceeded', error: 'Budget has been exceeded' },
});
ok(r.status === 200 && r.body.killSwitch === true, 'a gateway-budget report trips the kill switch');
ok(dbMod.getSetting('swarm_enabled') === '0', 'swarms are globally disabled afterwards');
ok(S.getSwarm(A.id).state === 'halted', 'the running swarm is halted');

r = await call('POST', '/api/agent/swarms', { body: { name: 'after', items: ['a'] } });
ok(r.status === 429 && r.body.code === 'DISABLED' && r.body.retryable === false,
   'DISABLED is a 429 that is NOT retryable: retrying it is pointless', JSON.stringify(r.body));

// Backpressure must look different: same 429, but retryable, because the day rolls
// over on its own. ($0.07 is already spent today, from w1's report above.)
dbMod.setSetting('swarm_enabled', '1');
dbMod.setSetting('swarm_daily_usd', '0.05');
r = await call('POST', '/api/agent/swarms', { body: { name: 'tomorrow', items: ['a'] } });
ok(r.status === 429 && r.body.code === 'DAILY_SPEND' && r.body.retryable === true,
   'a blown daily cap refuses creation as retryable backpressure', JSON.stringify(r.body));

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
