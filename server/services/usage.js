/**
 * How much of its plan an agent has used.
 *
 * The two providers expose this completely differently, and neither is documented:
 *
 *   Claude  GET https://api.anthropic.com/api/oauth/usage with the account's OAuth
 *           token. This is what `/usage` renders. It is an INTERNAL endpoint -- five
 *           open feature requests exist asking Anthropic for a supported one -- so
 *           everything here degrades to "unknown" rather than breaking when it moves.
 *
 *   Codex   rate_limits.primary.used_percent, written into every rollout record.
 *           No network call needed; the newest record on disk is the answer.
 *
 * Both probes run ON the agent's host, in python, reading the credential file
 * directly. The token therefore never crosses a host boundary and never appears in
 * argv -- which `ps` on that machine would otherwise expose for the life of the call.
 */
import { execOnHost } from './hosts.js';
import { getSetting } from './db.js';

// The endpoint is undocumented and per-account; a dashboard polling every 2s must
// not turn into a request per tick. Usage moves on the scale of minutes.
const TTL_MS = 90 * 1000;
const cache = new Map(); // key -> { at, value }

const CLAUDE_PROBE = `
import json, os, sys, time, urllib.request
cfg = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else os.path.expanduser("~/.claude")
path = os.path.join(cfg, ".credentials.json")
try:
    oauth = json.load(open(path))["claudeAiOauth"]
    tok = oauth["accessToken"]
except Exception:
    print(json.dumps({"ok": False, "reason": "no subscription credential"})); raise SystemExit

# Check expiry BEFORE spending a round trip, and more importantly before reporting a
# bare 401 that reads as "this account is broken".
#
# Access tokens last about an hour and are refreshed by the Claude process using them.
# This probe only READS the file -- it deliberately does not perform the refresh, which
# would race the running agent's own refresh and could invalidate a working login. So
# any account that nothing has run on lately has a stale token here, and the API answers
# 401 even though the account is perfectly good and would refresh on first use. The work
# account sat at "HTTP Error 401: Unauthorized" for this reason with a token 13 days
# past expiry, which was indistinguishable from a revoked login.
exp = oauth.get("expiresAt")
if exp and exp / 1000.0 < time.time():
    days = (time.time() - exp / 1000.0) / 86400.0
    print(json.dumps({"ok": False, "tokenExpired": True,
                      "hasRefreshToken": bool(oauth.get("refreshToken")),
                      "subscriptionType": oauth.get("subscriptionType"),
                      "reason": ("access token expired %.1f days ago; Maestro does not refresh it, "
                                 "so usage is unreadable until something runs on this account" % days)
                                if oauth.get("refreshToken") else
                                ("access token expired %.1f days ago and there is no refresh token "
                                 "— this account needs a fresh login" % days)}))
    raise SystemExit
req = urllib.request.Request(
    "https://api.anthropic.com/api/oauth/usage",
    headers={"authorization": "Bearer " + tok,
             "anthropic-beta": "oauth-2025-04-20",
             "anthropic-version": "2023-06-01"})
try:
    d = json.load(urllib.request.urlopen(req, timeout=12))
except Exception as e:
    print(json.dumps({"ok": False, "reason": str(e)[:80]})); raise SystemExit
def win(k):
    w = d.get(k) or {}
    return {"utilization": w.get("utilization"), "resetsAt": w.get("resets_at")} if w.get("utilization") is not None else None
extra = d.get("extra_usage") or {}
# Only the three documented-by-behaviour fields. The response also carries a dozen
# null buckets with internal codenames; reading those would be guessing.
print(json.dumps({"ok": True, "provider": "claude",
                  "fiveHour": win("five_hour"), "sevenDay": win("seven_day"),
                  "extraEnabled": bool(extra.get("is_enabled"))}))
`;

const CODEX_PROBE = `
import glob, json, os
# Newest rollout, last record carrying rate_limits. Read backwards: these files
# reach tens of MB and only the tail is current.
files = sorted(glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/rollout-*.jsonl")),
               key=os.path.getmtime, reverse=True)[:3]
best = None
for p in files:
    try:
        with open(p, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 400000))
            tail = fh.read().decode("utf-8", "replace")
    except Exception:
        continue
    for line in reversed(tail.split("\\n")):
        if '"rate_limits"' not in line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        def find(o, d=0):
            if d > 8: return None
            if isinstance(o, dict):
                if "rate_limits" in o and isinstance(o["rate_limits"], dict): return o["rate_limits"]
                for v in o.values():
                    x = find(v, d + 1)
                    if x: return x
            if isinstance(o, list):
                for v in o:
                    x = find(v, d + 1)
                    if x: return x
            return None
        rl = find(r)
        if rl and (rl.get("primary") or {}).get("used_percent") is not None:
            best = (rl, os.path.getmtime(p)); break
    if best: break
if not best:
    print(json.dumps({"ok": False, "reason": "no rate_limits in recent rollouts"}))
else:
    rl, mt = best
    p = rl.get("primary") or {}
    s = rl.get("secondary") or {}
    print(json.dumps({"ok": True, "provider": "codex",
                      "primary": {"utilization": p.get("used_percent"),
                                  "windowMinutes": p.get("window_minutes"),
                                  "resetsAtEpoch": p.get("resets_at")},
                      "secondary": {"utilization": s.get("used_percent"),
                                    "windowMinutes": s.get("window_minutes")} if s.get("used_percent") is not None else None,
                      "asOfEpoch": mt}))
`;

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Usage for one ACCOUNT on one host — the unit the answer actually depends on.
 *
 * This is the `/usage` equivalent: the same five-hour and seven-day windows that
 * slash command renders, read from the same endpoint. Exported in its own right
 * because a plan is not a property of an agent: one subscription can be signed in
 * on several hosts and drive a dozen agents, and all of them share one limit.
 *
 * @param {object|null} host   null => local
 * @param {string} configDir   '' => the default account (~/.claude)
 * @returns {Promise<object>} always an object; `ok:false` with a reason rather than
 *   a throw, because a usage indicator must never break the view it sits in.
 */
export async function usageForAccount(host, configDir = '', provider = 'claude') {
  if (provider !== 'claude' && provider !== 'codex') {
    return { ok: false, reason: `no usage source for ${provider}` };
  }
  if (getSetting('usage_probe_disabled') === '1') {
    return { ok: false, reason: 'usage probing disabled' };
  }

  // Six Claude agents sharing one account share one probe.
  const key = `${provider}:${host ? host.id : 'local'}:${configDir}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const script = provider === 'claude' ? CLAUDE_PROBE : CODEX_PROBE;
  const arg = provider === 'claude' ? ` ${q(configDir)}` : '';
  let value;
  try {
    const { stdout } = await execOnHost(
      host,
      `python3 -c ${q(script)}${arg}`,
      { timeout: 20000 }
    );
    value = JSON.parse(String(stdout).trim().split('\n').pop());
  } catch (err) {
    value = { ok: false, reason: String(err.message || err).slice(0, 90) };
  }
  value.checkedAt = new Date().toISOString();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The plan behind a given agent. Thin wrapper: the account is what matters. */
export async function usageForAgent(agent, host) {
  if (!agent) return { ok: false, reason: 'no agent' };
  const provider = (agent.config && agent.config.provider) || 'claude';
  const configDir = (agent.config && agent.config.claudeConfigDir) || '';
  return usageForAccount(host, configDir, provider);
}

/** Drop cached usage, e.g. after an account switch. */
export function forgetUsage() {
  cache.clear();
}
