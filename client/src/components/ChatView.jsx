import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useContext, createContext } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { useApp } from '../context/AppContext';

// Claude also emits LaTeX with \(...\) and \[...\] delimiters; remark-math only
// understands $...$ / $$...$$. Rewrite those to dollar delimiters, but protect
// fenced/inline code so we never touch real code.
function normalizeMath(text) {
  if (!text) return '';
  const stash = [];
  const guard = (m) => `@@MG${stash.push(m) - 1}@@`;
  let out = text
    .replace(/```[\s\S]*?```/g, guard)
    .replace(/`[^`\n]*`/g, guard);
  out = out
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => `$$${e}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => `$${e}$`);
  // remark-math only renders display (block) math when the $$ delimiters are on
  // their own lines; single-line $$...$$ (and our \[...\] conversion) would
  // otherwise render inline. Put every $$...$$ into block form.
  out = out.replace(/\$\$\s*([\s\S]+?)\s*\$\$/g, (_, e) => `\n\n$$\n${e}\n$$\n\n`);
  return out.replace(/@@MG(\d+)@@/g, (_, i) => stash[Number(i)]);
}

const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000]; // Exponential backoff
const CHAT_TAIL_CAP = 500; // matches the server's INITIAL_TAIL_LINES; step size for "load earlier"

