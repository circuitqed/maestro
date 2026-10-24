/**
 * Every plan in the fleet, and what is drawing on it.
 *
 * `/usage` inside one agent answers "how much of MY plan is left". This answers the
 * question that actually governs the fleet: there are several accounts across four
 * hosts, agents are pinned to them individually, and when work stalls it is usually
 * because one plan hit its five-hour window while another sat idle.
 *
 * The grouping key is the ACCOUNT IDENTITY (the login email), not the host or the
 * config dir, and that is the whole point. The same subscription is signed in on
 * oracle, the mac mini and garage-wsl; those are three config dirs sharing ONE
 * five-hour limit. Keyed by dir, one plan reads as three plans each with its own
 * headroom, which is exactly backwards from the truth -- the three draw each other
 * down. Accounts with no readable email fall back to host:dir, so an unidentified
 * login is listed separately rather than silently merged into another plan.
 *
 * Probes run concurrently and every failure is local: an unreachable host costs that
 * host's accounts their numbers and nothing else. A sleeping mac mini must not be
 * able to blank the view.
 */
import { getAgents, getHosts } from './db.js';
import { listAccounts } from './accounts.js';
import { usageForAccount } from './usage.js';

/** Normalise a config dir for comparison: agents store '' for the default account. */
const dirKey = (dir) => String(dir || '').replace(/\/+$/, '');

/**
 * What kind of account a config dir is, for explaining a failed probe.
 *
 * The Claude probe's own answer for a gateway account is "no subscription
 * credential", which reads as a broken login. It is not: an API or Bedrock account
 * is billed per token and has no plan window to report, so there is nothing wrong
 * and nothing to fix. Only consulted when a probe has already failed, so the common
 * path pays no extra host call.
 *
 * @returns {Promise<object|null>} the account row, or null if it cannot be found
 */
export async function accountKindFor(host, configDir = '') {
  try {
    const accounts = await listAccounts(host);
    const want = dirKey(configDir);
    return accounts.find((a) => (want ? dirKey(a.dir) === want : a.isDefault)) || null;
  } catch {
    return null;
  }
}

/** Does this agent's account match this (host, dir) pair? */
function agentUsesAccount(agent, host, account) {
  const agentHostId = agent.host_id || null;
  const accountHostId = host ? host.id : null;
  if (agentHostId !== accountHostId) return false;
  const agentDir = dirKey((agent.config || {}).claudeConfigDir);
  // An agent with no configDir uses the default account, whose dir ends in /.claude.
  if (!agentDir) return Boolean(account.isDefault);
  return agentDir === dirKey(account.dir);
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.includeAgents=true] attach the agents drawing on each plan
 * @returns {Promise<{plans: Array, hostsUnreachable: Array<string>, checkedAt: string}>}
 */
export async function planUsage({ includeAgents = true } = {}) {
  const hosts = getHosts();
  const agents = getAgents();

  // One listAccounts per host, concurrently. A host that cannot answer yields no
  // accounts and is named in `hostsUnreachable` instead of throwing.
  const perHost = await Promise.all(
    hosts.map(async (host) => {
      try {
        const accounts = await listAccounts(host.ssh_target ? host : null);
        return { host, accounts, ok: true };
      } catch {
        return { host, accounts: [], ok: false };
      }
    })
  );

  // Probe each signed-in account once. Only an OAuth subscription has plan windows:
  // Bedrock and gateway/API accounts are billed per token and have no /usage at all,
  // so they are listed with `kind` and no utilization rather than as a failure.
  const probes = [];
  for (const { host, accounts } of perHost) {
    for (const account of accounts) {
      const probeHost = host.ssh_target ? host : null;
      probes.push(
        (async () => {
          const usage =
            account.kind === 'oauth' && account.loggedIn
              ? await usageForAccount(probeHost, account.isDefault ? '' : account.dir, 'claude')
              : { ok: false, reason: account.kind === 'oauth' ? 'not signed in' : `${account.kind} account — billed per token, no plan window` };
          return { host, account, usage };
        })()
      );
    }
  }
  const probed = await Promise.all(probes);

  // Fold (host, account) rows into one row per identity.
  const byIdentity = new Map();
  for (const { host, account, usage } of probed) {
    const identity = account.email || `${host.name}:${dirKey(account.dir)}`;
    let plan = byIdentity.get(identity);
    if (!plan) {
      plan = {
        identity,
        email: account.email || null,
        kind: account.kind,
        label: account.label,
        detail: account.detail || null,
        signedInOn: [],
        fiveHour: null,
        sevenDay: null,
        extraEnabled: false,
        ok: false,
        reason: null,
        checkedAt: null,
        agents: [],
      };
      byIdentity.set(identity, plan);
    }
    plan.signedInOn.push({ host: host.name, dir: account.dir, loggedIn: account.loggedIn });

    // Several hosts report the same plan. Keep the FRESHEST reading, and record when
    // they disagree -- a stale probe on one host would otherwise quietly win and
    // understate a plan that is actually close to its limit.
    if (usage && usage.ok) {
      const fresher = !plan.checkedAt || String(usage.checkedAt) > String(plan.checkedAt);
      if (plan.ok && plan.fiveHour && usage.fiveHour
          && plan.fiveHour.utilization !== usage.fiveHour.utilization) {
        plan.disagreement = true;
      }
      if (fresher || !plan.ok) {
        plan.ok = true;
        plan.fiveHour = usage.fiveHour || null;
        plan.sevenDay = usage.sevenDay || null;
        plan.extraEnabled = Boolean(usage.extraEnabled);
        plan.checkedAt = usage.checkedAt || null;
        plan.reason = null;
      }
    } else if (!plan.ok && usage) {
      plan.reason = usage.reason || 'unknown';
    }

    if (includeAgents) {
      for (const agent of agents) {
        if (!agentUsesAccount(agent, host.ssh_target ? host : null, account)) continue;
        plan.agents.push({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          host: host.name,
          provider: (agent.config || {}).provider || 'claude',
        });
      }
    }
  }

  const plans = [...byIdentity.values()].sort((a, b) => {
    // Busiest plan first: that is the one about to stop someone's work.
    const ua = a.fiveHour ? a.fiveHour.utilization : -1;
    const ub = b.fiveHour ? b.fiveHour.utilization : -1;
    if (ua !== ub) return ub - ua;
    return String(a.identity).localeCompare(String(b.identity));
  });

  return {
    plans,
    hostsUnreachable: perHost.filter((p) => !p.ok).map((p) => p.host.name),
    checkedAt: new Date().toISOString(),
  };
}
