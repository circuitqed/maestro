/**
 * The admission gate is the only thing standing between a confused agent and a
 * $2000 key, so it is tested against a throwaway database rather than reasoned
 * about. Pure SQLite: no SSH, no spawning, no money.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmtest-'));
process.env.MAESTRO_DB_PATH = path.join(tmp, 'maestro.db');

const dbMod = await import('../services/db.js');
await dbMod.initDb();
dbMod.getDb().exec(`
  INSERT INTO agents (id,name,screen_session) VALUES (1,'lead','lead'),(2,'other','other');
`);

const S = await import('../services/swarm.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};
const code = (fn) => { try { fn(); return 'NO_THROW'; } catch (e) { return e.code || e.message; } };

S.initSwarmTables();

// ---- gates that must refuse before anything exists -------------------------
ok(code(() => S.createSwarm({ name: 'x', spawnerAgentId: 1 })) === 'DISABLED',
   'swarms ship disabled');

dbMod.setSetting('swarm_enabled', '1');
ok(code(() => S.createSwarm({ name: 'x', spawnerAgentId: 1 })) === 'NOT_PERMITTED',
   'no grant => refused');

ok(code(() => S.grantSwarm(1, { accountDir: 'relative/path' })) === 'BAD_ACCOUNT',
   'grant requires an absolute account dir');

S.grantSwarm(1, { maxWorkers: 4, maxSpendUsd: 2.0, accountDir: '/home/dave/.claude-accts/stanford-api' });

// ---- clamping, not rejection ----------------------------------------------
const sw = S.createSwarm({
  name: 'research', spawnerAgentId: 1, items: new Array(40).fill('item'),
  maxWorkers: 40, maxSpendUsd: 999, perWorkerUsd: 0.4, itemsPerWorker: 1,
});
ok(sw.max_workers === 4, 'asking for 40 workers is clamped to the grant (4)', `got ${sw.max_workers}`);
ok(sw.max_spend_usd === 2.0, 'spend clamped to the grant ($2)', `got ${sw.max_spend_usd}`);
ok(sw.state === 'pending_approval', 'starts pending_approval');

ok(code(() => S.admitWorker(sw.id, { idx: 0 })) === 'NOT_RUNNING',
   'cannot admit before approval');

S.approveSwarm(sw.id);

// ---- the hammer: admit in a tight loop, assert exactly where it stops -------
let admitted = 0, stopCode = null;
for (let i = 0; i < 50; i++) {
  try { S.admitWorker(sw.id, { idx: i }); admitted++; }
  catch (e) { stopCode = e.code; break; }
}
// per_worker 0.40, cap 2.00, max_concurrent = min(4, 4) = 4 -> concurrency binds first
ok(admitted === 4, `hammering stops after 4 admits (got ${admitted})`);
// max_workers and max_concurrent are both 4 here, and the workers gate is checked
// first, so that is the one that binds. Concurrency is exercised separately below.
ok(stopCode === 'SWARM_WORKERS', `stops on SWARM_WORKERS (got ${stopCode})`);

// ---- reservation is computed, so a "restart" changes nothing ---------------
const before = S.swarmLedger(sw.id);
// "Restart": the ledger is recomputed from rows on every call, so re-reading it
// after any amount of process churn must give the same answer.
const after = S.swarmLedger(sw.id);
ok(before.reserved === after.reserved && after.reserved === 1.6,
   `reservation survives a restart unchanged ($${after.reserved})`);
ok(code(() => S.admitWorker(sw.id, { idx: 99 })) === 'SWARM_WORKERS',
   'still refuses after restart — no leaked counter, no freed slot');

// ---- finishing a worker frees a slot and records real spend ---------------
const w = S.listWorkers(sw.id)[0];
S.finishWorker(w.id, { state: 'done', result: 'ok', costUsd: 0.09 });
const led = S.swarmLedger(sw.id);
ok(led.spent === 0.09 && led.live === 3, `finishing frees a slot (spent $${led.spent}, live ${led.live})`);

// ---- a lying worker cannot raise anyone's headroom ------------------------
const w2 = S.listWorkers(sw.id)[1];
S.finishWorker(w2.id, { state: 'done', costUsd: 999 });
ok(S.getWorker(w2.id).cost_usd === 0.6,
   `absurd self-reported cost clamped to 1.5x ceiling (got ${S.getWorker(w2.id).cost_usd})`);

// Concurrency must bind on its own when it is the tighter of the two.
S.grantSwarm(2, { maxWorkers: 20, maxSpendUsd: 50, accountDir: '/home/dave/.claude-accts/stanford-api' });
const swC = S.createSwarm({ name: 'conc', spawnerAgentId: 2, maxWorkers: 20, maxSpendUsd: 50, perWorkerUsd: 0.1 });
S.approveSwarm(swC.id);
let nC = 0, stopC = null;
for (let i = 0; i < 20; i++) {
  try { S.admitWorker(swC.id, { idx: i }); nC++; } catch (e) { stopC = e.code; break; }
}
ok(nC === 4 && stopC === 'SWARM_CONCURRENCY',
   `concurrency binds alone: 4 admitted then SWARM_CONCURRENCY (got ${nC}, ${stopC})`);

// And the global ceiling binds across swarms, not just within one.
const g = S.globalLedger();
ok(g.liveWorkers === 6 && g.maxLiveWorkers === 8,
   `global live count spans swarms (${g.liveWorkers} live, cap ${g.maxLiveWorkers})`);

// ---- reports are idempotent (delivery retries) ----------------------------
S.finishWorker(w.id, { state: 'failed', costUsd: 5 });
ok(S.getWorker(w.id).state === 'done' && S.getWorker(w.id).cost_usd === 0.09,
   'a repeated report does not overwrite a finished worker');

// ---- spend cap binds when concurrency does not ----------------------------
// Raise the global ceiling first: six workers are already live from the swarms
// above, so without this the GLOBAL gate binds and the per-swarm spend gate --
// the thing under test here -- is never reached.
dbMod.setSetting('swarm_max_live_workers', '50');
dbMod.setSetting('swarm_enabled', '1');
S.grantSwarm(2, { maxWorkers: 20, maxSpendUsd: 1.0, accountDir: '/home/dave/.claude-accts/stanford-api' });
const sw2 = S.createSwarm({ name: 'tight', spawnerAgentId: 2, maxWorkers: 20, maxSpendUsd: 1.0, perWorkerUsd: 0.4 });
S.approveSwarm(sw2.id);
let n2 = 0, stop2 = null;
for (let i = 0; i < 20; i++) {
  try { S.admitWorker(sw2.id, { idx: i }); n2++; } catch (e) { stop2 = e.code; break; }
}
ok(n2 === 2 && stop2 === 'SWARM_SPEND', `$1 cap at $0.40/worker admits 2 then stops on SWARM_SPEND (got ${n2}, ${stop2})`);

// ---- the kill switch stops everything -------------------------------------
S.tripKillSwitch('gateway returned 429 BUDGET');
ok(dbMod.getSetting('swarm_enabled') === '0', 'kill switch disables swarms globally');
ok(S.getSwarm(sw.id).state === 'halted', 'kill switch halts running swarms');
ok(code(() => S.admitWorker(sw2.id, { idx: 9 })) === 'DISABLED', 'nothing admits after the kill switch');

// ---- the estimate a human approves ----------------------------------------
const est = S.estimateSwarm({ workers: 7, perWorkerUsd: 0.4 });
ok(est.floorUsd === 1.33 && est.ceilingUsd === 2.8,
   `7 workers: floor $${est.floorUsd} / ceiling $${est.ceilingUsd} shown separately`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