// ---------------------------------------------------------------------------
// Record classification helpers
// ---------------------------------------------------------------------------

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const n = (name || '').toLowerCase();
  if (n === 'bash') return input.command || '';
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'read' || n === 'notebookedit') {
    return input.file_path || input.notebook_path || '';
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

// Provides the current agent id to the markdown link renderer so links to files
// (relative or absolute-within-the-workdir) can be routed to the file endpoint.
const ChatAgentContext = createContext(null);

// A markdown link. External URLs (http(s)/mailto/…) and #anchors are left alone;
// anything else is treated as a path in the agent's working dir and routed to
// GET /api/agents/:id/file (a trailing :line and #fragment are stripped).
function MarkdownLink({ node, href, children, ...props }) {
  const agentId = useContext(ChatAgentContext);
  const cls = 'text-blue-400 underline hover:text-blue-300';
  const raw = typeof href === 'string' ? href : '';
  const external = /^\/\//.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(mailto|tel|data|app|javascript):/i.test(raw);
  const anchor = raw.startsWith('#');
  if (agentId && raw && !external && !anchor) {
    const clean = raw.replace(/#.*$/, '').replace(/:\d+(:\d+)?$/, '');
    if (clean) {
      return (
        <a
          href={`/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(clean)}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${clean}`}
          className={cls}
        >
          {children}
        </a>
      );
    }
  }
  return (
    <a href={raw || undefined} {...props} target="_blank" rel="noopener noreferrer" className={cls}>
      {children}
    </a>
  );
}

const markdownComponents = {
  a: MarkdownLink,
  p: ({ node, ...props }) => <p className="my-1 leading-relaxed" {...props} />,
  ul: ({ node, ...props }) => <ul className="list-disc pl-5 my-1 space-y-0.5" {...props} />,
  ol: ({ node, ...props }) => <ol className="list-decimal pl-5 my-1 space-y-0.5" {...props} />,
  li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
  h1: ({ node, ...props }) => <h1 className="text-lg font-bold mt-2 mb-1" {...props} />,
  h2: ({ node, ...props }) => <h2 className="text-base font-bold mt-2 mb-1" {...props} />,
  h3: ({ node, ...props }) => <h3 className="text-sm font-bold mt-2 mb-1" {...props} />,
  h4: ({ node, ...props }) => <h4 className="text-sm font-semibold mt-2 mb-1" {...props} />,
  blockquote: ({ node, ...props }) => (
    <blockquote className="border-l-2 border-gray-600 pl-3 my-1 text-gray-400" {...props} />
  ),
  hr: ({ node, ...props }) => <hr className="my-3 border-gray-700" {...props} />,
  pre: ({ node, ...props }) => (
    <pre
      className="my-2 p-3 rounded bg-gray-950/70 border border-gray-700 overflow-x-auto text-xs leading-relaxed"
      {...props}
    />
  ),
  code({ node, className, children, ...props }) {
    const isBlock = /language-/.test(className || '');
    if (isBlock) {
      return (
        <code className={`${className} font-mono`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="px-1 py-0.5 rounded bg-gray-700/70 text-[0.85em] font-mono text-pink-300"
        {...props}
      >
        {children}
      </code>
    );
  },
  table: ({ node, ...props }) => (
    <div className="overflow-x-auto my-2">
      <table className="border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ node, ...props }) => (
    <th className="border border-gray-600 px-2 py-1 bg-gray-800 text-left" {...props} />
  ),
  td: ({ node, ...props }) => <td className="border border-gray-700 px-2 py-1" {...props} />,
};

// react-markdown's default urlTransform BLANKS any href whose first colon isn't
// preceded by "/" and isn't a safe protocol — which kills `README.md:10`-style
// file:line links before MarkdownLink can route them. Keep those (and other paths)
// intact while still stripping the dangerous inline-script protocols the default
// sanitizer protected against.
function chatUrlTransform(url) {
  const u = String(url || '');
  if (/^\s*(javascript|vbscript):/i.test(u)) return '';
  if (/^\s*data:/i.test(u) && !/^\s*data:image\//i.test(u)) return '';
  return u;
}

function Markdown({ children }) {
  return (
    <div className="text-sm text-gray-100 break-words min-w-0 max-w-full overflow-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, errorColor: '#f87171' }]]}
        components={markdownComponents}
        urlTransform={chatUrlTransform}
      >
        {normalizeMath(children)}
      </ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block components
// ---------------------------------------------------------------------------

function ThinkingBlock({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded border border-gray-700/60 bg-gray-800/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="italic">Thinking</span>
      </button>
      {open && (
        <div className="px-3 pb-2 text-xs text-gray-400 whitespace-pre-wrap break-words">
          {text}
        </div>
      )}
    </div>
  );
}

function ToolUseCard({ block }) {
  const summary = summarizeToolInput(block.name, block.input);
  return (
    <div className="my-1 rounded border border-gray-700 bg-gray-800/60 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <svg className="w-3.5 h-3.5 text-blue-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="font-medium text-blue-300">{block.name || 'tool'}</span>
      </div>
      {summary && (
        <div className="mt-0.5 text-xs text-gray-400 font-mono truncate" title={summary}>
          {summary}
        </div>
      )}
    </div>
  );
}

function ToolResultCard({ result, onImage }) {
  const content = result.content;
  const texts = [];
  const images = [];
  if (typeof content === 'string') {
    if (content) texts.push(content);
  } else if (Array.isArray(content)) {
    content.forEach((b) => {
      if (!b) return;
      if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'image' && b.source?.type === 'base64') {
        images.push(`data:${b.source.media_type};base64,${b.source.data}`);
      }
    });
  }
  if (texts.length === 0 && images.length === 0) return null;
  return (
    <div className="rounded border border-gray-700 bg-gray-900/60">
      <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-700/60">
        result
      </div>
      {/* Text output: keep the compact scroll box */}
      {texts.length > 0 && (
        <div className="p-2 max-h-64 overflow-auto">
          {texts.map((t, i) => (
            <pre key={i} className="text-xs font-mono text-gray-300 whitespace-pre-wrap break-words">
              {t}
            </pre>
          ))}
        </div>
      )}
      {/* Images: render at full container width (the original data, not downscaled
          by us) and let the user open the full-resolution image in a new tab. */}
      {images.map((src, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onImage && onImage(src)}
          title="Click to view full size"
          className="block w-full p-2 text-left"
        >
          <img src={src} alt="tool result" className="max-w-full rounded cursor-zoom-in" />
        </button>
      ))}
    </div>
  );
}

// The AskUserQuestion tool_result reads: ... "Question"="Answer" ... — collect the
// chosen answer strings so we can highlight them once the question is answered.
function parseAnswers(text) {
  const set = new Set();
  if (typeof text === 'string') {
    const re = /"[^"]*"\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(text))) set.add(m[1]);
  }
  return set;
}

function QuestionCard({ block, answered, chosen, onAnswer }) {
  const questions = block.input?.questions || [];
  if (questions.length === 0) return null;
  return (
    <div
      className={`my-1 rounded-lg border px-3 py-2 ${
        answered ? 'border-gray-700 bg-gray-800/50' : 'border-blue-500/60 bg-blue-950/30'
      }`}
    >
      {!answered && (
        <div className="flex items-center gap-1.5 text-xs text-blue-300 mb-2">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-medium">Waiting for your answer</span>
        </div>
      )}
      {questions.map((q, qi) => {
        const clickable = !answered && !q.multiSelect && !!onAnswer;
        return (
          <div key={qi} className={qi > 0 ? 'mt-3' : ''}>
            {q.header && (
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">{q.header}</div>
            )}
            <div className="text-sm text-gray-100 font-medium mb-1.5 break-words">{q.question}</div>
            <div className="space-y-1">
              {(q.options || []).map((opt, oi) => {
                const isChosen = chosen && chosen.has(opt.label);
                return (
                  <button
                    key={oi}
                    type="button"
                    disabled={!clickable}
                    onClick={clickable ? () => onAnswer(oi + 1) : undefined}
                    className={`w-full text-left rounded border px-2.5 py-1.5 transition-colors ${
                      isChosen
                        ? 'border-blue-400 bg-blue-900/40'
                        : clickable
                          ? 'border-gray-600 hover:border-blue-400 hover:bg-blue-900/20 cursor-pointer'
                          : 'border-gray-700 cursor-default'
                    }`}
                  >
                    <div className={`text-sm font-medium ${isChosen ? 'text-blue-200' : 'text-gray-100'}`}>
                      <span className="text-gray-500">{oi + 1}.</span> {opt.label}
                      {isChosen && <span className="ml-1.5 text-xs text-blue-300">✓ chosen</span>}
                    </div>
                    {opt.description && (
                      <div className="text-xs text-gray-400 mt-0.5 break-words">{opt.description}</div>
                    )}
                  </button>
                );
              })}
            </div>
            {!answered && q.multiSelect && (
              <div className="mt-1 text-[11px] text-amber-400/80">
                Multiple-choice — answer in the terminal.
              </div>
            )}
          </div>
        );
      })}
      {!answered && (
        <div className="mt-2 text-[11px] text-gray-500">Click an option, or type a reply below.</div>
      )}
    </div>
  );
}

// A Claude Code select widget (AskUserQuestion, plan approval, etc.) lives only in
// the live pane while active — it isn't written to the transcript until answered.
// Detect it from a pane snapshot and pull the numbered options for clickable answers.
function parseActivePrompt(text) {
  if (!text) return null;
  const lines = text.split('\n');
  // Footer of a live select widget. Claude: "↑/↓ to select" etc.; Codex: "Press
  // enter to continue" under a › cursor. Either way the numbered options sit above
  // it and a number key selects+submits (POST /answer works for both providers).
  const footerIdx = lines.findIndex((l) => /to select|to navigate|Esc to cancel|↑\/↓|press enter to /i.test(l));
  if (footerIdx === -1) return null;
  const options = [];
  let firstOptIdx = -1;
  const start = Math.max(0, footerIdx - 25);
  for (let i = start; i < footerIdx; i++) {
    const m = lines[i].match(/^[\s│┃▎☐☑◉○❯›>*·-]*?(\d+)[.)]\s+(.*\S)\s*$/);
    if (m) {
      if (firstOptIdx === -1) firstOptIdx = i;
      options.push({ n: parseInt(m[1], 10), label: m[2].trim() });
    }
  }
  if (options.length === 0) return null;
  const qLines = [];
  for (let i = firstOptIdx - 1; i >= start && qLines.length < 4; i--) {
    const t = lines[i].replace(/[│╰╯╭╮─┃▎☐☑◉○❯›>]/g, '').trim();
    if (!t) {
      if (qLines.length) break;
      continue;
    }
    if (/to select|to navigate/.test(t)) break;
    qLines.unshift(t);
  }
  return { question: qLines.join(' ').slice(0, 400), options };
}

function ActivePromptCard({ prompt, onAnswer }) {
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] w-full my-1 rounded-lg border border-blue-500/60 bg-blue-950/30 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs text-blue-300 mb-2">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-medium">The agent is waiting for your answer</span>
        </div>
        {prompt.question && (
          <div className="text-sm text-gray-100 mb-1.5 whitespace-pre-wrap break-words">{prompt.question}</div>
        )}
        <div className="space-y-1">
          {prompt.options.map((opt) => (
            <button
              key={opt.n}
              type="button"
              onClick={() => onAnswer && onAnswer(opt.n)}
              className="w-full text-left rounded border border-gray-600 hover:border-blue-400 hover:bg-blue-900/20 px-2.5 py-1.5 text-sm text-gray-100 transition-colors cursor-pointer"
            >
              <span className="text-gray-500">{opt.n}.</span> {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Derive a short activity label from the transcript so the indicator can say
// what the agent is doing (running a tool it hasn't returned from, else generic).
function deriveActivity(records) {
  const resultIds = new Set();
  for (const r of records) {
    const c = r.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'tool_result' && b.tool_use_id) resultIds.add(b.tool_use_id);
      }
    }
  }
  let pendingTool = null;
  for (const r of records) {
    const c = r.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'tool_use' && b.id && !resultIds.has(b.id)) pendingTool = b.name;
      }
    }
  }
  return pendingTool ? `Running ${pendingTool}…` : 'Working…';
}

function WorkingIndicator({ label }) {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/70 px-3 py-2">
        <span className="flex gap-1" aria-hidden="true">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:-0.3s]" />
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:-0.15s]" />
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" />
        </span>
        <span className="text-xs text-gray-400">{label}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Record renderers
