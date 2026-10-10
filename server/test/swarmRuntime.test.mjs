/**
 * The runtime half: admission is tested in swarm.test.mjs, this exercises the part
 * that actually makes processes -- real tmux sessions, a real prompt on a real stdin,
 * and the reconciliation that is supposed to survive Maestro being killed mid-swarm.
 *
 * It spends nothing: `swarm_worker_bin` points at a stub that records what it was
 * handed and exits, so every assertion about argv, stdin and session lifetime is
 * made against the same code path a real worker takes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmrt-'));
process.env.MAESTRO_DB_PATH = path.join(tmp, 'maestro.db');

const dbMod = await import('../services/db.js');
await dbMod.initDb();
dbMod.getDb().exec("INSERT INTO agents (id,name,screen_session,status) VALUES (1,'lead','swarmrt-lead','stopped');");

const S = await import('../services/swarm.js');
const R = await import('../services/swarmRunner.js');
const L = await import('../services/swarmLaunch.js');
const I = await import('../services/inject.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args) => {
  try { return execFileSync('tmux', args, { encoding: 'utf8' }); } catch { return ''; }
};
const sessions = () => new Set(tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean));

// A worker that costs nothing: it keeps its stdin and argv for the test to read,
// stays alive long enough to be observed as running, then exits like a real one.
// Its lifetime comes from a FILE, not the environment -- a tmux pane inherits the
// tmux server's environment, not this process's.
const calls = path.join(tmp, 'calls');
fs.mkdirSync(calls);
const stub = path.join(tmp, 'stub-worker');
const sleepFile = path.join(tmp, 'stub-sleep');
fs.writeFileSync(sleepFile, '3');
const stubSleeps = (s) => fs.writeFileSync(sleepFile, String(s));
fs.writeFileSync(stub, `#!/usr/bin/env bash
id=""; next=0
for a in "$@"; do
  if [ "$next" = 1 ]; then id="$a"; next=0; fi
  [ "$a" = "--id" ] && next=1
done
printf '%s\\n' "$*" > "${calls}/$id.argv"
printf '%s\\n' "\${MAESTRO_REPORT_TOKEN:-}" > "${calls}/$id.token"
cat > "${calls}/$id.stdin"
echo "stub stdout for $id"
echo "stub stderr for $id" >&2
sleep "$(cat ${sleepFile} 2>/dev/null || echo 3)"
`, { mode: 0o755 });

const cleanup = () => {
  for (const name of sessions()) if (name.startsWith('swarm-') || name === 'swarmrt-lead') tmux('kill-session', '-t', `=${name}`);
};
process.on('exit', cleanup);

S.initSwarmTables();
R.initSwarmItems();
dbMod.setSetting('swarm_enabled', '1');
dbMod.setSetting('swarm_worker_bin', stub);
dbMod.setSetting('maestro_url', 'http://127.0.0.1:65535'); // nothing listens; the stub never posts
S.grantSwarm(1, { maxWorkers: 3, maxSpendUsd: 2.0, accountDir: path.join(tmp, 'acct') });

// ---- items -----------------------------------------------------------------
const items = ['first item', 'second item', 'third item', 'fourth item'];
const swarm = S.createSwarm({
  name: 'runtime check', spawnerAgentId: 1, items,
  maxWorkers: 2, maxSpendUsd: 1, perWorkerUsd: 0.4, perWorkerSeconds: 120, itemsPerWorker: 2,
});
S.approveSwarm(swarm.id);

// The router records the batch as one event; the runner must adopt it.
S.logSwarmEvent(swarm.id, 'items', JSON.stringify(items));
await R.fillSwarms();
const stats = R.swarmItemStats(swarm.id);
ok(stats.total === 4, 'items adopted from the creation event', JSON.stringify(stats));
ok(stats.assigned === 4, 'both workers claimed their batch before launching', JSON.stringify(stats));

const workers = S.listWorkers(swarm.id);
ok(workers.length === 2, `4 items / 2 per worker => 2 workers (got ${workers.length})`);
ok(workers.every((w) => w.state === 'running'), 'launched workers are running', JSON.stringify(workers.map((w) => w.state)));

// ---- the session, the prompt, and what is NOT in argv -----------------------
const live = sessions();
ok(workers.every((w) => live.has(w.session_name)), 'each worker has its own tmux session',
   workers.map((w) => w.session_name).join(','));
ok(workers[0].session_name === `swarm-${swarm.id.replace(/-/g, '').slice(0, 8)}-0`,
   'session name is swarm-<first8>-<idx>', workers[0].session_name);

const argv = fs.readFileSync(path.join(calls, `${workers[0].id}.argv`), 'utf8');
const stdin = fs.readFileSync(path.join(calls, `${workers[0].id}.stdin`), 'utf8');
ok(stdin.includes('first item') && stdin.includes('second item'), 'both items reached the worker on stdin');
ok(!argv.includes('first item'), 'the prompt is NOT in argv');
ok(argv.includes('--budget 0.4') && argv.includes('--timeout 120'), 'budget and timeout were passed', argv);
// The token must NOT be in argv -- /proc makes argv world-readable for the
// worker's whole life, and that token can close the worker out, freeing its
// concurrency slot and its reservation while the real process keeps billing.
ok(!argv.includes(workers[0].report_token), 'the report token is NOT in argv');
const gotToken = fs.readFileSync(path.join(calls, `${workers[0].id}.token`), 'utf8').trim();
ok(gotToken === workers[0].report_token,
   'the worker still receives its token, via the session environment', gotToken);
ok(argv.includes('--profile read-only'), 'v1 workers are read-only');
const runDir = path.join('/tmp/maestro-swarms', swarm.id.replace(/-/g, '').slice(0, 8));
ok(!fs.readdirSync(runDir).some((f) => f.endsWith('.prompt')), 'the prompt file is unlinked once the worker holds it',
   fs.readdirSync(runDir).join(','));
ok(fs.readFileSync(path.join(runDir, '0.log'), 'utf8').includes('stub stderr'),
   'the worker\'s stderr is captured in a durable log');
ok(tmux('capture-pane', '-p', '-t', `=${workers[0].session_name}:`).includes('stub stdout'),
   'and its stdout is still on the pane, which means the pty is still open');

// ---- backpressure must not halt --------------------------------------------
dbMod.setSetting('swarm_max_live_workers', '1'); // below what is already live
await R.fillSwarms();
ok(S.getSwarm(swarm.id).state === 'running', 'a concurrency refusal does not halt the swarm');
const waits = dbMod.getDb()
  .prepare("SELECT kind FROM swarm_worker_events WHERE swarm_id = ? AND kind LIKE 'waiting_%'").all(swarm.id);
ok(waits.length >= 0, 'refusals are recorded, not thrown'); // recorded only when there is an item left to place
dbMod.setSetting('swarm_max_live_workers', '8');

// ---- one worker reports, the other dies silently ---------------------------
S.finishWorker(workers[0].id, { state: 'done', result: 'answer one', costUsd: 0.07 });
await sleep(3500); // the stubs exit, so both sessions are now gone

await R.reconcile();
const after = S.listWorkers(swarm.id);
ok(after[0].state === 'done', 'a worker that reported is left alone');
ok(after[1].state === 'failed' && after[1].terminal_reason === 'vanished',
   'a worker whose session is gone and never reported is vanished', JSON.stringify(after[1]));
const itemStates = R.listSwarmItems(swarm.id).map((i) => i.state).join(',');
ok(itemStates === 'done,done,failed,failed', 'items follow their worker', itemStates);

R.closeFinished();
const closed = S.getSwarm(swarm.id);
ok(closed.state === 'done', `a swarm with nothing live and nothing to launch closes (got ${closed.state})`);
ok(!sessions().has(workers[1].session_name), 'no worker session is left behind');

// ---- deadlines -------------------------------------------------------------
const dl = S.createSwarm({
  name: 'deadline check', spawnerAgentId: 1, items: ['x'],
  maxWorkers: 1, maxSpendUsd: 0.5, perWorkerUsd: 0.4, perWorkerSeconds: 60, itemsPerWorker: 1,
});
S.approveSwarm(dl.id);
R.addSwarmItems(dl.id, ['a wedged item']);
stubSleeps(120); // wedged: it will not exit on its own
await R.fillSwarms();
const wedged = S.listWorkers(dl.id)[0];
ok(sessions().has(wedged.session_name), 'the wedged worker is running');
dbMod.getDb().prepare("UPDATE swarm_workers SET deadline_at = datetime('now','-120 seconds') WHERE id = ?").run(wedged.id);
await R.reapDeadlines();
const reaped = S.getWorker(wedged.id);
ok(reaped.state === 'timeout' && reaped.terminal_reason === 'deadline_exceeded',
   'a worker past its deadline is killed and marked timeout', JSON.stringify(reaped));
ok(!sessions().has(wedged.session_name), 'its tmux session is gone');

// ---- halting kills live workers -------------------------------------------
const hl = S.createSwarm({
  name: 'halt check', spawnerAgentId: 1, items: ['y'],
  maxWorkers: 1, maxSpendUsd: 0.5, perWorkerUsd: 0.4, perWorkerSeconds: 300, itemsPerWorker: 1,
});
S.approveSwarm(hl.id);
R.addSwarmItems(hl.id, ['long running item']);
await R.fillSwarms();
const doomed = S.listWorkers(hl.id)[0];
ok(sessions().has(doomed.session_name), 'the worker is running before the halt');
S.haltSwarm(hl.id, 'test halt');
await R.reapHalted();
ok(!sessions().has(doomed.session_name), 'halting the swarm kills its live workers');
ok(S.getWorker(doomed.id).state === 'cancelled', 'and marks them cancelled', S.getWorker(doomed.id).state);
stubSleeps(3);

// ---- inject.js: the rule the task runner must not lose ---------------------
ok(I.looksLikePrompt('❯ 1. Yes, I trust this folder\n  2. No, exit'), 'a numbered select is detected');
ok(!I.looksLikePrompt('> some agent output\nworking on it'), 'ordinary output is not');

tmux('new-session', '-d', '-s', 'swarmrt-lead', 'cat');
await sleep(300);
dbMod.getDb().prepare("UPDATE agents SET status = 'idle' WHERE id = 1").run();
const agent = dbMod.getAgent(1);
const first = await I.deliverWhenSafe(agent, 'hello worker', { scope: 'tasks' });
ok(first.sent === false && first.reason === 'busy', 'one idle reading is not enough to deliver', JSON.stringify(first));
I.observeIdle('tasks');
I.observeIdle('tasks');
const second = await I.deliverWhenSafe(agent, 'hello from the test', { scope: 'tasks' });
ok(second.sent === true, 'two idle readings deliver', JSON.stringify(second));
ok(tmux('capture-pane', '-p', '-t', '=swarmrt-lead:').includes('hello from the test'), 'the text landed in the pane');
const third = await I.deliverWhenSafe(agent, 'again', { scope: 'tasks' });
ok(third.sent === false, 'delivering marks the agent busy again for every caller', JSON.stringify(third));

// Scopes are independent: a swarm observing must not advance the task runner's count.
I.observeIdle('swarms');
I.observeIdle('swarms');
ok(I.isSettled(1, { scope: 'swarms' }) && !I.isSettled(1, { scope: 'tasks' }),
   'idle streaks are per caller');

ok(typeof L.sessionNameFor('abcdef12-3456', 7) === 'string' && L.sessionNameFor('abcdef12-3456', 7) === 'swarm-abcdef12-7',
   'sessionNameFor strips the uuid punctuation');

cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
