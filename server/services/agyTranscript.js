/**
 * Antigravity (agy) transcripts, translated into the record shapes the chat view
 * already renders for Claude.
 *
 * agy keeps one JSONL per conversation at
 *   <home>/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl
 * where <home> is the agent's agyHome (an alternate account is a whole alternate
 * HOME, see geminiAccounts.js) or the real $HOME. `transcript.jsonl` beside it is
 * the same stream with long fields cut short (`truncated_fields`), so the _full one
 * is the one worth reading.
 *
 * Each line is one step: {step_index, source, type, created_at, content, ...}.
 * Four types occur (counted across every conversation on zlmc, 2026-11-03):
 *   USER_INPUT        the prompt, wrapped in <USER_REQUEST>, plus ADDITIONAL_METADATA
 *   PLANNER_RESPONSE  the model's turn: content, thinking, tool_calls
 *   GENERIC           a tool's output
 *   SYSTEM_MESSAGE    agy talking to the model (background-task completions etc.)
 *
 * A response never carried more than one tool call, and every GENERIC directly
 * followed its call at step_index - 1 (1511 of 1511). That makes pairing a pure
 * function of the step index, so a record can be translated on its own: the live
 * tail and the "load earlier" slices need no shared state, and a slice that starts
 * on a tool output just has a result with no visible call, as Claude's can.
 *
 * Translating here rather than in the client means the Claude renderer, dedupe
 * (by uuid) and tool-card pairing (by tool_use_id) all work unchanged.
 */

// Local rather than imported from transcript.js, which imports this module.
const isUuid = (s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(s || ''));

export const AGY_DIR = '.gemini/antigravity-cli';

// agy writes arguments as JSON-encoded strings in transcript.jsonl ("\"git ...\"")
// and as plain values in transcript_full.jsonl. Accept both.
function argValue(v) {
  if (typeof v !== 'string' || v.length < 2 || v[0] !== '"') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// agy's three file/shell tools map onto Claude's, so they get the same cards
// (command line, file path) instead of a raw JSON summary. Anything else keeps its
// own name and arguments.
function toolUse(call) {
  const a = {};
  for (const [k, v] of Object.entries(call.args || {})) a[k] = argValue(v);
  switch (call.name) {
    case 'run_command':
      return { name: 'Bash', input: { command: a.CommandLine, description: a.toolSummary } };
    case 'read_file':
      return {
        name: 'Read',
        input: {
          file_path: a.Path,
          ...(a.StartLine != null ? { offset: a.StartLine } : {}),
          ...(a.EndLine != null && a.StartLine != null ? { limit: a.EndLine - a.StartLine + 1 } : {}),
        },
      };
    case 'write_file':
      return { name: 'Write', input: { file_path: a.Path, content: a.Content } };
    default:
      return { name: call.name || 'tool', input: a };
  }
}

// The prompt as typed. agy wraps it in <USER_REQUEST> and appends metadata (local
// time, open files) the person never wrote.
function userText(content) {
  const s = String(content || '');
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return m ? m[1] : s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '').trim();
}

// SYSTEM_MESSAGEs are agy's equivalent of Claude's <task-notification>: machinery,
// not the person. Re-expressed in that form so they render as the same small pill
// instead of a "you" bubble.
function systemNotice(content) {
  const s = String(content || '');
  const inner = (s.match(/<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/) || [])[1] || s;
  const said = (inner.match(/\bcontent=([\s\S]*)$/) || [])[1] || inner;
  const summary = said.replace(/\s+/g, ' ').trim().slice(0, 200);
  // An exit code, when agy reports one, beats scanning the text: a command's own
  // output says "failed" all the time (a test run listing its failures) while the
  // task itself is reported as code 0, or the reverse.
  const code = said.match(/exited with code (-?\d+)/);
  // (The chat colours a notice red when its status says "fail".)
  const status = code ? (code[1] === '0' ? 'completed' : `failed, exit ${code[1]}`)
    : /\b(fail|error)/i.test(said) ? 'failed' : 'completed';
  const esc = (t) => t.replace(/</g, '‹');
  return `<task-notification><summary>${esc(summary)}</summary><status>${status}</status></task-notification>`;
}

/**
 * One agy step -> one Claude-shaped record, or null for anything to skip.
 * `conv` (the conversation id) namespaces the uuids so two conversations can never
 * collide in the chat's dedupe.
 */
export function agyToRecord(step, conv) {
  if (!step || typeof step !== 'object' || !Number.isInteger(step.step_index)) return null;
  const n = step.step_index;
  const base = { uuid: `agy-${conv}-${n}`, timestamp: step.created_at, agy: true };

  switch (step.type) {
    case 'USER_INPUT':
      return { ...base, type: 'user', message: { role: 'user', content: userText(step.content) } };

    case 'PLANNER_RESPONSE': {
      const blocks = [];
      if (step.thinking && String(step.thinking).trim()) blocks.push({ type: 'thinking', thinking: step.thinking });
      if (step.content && String(step.content).trim()) blocks.push({ type: 'text', text: step.content });
      (step.tool_calls || []).forEach((call, i) => {
        const { name, input } = toolUse(call);
        // i > 0 has never been seen; the suffix only keeps ids unique if it appears.
        blocks.push({ type: 'tool_use', id: `agy-${conv}-${n}${i ? `-${i}` : ''}`, name, input });
      });
      if (!blocks.length) return null;
      return {
        ...base,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: blocks,
          usage: {
            input_tokens: step.input_tokens || 0,
            output_tokens: step.output_tokens || 0,
            cache_read_input_tokens: step.cache_read_tokens || 0,
          },
        },
      };
    }

    case 'GENERIC':
      return {
        ...base,
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `agy-${conv}-${n - 1}`, content: String(step.content || '') }],
        },
      };

    case 'SYSTEM_MESSAGE':
      return { ...base, type: 'user', message: { role: 'user', content: systemNotice(step.content) } };

    default:
      return null;
  }
}

/** The conversation id in an agy transcript path, or null. */
export function agyConversationFromPath(file) {
  const m = /\/brain\/([0-9a-fA-F-]{36})\/\.system_generated\//.exec(String(file || ''));
  return m && isUuid(m[1]) ? m[1] : null;
}

/**
 * A line parser for an agent's transcript: identity (JSON.parse) for Claude/Codex,
 * agy translation for Antigravity. Returns null for lines to drop.
 */
export function transcriptLineParser(agent, file) {
  const isAgy = agent && agent.config && agent.config.provider === 'antigravity';
  const conv = isAgy ? agyConversationFromPath(file) : null;
  return (line) => {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return null;
    }
    return isAgy ? agyToRecord(rec, conv || 'unknown') : rec;
  };
}