// ---------------------------------------------------------------------------

function renderAssistant(rec, ctx) {
  const content = rec.message?.content;
  const blocks =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : [];
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] space-y-1">
        {blocks.map((block, i) => {
          const key = `${rec.uuid}-${i}`;
          if (!block) return null;
          if (block.type === 'text') {
            if (!block.text || !block.text.trim()) return null;
            return <Markdown key={key}>{block.text}</Markdown>;
          }
          if (block.type === 'thinking') {
            return <ThinkingBlock key={key} text={block.thinking} />;
          }
          if (block.type === 'tool_use') {
            if (block.name === 'AskUserQuestion') {
              const resultText = ctx && ctx.results ? ctx.results[block.id] : undefined;
              const answered = resultText !== undefined;
              return (
                <QuestionCard
                  key={key}
                  block={block}
                  answered={answered}
                  chosen={answered ? parseAnswers(resultText) : null}
                  onAnswer={ctx && ctx.onAnswer}
                />
              );
            }
            return <ToolUseCard key={key} block={block} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

function renderUserPrompt(rec) {
  const content = rec.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b && b.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : '';
  return (
    <div className="flex justify-end">
      <div className="min-w-0 max-w-[85%] rounded-lg bg-blue-600/20 border border-blue-500/30 px-3 py-2">
        <div className="text-[10px] uppercase tracking-wide text-blue-300/70 mb-0.5">you</div>
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
}

function renderToolResults(rec, ctx) {
  const blocks = rec.message?.content;
  if (!Array.isArray(blocks)) return null;
  const results = blocks.filter((b) => b && b.type === 'tool_result');
  if (results.length === 0) return null;
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] w-full space-y-1">
        {results.map((r, i) => (
          <ToolResultCard key={`${rec.uuid}-${i}`} result={r} onImage={ctx && ctx.onImage} />
        ))}
      </div>
    </div>
  );
}

function renderRecord(rec, ctx) {
  if (rec.type === 'assistant') return renderAssistant(rec, ctx);
  if (rec.type === 'user') {
    if (rec.isMeta) return null;
    const content = rec.message?.content;
    const hasToolResult = Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
    if (hasToolResult) return renderToolResults(rec, ctx);
    return renderUserPrompt(rec);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codex transcript rendering
// ---------------------------------------------------------------------------
// Codex's rollout JSONL differs from Claude's: each line is {timestamp,type,payload}.
// Render user/assistant text from event_msg (user_message / agent_message) and tool
// activity from response_item (custom_tool_call / _output). Reasoning is encrypted,
// and response_item messages duplicate the event_msg text, so both are skipped.

function codexOutputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((o) => (o && typeof o.text === 'string' ? o.text : '')).join('');
  }
  return '';
}

// Dedupe key for a Codex record (they carry no uuid; tail replays from the top).
function codexKey(rec) {
  const p = (rec && rec.payload) || {};
  const c = p.message || p.input || (Array.isArray(p.output) ? codexOutputText(p.output) : '') || '';
  return `${rec.timestamp || ''}|${rec.type || ''}:${p.type || ''}|${p.call_id || p.id || ''}|${String(c).slice(0, 60)}`;
}

function codexToolSummary(name, input) {
  if (typeof input !== 'string') {
    try { return JSON.stringify(input); } catch { return ''; }
  }
  if (name === 'exec') {
    const m = input.match(/"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
  }
  return input.trim();
}

function CodexToolCard({ name, input }) {
  const summary = codexToolSummary(name, input);
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] w-full my-1 rounded border border-gray-700 bg-gray-800/60 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 text-xs">
          <svg className="w-3.5 h-3.5 text-blue-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
          </svg>
          <span className="font-medium text-blue-300">{name || 'tool'}</span>
        </div>
        {summary && (
          <pre className="mt-1 text-xs text-gray-300 font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">
            {summary}
          </pre>
        )}
      </div>
    </div>
  );
}

// Codex edits files via a patch tool; event_msg/patch_apply_end reports the result
// (success + a changes map path->{type: add|update|delete}, or an "A /path" stdout).
function CodexPatchCard({ payload }) {
  const agentId = useContext(ChatAgentContext);
  const changes = payload && payload.changes && typeof payload.changes === 'object' ? payload.changes : null;
  let files = [];
  if (changes) {
    files = Object.entries(changes).map(([p, c]) => ({ path: p, type: (c && c.type) || 'update' }));
  } else if (typeof payload.stdout === 'string') {
    files = payload.stdout.split('\n')
      .map((l) => l.match(/^\s*([AMD])\s+(.+\S)\s*$/))
      .filter(Boolean)
      .map((m) => ({ path: m[2], type: { A: 'add', M: 'update', D: 'delete' }[m[1]] }));
  }
  const ok = payload.success !== false;
  const mark = { add: '+', update: '~', delete: '−' };
  const col = { add: 'text-green-400', update: 'text-blue-300', delete: 'text-red-400' };
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] w-full my-1 rounded border border-gray-700 bg-gray-800/60 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 text-xs">
          <svg className="w-3.5 h-3.5 text-blue-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span className="font-medium text-blue-300">
            {ok ? 'Edited' : 'Edit failed'}{files.length ? ` · ${files.length} file${files.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        {files.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {files.map((f, i) => (
              <div key={i} className="text-xs font-mono truncate">
                <span className={col[f.type] || 'text-gray-400'}>{mark[f.type] || '~'}</span>{' '}
                {agentId ? (
                  <a
                    href={`/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(f.path)}`}
                    target="_blank" rel="noopener noreferrer" title={`Open ${f.path}`}
                    className="text-blue-400 hover:text-blue-300 underline"
                  >
                    {f.path}
                  </a>
                ) : <span className="text-gray-300">{f.path}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function renderCodexRecords(records, ctx) {
  const out = [];
  records.forEach((rec, i) => {
    if (!rec || typeof rec !== 'object') return;
    const p = rec.payload || {};
    const key = `cx-${i}-${p.call_id || p.id || rec.timestamp || i}`;
    let el = null;
    if (rec.type === 'event_msg' && p.type === 'user_message' && p.message) {
      el = (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[85%] rounded-lg bg-blue-600/20 border border-blue-500/30 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-blue-300/70 mb-0.5">you</div>
            <Markdown>{p.message}</Markdown>
          </div>
        </div>
      );
    } else if (rec.type === 'event_msg' && p.type === 'agent_message' && p.message) {
      el = (
        <div className="flex justify-start">
          <div className="min-w-0 max-w-[92%] space-y-1"><Markdown>{p.message}</Markdown></div>
        </div>
      );
    } else if (rec.type === 'response_item' && p.type === 'custom_tool_call') {
      el = <CodexToolCard name={p.name} input={p.input} />;
    } else if (rec.type === 'response_item' && p.type === 'custom_tool_call_output') {
      const text = codexOutputText(p.output);
      if (text.trim()) el = <ToolResultCard result={{ content: text }} onImage={ctx && ctx.onImage} />;
    } else if (rec.type === 'event_msg' && p.type === 'patch_apply_end') {
      el = <CodexPatchCard payload={p} />;
    }
    if (el) out.push(<div key={key}>{el}</div>);
  });
  return out;
}

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

function ChatView({ agentId, session }) {
  const { sendAgentInput, answerAgentQuestion, getAgentPane, agentStates, agents } = useApp();

  // Which provider's transcript format to render (Claude vs Codex). Kept in a ref
  // too, so the long-lived WebSocket onmessage closure dedupes with the right key.
  const provider = useMemo(
    () => (agents || []).find((a) => String(a.id) === String(agentId))?.config?.provider || 'claude',
    [agents, agentId]
  );
  const providerRef = useRef('claude');
  providerRef.current = provider;

  const [records, setRecords] = useState([]);
  const [connected, setConnected] = useState(false);
  const [banner, setBanner] = useState(null); // { type: 'error' | 'end', message }
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [pendingSent, setPendingSent] = useState(false);
  // Hidden until the initial history burst settles, so we reveal already pinned
  // at the bottom instead of visibly scrolling through the whole transcript.
  const [ready, setReady] = useState(false);
  const [lightbox, setLightbox] = useState(null); // full-size image src, or null
  const [activePrompt, setActivePrompt] = useState(null); // live select prompt, or null
  // "Load earlier" paging: chat opens on the last CHAT_TAIL_CAP records; older
  // history is fetched on demand. atStart => the whole file is loaded (hide button).
  const [atStart, setAtStart] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const wsRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  const mountedRef = useRef(true);
  const seenUuidsRef = useRef(new Set());
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const atBottomRef = useRef(true);
  const lastTopRef = useRef(0);
  const readyRef = useRef(false);
  const settleTimerRef = useRef(null);
  const textareaRef = useRef(null);
  const historyLimitRef = useRef(CHAT_TAIL_CAP);
  const initialBurstRef = useRef(0); // raw lines received before ready (many are uuid-less, non-rendered)
  const loadingEarlierRef = useRef(false);
  const pendingPrependRef = useRef(null); // { prevH, prevTop } while a load-earlier prepend settles

  const markReady = useCallback(() => {
    readyRef.current = true;
    setReady(true);
  }, []);

  // --- WebSocket connection (keyed on agentId via connect callback) ---------
  const connect = useCallback(() => {
    if (!agentId) return;
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/transcript?agent=${encodeURIComponent(agentId)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setBanner(null);
      reconnectAttemptRef.current = 0;
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'record' && msg.record && typeof msg.record === 'object') {
        const rec = msg.record;
        // Count every line in the initial burst (before ready) — including uuid-less
        // ones we won't render — so we can tell if the tail was capped (older exists).
        if (!readyRef.current) initialBurstRef.current += 1;
        // Dedupe across reconnects (which replay history from the top). Claude
        // records carry a uuid; Codex records don't, so synthesize a stable key.
        const key = providerRef.current === 'codex' ? codexKey(rec) : rec.uuid;
        if (!key) return;
        if (seenUuidsRef.current.has(key)) return;
        seenUuidsRef.current.add(key);
        setRecords((prev) => [...prev, rec]);
        // Reveal once the burst of history stops arriving (short quiet period).
        if (!readyRef.current) {
          clearTimeout(settleTimerRef.current);
          settleTimerRef.current = setTimeout(markReady, 180);
        }
      } else if (msg.type === 'error') {
        markReady();
        setBanner({ type: 'error', message: msg.message || 'Transcript error' });
      } else if (msg.type === 'end') {
        markReady();
        setBanner({ type: 'end', message: 'Transcript stream ended' });
      }
    };

    ws.onerror = () => {
      // Reconnection is handled in onclose.
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      wsRef.current = null;
      const attempt = reconnectAttemptRef.current;
      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };
  }, [agentId, markReady]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    // Fallback: reveal even if the transcript is empty or the stream is slow.
    const fallback = setTimeout(markReady, 2500);
    return () => {
      mountedRef.current = false;
      clearTimeout(fallback);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, markReady]);

  // Reveal already pinned to the newest message: scroll to the bottom BEFORE the
  // browser paints the revealed content (useLayoutEffect, not useEffect+rAF), so
  // the transcript never visibly scrolls past on open. Post-reveal growth from
  // async markdown/KaTeX/image reflow is caught by the ResizeObserver below.
  useLayoutEffect(() => {
    if (ready && atBottomRef.current) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Once the initial burst settles, decide whether earlier history exists: a full
  // cap of records means the tail was truncated (older messages remain above).
  useEffect(() => {
    if (ready) setAtStart(initialBurstRef.current < CHAT_TAIL_CAP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Fetch the next older slice and prepend it. The server returns the last N lines;
  // records already shown are deduped, so only genuinely-older ones are prepended.
  const loadEarlier = useCallback(async () => {
    if (loadingEarlierRef.current || atStart) return;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    const el = scrollRef.current;
    const prevH = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    try {
      const nextLimit = historyLimitRef.current + CHAT_TAIL_CAP;
      const res = await fetch(`/api/agents/${agentId}/transcript?tail=${nextLimit}`);
      if (!res.ok) return;
      const data = await res.json();
      historyLimitRef.current = nextLimit;
      const older = [];
      for (const rec of data.records || []) {
        const key = providerRef.current === 'codex' ? codexKey(rec) : rec && rec.uuid;
        if (!key || seenUuidsRef.current.has(key)) continue;
        seenUuidsRef.current.add(key);
        older.push(rec);
      }
      if (older.length) {
        pendingPrependRef.current = { prevH, prevTop };
        setRecords((prev) => [...older, ...prev]);
      }
      if (data.atStart || older.length === 0) setAtStart(true);
    } catch {
      /* leave the button for a retry */
    } finally {
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
    }
  }, [agentId, atStart]);

  // Preserve scroll position when older messages are prepended, so the view stays
  // put instead of jumping. Pre-paint (useLayoutEffect) so there's no visible shift.
  useLayoutEffect(() => {
    const pend = pendingPrependRef.current;
    const el = scrollRef.current;
    if (!pend || !el) return;
    el.scrollTop = pend.prevTop + (el.scrollHeight - pend.prevH);
    pendingPrependRef.current = null;
  }, [records]);

  // --- Auto-scroll ----------------------------------------------------------
  // The transcript streams in from the top (tail -n +1), so on open we want to
  // land at the newest message and then stick there. atBottomRef tracks whether
  // we should keep pinning to the bottom; a real user scroll-up turns it off.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const prevTop = lastTopRef.current;
    lastTopRef.current = el.scrollTop;
    // Only a genuine user scroll UP (scrollTop moving toward 0, away from the
    // bottom) turns off sticking. Content growing below fires no scroll event,
    // and our own scroll-to-bottom only increases scrollTop — so the fast-stream
    // race that used to strand the view near the top can no longer disable it.
    if (dist < 80) {
      atBottomRef.current = true;
    } else if (el.scrollTop < prevTop - 2) {
      atBottomRef.current = false;
    }
  }, []);

  // Keep pinned to the bottom as content grows — including async reflow from
  // markdown/code/images that a records-change effect would miss. A programmatic
  // scroll leaves us at the bottom (so handleScroll keeps atBottomRef true);
  // once the user scrolls up, atBottomRef goes false and we stop following.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  // --- Working / activity indicator ----------------------------------------
  // The pane monitor (agentStates) reports 'busy' while the agent produces
  // output — the reliable "is it working" signal even with no terminal attached.
  // pendingSent bridges the brief gap right after sending, before the monitor
  // catches up.
  const isBusy = agentStates?.[agentId] === 'busy';
  const activityLabel = useMemo(() => deriveActivity(records), [records]);
  const isWorking = isBusy || pendingSent;

  // Pin to the bottom as new records/indicators render — pre-paint, so a growing
  // transcript stays glued to the newest line with no visible scroll motion.
  useLayoutEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [records, isWorking, activityLabel, activePrompt, atStart]);

  // Clear the transient "just sent" flag once the agent is observably working
  // or has produced a reply (covers fast turns the pane monitor may not catch).
  const assistantCount = useMemo(() => records.filter((r) => r.type === 'assistant').length, [records]);
  const prevAssistantRef = useRef(0);
  useEffect(() => {
    if (isBusy || assistantCount > prevAssistantRef.current) {
      setPendingSent(false);
    }
    prevAssistantRef.current = assistantCount;
  }, [isBusy, assistantCount]);

  // --- Sending --------------------------------------------------------------
  const handleSend = useCallback(async () => {
    const text = input;
    if (!text.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sendAgentInput(agentId, text);
      setInput('');
      setPendingSent(true);
    } catch (err) {
      setSendError(err.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  }, [input, sending, sendAgentInput, agentId]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-size the composer to fit its content (up to a max, then it scrolls).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const onAnswerQuestion = useCallback(
    (choice) => {
      answerAgentQuestion(agentId, choice).catch((e) =>
        setSendError(e.message || 'Failed to answer')
      );
    },
    [answerAgentQuestion, agentId]
  );

  // Poll the live pane for an active interactive prompt (which isn't in the
  // transcript until answered) so we can render it with clickable options.
  useEffect(() => {
    if (!agentId) return undefined;
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const text = await getAgentPane(agentId);
        if (!cancelled) setActivePrompt(parseActivePrompt(text));
      } catch {
        /* ignore */
      }
      if (!cancelled) timer = setTimeout(poll, 2500);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agentId, getAgentPane]);

  const renderedRecords = useMemo(() => {
    if (provider === 'codex') {
      return renderCodexRecords(records, { onImage: setLightbox });
    }
    // Map each answered tool_use_id -> its result text (used to mark AskUserQuestion
    // cards answered and highlight the chosen option).
    const results = {};
    records.forEach((rec) => {
      const c = rec.message?.content;
      if (Array.isArray(c)) {
        c.forEach((b) => {
          if (b && b.type === 'tool_result' && b.tool_use_id) {
            results[b.tool_use_id] =
              typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          }
        });
      }
    });
    const ctx = { onImage: setLightbox, onAnswer: onAnswerQuestion, results };
    const out = [];
    records.forEach((rec) => {
      const el = renderRecord(rec, ctx);
      if (!el) return;
      out.push(
        <div key={rec.uuid} className={rec.isSidechain ? 'opacity-70' : ''}>
          {el}
        </div>
      );
    });
    return out;
  }, [records, onAnswerQuestion, provider]);

  return (
    <ChatAgentContext.Provider value={agentId}>
    <div className="h-full w-full flex flex-col bg-gray-900">
      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden"
      >
        {!ready && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900 text-sm text-gray-500">
            Loading conversation…
          </div>
        )}
        <div ref={contentRef} className={`px-3 py-3 space-y-2 min-h-full ${ready ? '' : 'invisible'}`}>
          {renderedRecords.length === 0 && !isWorking && !activePrompt ? (
            <div className="h-full flex items-center justify-center text-center text-sm text-gray-500 px-4">
              {connected
                ? 'No messages yet. Send something below to get started.'
                : 'Connecting to transcript…'}
            </div>
          ) : (
            <>
              {!atStart && renderedRecords.length > 0 && (
                <div className="flex justify-center pb-1">
                  <button
                    type="button"
                    onClick={loadEarlier}
                    disabled={loadingEarlier}
                    className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 rounded-full px-3 py-1 disabled:opacity-50 transition-colors"
                  >
                    {loadingEarlier ? 'Loading earlier…' : 'Load earlier messages'}
                  </button>
                </div>
              )}
              {renderedRecords}
              {activePrompt ? (
                <ActivePromptCard prompt={activePrompt} onAnswer={onAnswerQuestion} />
              ) : (
                isWorking && <WorkingIndicator label={activityLabel} />
              )}
            </>
          )}
        </div>
      </div>

      {/* Status / banner */}
      {(banner || !connected) && (
        <div
          className={`flex-shrink-0 px-3 py-1 text-xs border-t border-gray-700 ${
            banner?.type === 'error'
              ? 'bg-red-900/30 text-red-300'
              : 'bg-gray-800 text-gray-400'
          }`}
        >
          {banner ? banner.message : 'Reconnecting…'}
        </div>
      )}

      {/* Send box */}
      <div className="flex-shrink-0 border-t border-gray-700 bg-gray-800 p-2">
        {sendError && <div className="text-xs text-red-400 mb-1">{sendError}</div>}
        <div className="flex items-end gap-2 w-full min-w-0">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="flex-1 min-w-0 min-h-[38px] max-h-40 overflow-y-auto resize-none rounded bg-gray-900 border border-gray-600 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !input.trim()}
            className="flex-shrink-0 px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? '…' : 'Send'}
          </button>
        </div>
      </div>

      {/* Full-size image viewer (data: URLs can't open in a new tab, so overlay) */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            alt="full size"
            className="max-w-full max-h-full object-contain rounded shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            title="Close"
            className="absolute top-3 right-3 p-2 text-white/70 hover:text-white"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
    </ChatAgentContext.Provider>
  );
}

export default ChatView;
