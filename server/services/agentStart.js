/**
 * Starting an agent's session, in one place.
 *
 * This was the body of POST /agents/:id/start. It moved here so the monitor can
 * recover agents after a host outage using the SAME code path — duplicating it
 * would have meant the recovery path quietly missing things the route does, like
 * resuming a Claude transcript or a Codex rollout, and starting empty sessions
 * instead of continuing conversations.
 *
 * Failures are thrown with a `code` the caller maps as it sees fit: the route turns
 * them into HTTP statuses, the monitor just logs and moves on.
 *   NO_WORKDIR  / BAD_WORKDIR  — misconfiguration, no point retrying
 *   HOST_DOWN                  — transport failure; the host will come back
 */
import fs from 'fs';
import { randomUUID } from 'crypto';

import { getProject, updateAgentStatus, getAgent, setAgentClaudeSessionId } from './db.js';
import { getProvider } from './providers.js';
import { createSession, startProviderSession } from './tmux.js';
import { execOnHost, isRemote, shellQuote, isHostUnreachable, describeHostError } from './hosts.js';
import { resolveAgentWorkingDir } from './projectPaths.js';
import { pinnedTranscriptExists, codexRolloutExists } from './transcript.js';

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Launch (or adopt) the agent's tmux session.
 * @returns {Promise<{status: string, message: string, provider: object}>}
 */
export async function startAgentSession(agent, host, { registerAgent } = {}) {
  // Resolve the working directory for this agent's (project, host):
  // local host => project.path; remote host => the per-host configured path.
  let workingDir = null;
  if (agent.project_id) {
    const project = getProject(agent.project_id);
    if (project) {
      workingDir = resolveAgentWorkingDir(agent, project, host);
      if (workingDir === null && isRemote(host)) {
        throw fail(
          'NO_WORKDIR',
          `No working directory is set for project "${project.name}" on host ${host.name}. Set a working directory for this host in the project settings before starting the agent.`
        );
      }
    }
  }

  // tmux silently falls back to $HOME when `-c <dir>` doesn't exist — catch it here instead
  if (workingDir) {
    if (isRemote(host)) {
      try {
        await execOnHost(host, `test -d ${shellQuote(workingDir)}`);
      } catch (err) {
        // `test -d` exits 1 when the dir is missing; anything else is an ssh failure
        if (err.code === 1) {
          throw fail('BAD_WORKDIR', `Project path does not exist: ${workingDir}. Update the project settings.`);
        }
        throw fail('HOST_DOWN', describeHostError(err, host));
      }
    } else if (!fs.existsSync(workingDir)) {
      throw fail('BAD_WORKDIR', `Project path does not exist: ${workingDir}. Update the project settings.`);
    }
  }

  const provider = getProvider(agent.config?.provider);

  // For the claude provider, pin a transcript session id so the chat view can locate
  // the exact JSONL file (and so a restart resumes the same transcript). This must
  // NEVER cause a start to fail — on any error we skip pinning and rely on the
  // newest-mtime transcript locator fallback.
  let claudeSessionId = null;
  let claudeResume = false;
  if (provider.id === 'claude') {
    try {
      if (agent.claude_session_id) {
        claudeSessionId = agent.claude_session_id;
        // Claude rejects --session-id when the transcript already exists and rejects
        // --resume when it doesn't, so choose by the file's presence.
        claudeResume = await pinnedTranscriptExists(host, claudeSessionId);
      } else {
        claudeSessionId = randomUUID();
        setAgentClaudeSessionId(agent.id, claudeSessionId);
      }
    } catch {
      claudeSessionId = null; // fall back to the locator
      claudeResume = false;
    }
  }

  // For codex, resume the pinned rollout when it is still on disk.
  let codexResumeId = null;
  if (provider.id === 'codex' && agent.claude_session_id) {
    try {
      if (await codexRolloutExists(host, agent.claude_session_id)) {
        codexResumeId = agent.claude_session_id;
      }
    } catch {
      codexResumeId = null;
    }
  }

  let result;
  try {
    if (provider.id === 'shell') {
      result = await createSession(agent.screen_session, workingDir, null, host);
    } else {
      const command = provider.buildCommand(
        { ...(agent.config || {}), claudeSessionId, claudeResume, codexResumeId },
        agent.name,
        host
      );
      result = await startProviderSession(agent.screen_session, command, workingDir, host);
    }
  } catch (err) {
    if (isRemote(host)) {
      throw fail(isHostUnreachable(err) ? 'HOST_DOWN' : 'START_FAILED', describeHostError(err, host));
    }
    throw err;
  }

  // A non-monitorable provider (shell) has no pane parsing behind it, so nothing would
  // ever move it off 'running' — it would sit in the dashboard's Active section
  // forever. A bare shell is up-but-not-working, which is what 'idle' means.
  const startedStatus = provider.monitorable ? 'running' : 'idle';
  updateAgentStatus(agent.id, startedStatus);
  if (provider.monitorable && registerAgent) registerAgent(agent.id, agent.screen_session, host);

  const message = result.alreadyRunning || !result.created
    ? 'Session already running'
    : result.adopted
      ? `${provider.name} started in the existing session`
      : `${provider.name} started`;

  return { status: startedStatus, message, provider, agent: getAgent(agent.id) };
}
