import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useContext, createContext } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { useApp } from '../context/AppContext';
import useMediaQuery from '../hooks/useMediaQuery';

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
  if (n === 'agent' || n === 'task') {
    const head = [input.subagent_type ? `→ ${input.subagent_type}` : null, input.description].filter(Boolean).join(': ');
    return head || (typeof input.prompt === 'string' ? input.prompt.slice(0, 140) : '');
  }
  if (n === 'taskcreate') return input.subject || '';
  if (n === 'taskupdate') return `${input.taskId ? `#${input.taskId} ` : ''}${input.status || ''}`.trim();
  if (n === 'webfetch') return input.url || '';
  if (n === 'websearch') return input.query || '';
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

// Provides { agentId, openFile } to file links in rendered markdown: a link to a
// file in the agent's working dir routes to the file endpoint and, for text/markdown,
// opens in the in-app viewer.
const ChatAgentContext = createContext(null);

// Extensions rendered in the in-app viewer (markdown rendered, others as text).
// Images/PDF/binaries are absent — they open via the endpoint (the browser handles them).
const VIEWER_EXTS = new Set([
  'md','markdown','txt','text','rst','log','csv','tsv','json','jsonl','yaml','yml','toml','ini','cfg','conf','env',
  'xml','html','htm','css','scss','less','py','js','jsx','ts','tsx','mjs','cjs','c','cc','cpp','h','hpp','sh','bash',
  'zsh','rb','go','rs','java','kt','swift','php','pl','r','m','sql','lua','dart','scala','vue','svelte','tex','bib',
  'diff','patch','v','sv','vhd','proto','gradle','make','mk','dockerfile','gitignore',
]);

function fileExt(p) {
  const n = String(p).split('/').pop() || '';
  return (n.includes('.') ? n.split('.').pop() : n).toLowerCase();
}

// Extensions/filenames that mark a bare token (in prose or `inline code`) as an
// openable working-dir file. Superset of VIEWER_EXTS plus binaries the viewer still
// downloads (images/pdf/office/archives/media). Curated on purpose: a known ext is
// what keeps `res.setHeader`, `config.provider`, `1.2.3` etc. from becoming links.
const LINKABLE_EXTS = new Set([
  ...VIEWER_EXTS,
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'pdf',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
  'wav', 'mp3', 'mp4', 'mov', 'webm', 'ogg',
  'lock', 'map', 'wasm', 'bin', 'db', 'sqlite',
]);
const LINKABLE_NAMES = new Set([
  'Makefile', 'Dockerfile', 'LICENSE', 'Procfile', 'Rakefile', 'Gemfile', 'Justfile',
]);

// Split a "path[:line[:col]]" reference into { path, suffix }. The endpoint wants the
// clean path; the suffix is kept only for display so the reference still reads right.
function splitPathRef(token) {
  const m = /^(.*?)(:\d+(?::\d+)?)?$/.exec(String(token));
  return { path: m[1] || '', suffix: m[2] || '' };
}

// Whether a token is a working-dir file path worth linking. Conservative: rejects
// URLs, protocol-relative links, npm scopes, `~`/home paths (outside the confinement
// root), and anything lacking a known file extension or filename.
function isFilePathToken(token) {
  const t = String(token || '').trim();
  if (!t || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(mailto|tel|data|vbscript|javascript):/i.test(t)) return false;
  if (t.startsWith('//') || /^www\./i.test(t)) return false;
  if (t.startsWith('~') || t.startsWith('@')) return false; // home dir / npm scope
  if (/[()<>*?"'`|=\\]/.test(t)) return false;
  const { path: p } = splitPathRef(t);
  if (!p || p.endsWith('/')) return false; // directory, not a file
  const base = p.split('/').pop();
  if (!base || base === '.' || base === '..') return false;
  if (LINKABLE_NAMES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false; // no extension
  return LINKABLE_EXTS.has(base.slice(dot + 1).toLowerCase()); // dot===0 handles .env/.gitignore
}

// Split a plain-text string into text + link mdast nodes, wrapping bare file paths.
// Paths in `backticks` are handled by the inline-code component, not here. Returns
// null when nothing was linkified.
function linkifyText(value) {
  const RE = /(?:\.{0,2}\/)?[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*(?::\d+(?::\d+)?)?/g;
  const out = [];
  let last = 0;
  let m;
  while ((m = RE.exec(value))) {
    const full = m[0];
    const start = m.index;
    const { path: core, suffix } = splitPathRef(full);
    const cleanCore = core.replace(/\.+$/, ''); // drop a trailing sentence period
    if (!isFilePathToken(cleanCore)) continue;
    const consumed = cleanCore.length + suffix.length;
    if (start > last) out.push({ type: 'text', value: value.slice(last, start) });
    const ref = cleanCore + suffix;
    out.push({ type: 'link', url: ref, children: [{ type: 'text', value: ref }] });
    last = start + consumed;
    RE.lastIndex = last; // resume after the consumed part (a trimmed trailing dot stays text)
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

// remark plugin: turn bare file-path tokens in plain text into links, so they route
// through MarkdownLink -> FileLink. Skips text already inside a link or code.
function remarkFilePaths() {
  const walk = (node) => {
    if (!node || !Array.isArray(node.children)) return;
    if (node.type === 'link' || node.type === 'linkReference') return; // no nested links
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.type === 'text') {
        const repl = linkifyText(c.value);
        if (repl) { kids.splice(i, 1, ...repl); i += repl.length - 1; }
      } else if (c.type !== 'inlineCode' && c.type !== 'code') {
        walk(c);
      }
    }
  };
  return (tree) => walk(tree);
}

// A link to a file in the agent's working dir. Left-click a text/markdown file opens
// the in-app viewer; ctrl/cmd-click (or a non-viewable type) uses the raw endpoint.
function FileLink({ path, className, title, children }) {
  const ctx = useContext(ChatAgentContext);
  const agentId = ctx && ctx.agentId;
  const openFile = ctx && ctx.openFile;
  if (!agentId) return <span className={className}>{children}</span>;
  const url = `/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(path)}`;
  const onClick = (e) => {
    if (!openFile) return; // fall back to opening the raw endpoint
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return; // new-tab intent
    e.preventDefault();
    openFile(path); // the viewer handles preview (md/text/image/pdf) + a download button
  };
  return (
    <a href={url} onClick={onClick} target="_blank" rel="noopener noreferrer" title={title || `Open ${path}`} className={className}>
      {children}
    </a>
  );
}

// A markdown link. External URLs (http(s)/mailto/…) and #anchors are left alone;
// anything else is a path in the agent's working dir (trailing :line and #fragment
// stripped), rendered via FileLink.
function MarkdownLink({ node, href, children, ...props }) {
  const cls = 'text-blue-400 underline hover:text-blue-300';
  const raw = typeof href === 'string' ? href : '';
  const external = /^\/\//.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(mailto|tel|data|app|javascript):/i.test(raw);
  const anchor = raw.startsWith('#');
  if (raw && !external && !anchor) {
    const clean = raw.replace(/#.*$/, '').replace(/:\d+(:\d+)?$/, '');
    if (clean) return <FileLink path={clean} className={cls}>{children}</FileLink>;
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
    // An inline-code token that is a working-dir file path (`providers.js`,
    // `server/routes/agents.js:42`) becomes a clickable link into the file viewer,
    // keeping the code-chip look but blue + dotted-underlined to signal it opens.
    const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
    if (isFilePathToken(raw)) {
      const { path: clean } = splitPathRef(raw.trim());
      return (
        <FileLink
          path={clean}
          title={`Open ${raw.trim()}`}
          className="px-1 py-0.5 rounded bg-gray-700/70 text-[0.85em] font-mono text-blue-300 hover:text-blue-200 underline decoration-dotted underline-offset-2 cursor-pointer"
        >
          {children}
        </FileLink>
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
        remarkPlugins={[remarkGfm, remarkMath, remarkFilePaths]}
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

// Claude wraps tool errors in <tool_use_error>…</tool_use_error>; strip it for display.
function stripToolError(t) {
  return typeof t === 'string' ? t.replace(/<\/?tool_use_error>/g, '').trim() : t;
}

// Flatten diff input to lines: Claude structuredPatch hunks [{lines:[...]}] or a
// Codex unified_diff string. Lines keep their +/-/space/@@ prefixes.
function toDiffLines(input) {
  if (Array.isArray(input)) {
    const out = [];
    input.forEach((h, i) => {
      if (i > 0) out.push('@@');
      (h.lines || []).forEach((l) => out.push(l));
    });
    return out;
  }
  return typeof input === 'string' ? input.split('\n') : [];
}

function DiffView({ hunks, text }) {
  const lines = toDiffLines(hunks != null ? hunks : text);
  const big = lines.length > 40;
  const [open, setOpen] = useState(!big);
  if (!lines.length) return null;
  const plus = lines.filter((l) => /^\+/.test(l) && !/^\+\+\+/.test(l)).length;
  const minus = lines.filter((l) => /^-/.test(l) && !/^---/.test(l)).length;
  const body = open ? lines : lines.slice(0, 12);
  return (
    <div className="rounded border border-gray-700 bg-gray-950/70 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2 py-1 text-[11px] border-b border-gray-700/60 hover:bg-gray-800/40"
      >
        <span className="text-green-400">+{plus}</span>
        <span className="text-red-400">−{minus}</span>
        {big && <span className="ml-auto text-gray-500">{open ? 'collapse' : `show all ${lines.length} lines`}</span>}
      </button>
      <div className="max-h-96 overflow-auto">
        {body.map((l, i) => {
          const cls = /^\+\+\+|^---|^@@/.test(l)
            ? 'text-gray-500'
            : l.startsWith('+') ? 'bg-green-900/25 text-green-300'
            : l.startsWith('-') ? 'bg-red-900/25 text-red-300'
            : 'text-gray-400';
          return (
            <div key={i} className={`px-2 text-[11px] font-mono whitespace-pre-wrap break-all leading-snug ${cls}`}>
              {l || ' '}
            </div>
          );
        })}
        {!open && big && <div className="px-2 py-0.5 text-[10px] text-gray-500">… {lines.length - 12} more lines</div>}
      </div>
    </div>
  );
}

// A block of tool output, collapsed to a preview when large.
function CollapsibleText({ text, isError }) {
  const lines = String(text).split('\n');
  const big = lines.length > 16 || text.length > 2000;
  const [open, setOpen] = useState(!big);
  return (
    <div>
      <pre className={`text-xs font-mono whitespace-pre-wrap break-words ${isError ? 'text-red-300' : 'text-gray-300'}`}>
        {open ? text : lines.slice(0, 12).join('\n')}
      </pre>
      {big && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 text-[11px] text-gray-500 hover:text-gray-300">
          {open ? 'show less' : `show ${lines.length - 12} more lines`}
        </button>
      )}
    </div>
  );
}

// A todo/plan checklist (Codex update_plan; reusable for Claude TodoWrite).
function ChecklistCard({ title, items }) {
  const mark = { completed: '✓', in_progress: '◐', pending: '○', cancelled: '✕' };
  const col = { completed: 'text-green-400', in_progress: 'text-blue-300', pending: 'text-gray-500', cancelled: 'text-red-400' };
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] w-full my-1 rounded border border-gray-700 bg-gray-800/60 px-2.5 py-1.5">
        <div className="text-xs font-medium text-blue-300 mb-1">{title}</div>
        <div className="space-y-0.5">
          {items.map((it, i) => (
            <div key={i} className="text-xs flex items-start gap-1.5">
              <span className={col[it.status] || 'text-gray-500'}>{mark[it.status] || '○'}</span>
              <span className={it.status === 'completed' ? 'text-gray-500 line-through' : 'text-gray-200'}>{it.label}</span>
            </div>
          ))}
        </div>
      </div>
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
        summary.includes('\n') ? (
          <pre className="mt-0.5 text-xs text-gray-400 font-mono whitespace-pre-wrap break-words max-h-32 overflow-auto">{summary}</pre>
        ) : (
          <div className="mt-0.5 text-xs text-gray-400 font-mono truncate" title={summary}>{summary}</div>
        )
      )}
    </div>
  );
}

function ToolResultCard({ result, onImage, isError, diff }) {
  const content = result.content;
  const texts = [];
  const images = [];
  if (typeof content === 'string') {
    if (content) texts.push(stripToolError(content));
  } else if (Array.isArray(content)) {
    content.forEach((b) => {
      if (!b) return;
      // Claude uses {type:'text'} / {type:'image',source:{base64}}; Codex tool output
      // uses {type:'input_text'} / {type:'input_image',image_url:'data:...'}.
      if (b.type === 'text' || b.type === 'input_text') texts.push(stripToolError(b.text));
      else if (b.type === 'image' && b.source?.type === 'base64') {
        images.push(`data:${b.source.media_type};base64,${b.source.data}`);
      } else if (b.type === 'input_image' && typeof b.image_url === 'string' && b.image_url.startsWith('data:')) {
        images.push(b.image_url);
      }
    });
  }
  // When there's a diff (Edit/Write), the text is a boilerplate "file updated" blurb
  // — show the diff instead. Otherwise show the (collapsible) text output.
  const showTexts = diff ? [] : texts.filter((t) => t && t.trim());
  if (showTexts.length === 0 && images.length === 0 && !diff) return null;
  return (
    <div className={`rounded border ${isError ? 'border-red-700/70' : 'border-gray-700'} bg-gray-900/60`}>
      <div className={`px-2 py-0.5 text-[10px] uppercase tracking-wide border-b ${isError ? 'text-red-400 border-red-700/50' : 'text-gray-500 border-gray-700/60'}`}>
        {isError ? 'error' : 'result'}
      </div>
      {diff && <div className="p-2"><DiffView hunks={diff} /></div>}
      {showTexts.length > 0 && (
        <div className="p-2 space-y-1">
          {showTexts.map((t, i) => (
            <CollapsibleText key={i} text={t} isError={isError} />
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

// Most "user" records in a Claude transcript aren't things the human typed: they're
// slash-command invocations and injected <system-reminder>/<local-command-stdout>
// blocks. Turn a command into a chip, strip the injected wrappers, and only show a
// real "you" bubble when genuine prose remains.
function cleanUserText(text) {
  if (typeof text !== 'string') return { kind: 'text', text: '' };
  const cmd = text.match(/<command-name>\s*\/?([^<]+?)\s*<\/command-name>/);
  if (cmd) {
    const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1];
    return { kind: 'command', name: cmd[1].trim(), args: (args || '').trim() };
  }
  // Background-task completion notices are injected as user records but aren't things
  // the human typed — surface them as a system notification, not a "you" bubble.
  const tn = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (tn) {
    const rest = text
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();
    if (!rest) {
      const body = tn[1];
      const summary = (body.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '';
      const status = (body.match(/<status>([\s\S]*?)<\/status>/) || [])[1] || '';
      return { kind: 'notification', summary: summary.trim(), status: status.trim() };
    }
  }
  const t = text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .trim();
  return { kind: 'text', text: t };
}

function renderUserPrompt(rec) {
  const content = rec.message?.content;
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
        : '';
  const c = cleanUserText(raw);
  if (c.kind === 'command') {
    return (
      <div className="flex justify-end">
        <div className="text-[11px] text-gray-400 bg-gray-800/60 border border-gray-700 rounded-full px-2.5 py-0.5">
          ran <span className="text-blue-300 font-mono">/{c.name}</span>
          {c.args ? <span className="text-gray-500 font-mono"> {c.args}</span> : null}
        </div>
      </div>
    );
  }
  if (c.kind === 'notification') {
    const failed = /fail|error/i.test(c.status);
    return (
      <div className="flex justify-center my-1">
        <div className={`inline-flex items-center gap-1.5 max-w-[92%] text-[11px] rounded-full border px-3 py-0.5 ${failed ? 'text-red-300 border-red-700/50 bg-red-900/20' : 'text-gray-400 border-gray-700 bg-gray-800/60'}`}>
          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          <span className="truncate">{c.summary || 'Task notification'}{c.status && !/^completed$/i.test(c.status) ? ` · ${c.status}` : ''}</span>
        </div>
      </div>
    );
  }
  if (!c.text) return null; // pure system-reminder / injected block -> render nothing
  return (
    <div className="flex justify-end">
      <div className="min-w-0 max-w-[85%] rounded-lg bg-blue-600/20 border border-blue-500/30 px-3 py-2">
        <div className="text-[10px] uppercase tracking-wide text-blue-300/70 mb-0.5">you</div>
        <Markdown>{c.text}</Markdown>
      </div>
    </div>
  );
}

function renderToolResults(rec, ctx) {
  const blocks = rec.message?.content;
  if (!Array.isArray(blocks)) return null;
  const results = blocks.filter((b) => b && b.type === 'tool_result');
  if (results.length === 0) return null;
  // Edit/Write/MultiEdit results carry a ready-made diff in toolUseResult.structuredPatch.
  const diff = rec.toolUseResult && Array.isArray(rec.toolUseResult.structuredPatch)
    ? rec.toolUseResult.structuredPatch
    : null;
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] w-full space-y-1">
        {results.map((r, i) => (
          <ToolResultCard
            key={`${rec.uuid}-${i}`}
            result={r}
            onImage={ctx && ctx.onImage}
            isError={!!r.is_error}
            diff={i === 0 ? diff : null}
          />
        ))}
      </div>
    </div>
  );
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

// Codex reports every custom_tool_call as name 'exec'; the real tool is encoded in
// the JS input (tools.apply_patch / update_plan / web__run / view_image / exec_command).
function codexToolName(input) {
  const s = typeof input === 'string' ? input : '';
  const m = s.match(/tools\.(apply_patch|update_plan|web__run|view_image|exec_command|build_meta)\b/);
  return m ? m[1] : 'exec_command';
}

function codexToolSummary(tool, input) {
  const s = typeof input === 'string' ? input : (() => { try { return JSON.stringify(input); } catch { return ''; } })();
  const unq = (x) => { try { return JSON.parse(`"${x}"`); } catch { return x; } };
  if (tool === 'exec_command') {
    const m = s.match(/"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return unq(m[1]);
    const arr = [...s.matchAll(/\[\s*"[^"]*"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g)].map((x) => unq(x[1]));
    if (arr.length) return arr.join('\n');
  }
  if (tool === 'web__run') {
    const qs = [...s.matchAll(/"(?:q|query|prompt|search_query)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((x) => unq(x[1]));
    if (qs.length) return qs.join('\n');
  }
  if (tool === 'view_image') {
    const paths = [...s.matchAll(/"((?:\/|\.\/)[^"]+?\.(?:png|jpe?g|gif|webp|pdf|svg))"/gi)].map((x) => x[1]);
    if (paths.length) return paths.join('\n');
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, 400);
}

// Parse a Codex tools.update_plan input into checklist items.
function codexPlanItems(input) {
  const s = typeof input === 'string' ? input : '';
  return [...s.matchAll(/step\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*status\s*:\s*"(\w+)"/g)].map((m) => ({
    label: (() => { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } })(),
    status: m[2],
  }));
}

function CodexToolCard({ input }) {
  const tool = codexToolName(input);
  if (tool === 'apply_patch') return null; // the patch_apply_end card renders the result
  if (tool === 'update_plan') {
    const items = codexPlanItems(input);
    if (items.length) return <ChecklistCard title="Plan" items={items} />;
  }
  const label = tool === 'exec_command' ? 'exec' : tool.replace(/__/g, ' ');
  const summary = codexToolSummary(tool, input);
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] w-full my-1 rounded border border-gray-700 bg-gray-800/60 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 text-xs">
          <svg className="w-3.5 h-3.5 text-blue-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
          </svg>
          <span className="font-medium text-blue-300">{label}</span>
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
  const changes = payload && payload.changes && typeof payload.changes === 'object' ? payload.changes : null;
  let files = [];
  if (changes) {
    files = Object.entries(changes).map(([p, c]) => ({ path: p, type: (c && c.type) || 'update', diff: c && c.unified_diff }));
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
          <div className="mt-1 space-y-1">
            {files.map((f, i) => (
              <div key={i}>
                <div className="text-xs font-mono truncate">
                  <span className={col[f.type] || 'text-gray-400'}>{mark[f.type] || '~'}</span>{' '}
                  <FileLink path={f.path} className="text-blue-400 hover:text-blue-300 underline">{f.path}</FileLink>
                </div>
                {f.diff && <div className="mt-0.5"><DiffView text={f.diff} /></div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Split a Claude record into a message part (user/assistant text) and a tool part
// (thinking + tool_use cards, or tool_result cards); toolCount = number of tool_use
// calls. Lets messages-only mode collapse a run of tool activity into one marker.
function claudeParts(rec, ctx) {
  if (rec.type === 'assistant') {
    const content = rec.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const msg = [];
    const tool = [];
    let toolCount = 0;
    blocks.forEach((block, i) => {
      if (!block) return;
      const key = `${rec.uuid}-${i}`;
      if (block.type === 'text') {
        if (block.text && block.text.trim()) msg.push(<Markdown key={key}>{block.text}</Markdown>);
      } else if (block.type === 'thinking') {
        tool.push(<ThinkingBlock key={key} text={block.thinking} />);
      } else if (block.type === 'tool_use') {
        toolCount += 1;
        if (block.name === 'AskUserQuestion') {
          const rt = ctx && ctx.results ? ctx.results[block.id] : undefined;
          const answered = rt !== undefined;
          tool.push(<QuestionCard key={key} block={block} answered={answered} chosen={answered ? parseAnswers(rt) : null} onAnswer={ctx && ctx.onAnswer} />);
        } else {
          tool.push(<ToolUseCard key={key} block={block} />);
        }
      }
    });
    return {
      message: msg.length ? <div className="flex justify-start"><div className="min-w-0 max-w-[92%] space-y-1">{msg}</div></div> : null,
      tool: tool.length ? <div className="flex justify-start"><div className="min-w-0 max-w-[92%] space-y-1">{tool}</div></div> : null,
      toolCount,
    };
  }
  if (rec.type === 'user') {
    if (rec.isMeta) return { message: null, tool: null, toolCount: 0 };
    const content = rec.message?.content;
    const hasToolResult = Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
    if (hasToolResult) return { message: null, tool: renderToolResults(rec, ctx), toolCount: 0 };
    return { message: renderUserPrompt(rec), tool: null, toolCount: 0 };
  }
  return { message: null, tool: null, toolCount: 0 };
}

// The same message/tool split for a single Codex record.
function codexPart(rec, ctx) {
  const p = rec.payload || {};
  if (rec.type === 'event_msg' && p.type === 'user_message' && p.message) {
    return {
      message: (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[85%] rounded-lg bg-blue-600/20 border border-blue-500/30 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-blue-300/70 mb-0.5">you</div>
            <Markdown>{p.message}</Markdown>
          </div>
        </div>
      ),
      tool: null, toolCount: 0,
    };
  }
  if (rec.type === 'event_msg' && p.type === 'agent_message' && p.message) {
    return { message: <div className="flex justify-start"><div className="min-w-0 max-w-[92%] space-y-1"><Markdown>{p.message}</Markdown></div></div>, tool: null, toolCount: 0 };
  }
  if (rec.type === 'response_item' && p.type === 'custom_tool_call') {
    if (codexToolName(p.input) === 'apply_patch') return { message: null, tool: null, toolCount: 0 };
    return { message: null, tool: <CodexToolCard input={p.input} />, toolCount: 1 };
  }
  if (rec.type === 'response_item' && p.type === 'custom_tool_call_output') {
    // Pass the raw output through so ToolResultCard renders embedded images
    // (Codex view_image / script plots come back as input_image data URLs), not
    // just the text. Skip only when there's neither text nor an image.
    const out = p.output;
    const hasImage = Array.isArray(out) && out.some((b) => b && ((b.type === 'input_image' && b.image_url) || (b.type === 'image' && b.source)));
    if (!codexOutputText(out).trim() && !hasImage) return { message: null, tool: null, toolCount: 0 };
    return { message: null, tool: <ToolResultCard result={{ content: out }} onImage={ctx && ctx.onImage} />, toolCount: 0 };
  }
  if (rec.type === 'event_msg' && p.type === 'patch_apply_end') {
    return { message: null, tool: <CodexPatchCard payload={p} />, toolCount: 1 };
  }
  return { message: null, tool: null, toolCount: 0 };
}

// In messages-only mode a run of hidden tool activity collapses into this clickable
// marker; click to expand the real tool cards inline.
function CollapsedToolGroup({ count, children }) {
  const [open, setOpen] = useState(false);
  const label = count > 0 ? `${count} tool call${count === 1 ? '' : 's'}` : 'tool activity';
  return (
    <div className="flex justify-start my-0.5">
      <div className="min-w-0 max-w-[92%] w-full">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 border border-gray-700/70 rounded-full px-2 py-0.5 transition-colors"
        >
          <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
          </svg>
          {label}
        </button>
        {open && <div className="mt-1 space-y-1">{children}</div>}
      </div>
    </div>
  );
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);

// In-app file viewer for a working-dir file: markdown rendered via the safe
// <Markdown> pipeline, other text as a mono block, images/PDF inline; everything
// has a Download button (?download=1 forces an attachment).
function FileViewer({ agentId, path, onClose, variant = 'modal' }) {
  const [text, setText] = useState(null);
  const [err, setErr] = useState(null);
  const name = String(path).split('/').pop();
  const ext = fileExt(path);
  const isImage = IMAGE_EXTS.has(ext);
  const isPdf = ext === 'pdf';
  const isMd = ext === 'md' || ext === 'markdown';
  // Text-ish: a known text/code ext, or a dotless name (Dockerfile, LICENSE, …).
  const isTextish = !isImage && !isPdf && (VIEWER_EXTS.has(ext) || !name.includes('.'));
  const url = `/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(path)}`;
  const dlUrl = `${url}&download=1`;
  useEffect(() => {
    if (!isTextish) return; // images/pdf render by URL; binary is download-only
    let cancelled = false;
    setText(null);
    setErr(null);
    fetch(url)
      .then((r) => {
        if (r.ok) return r.text();
        const msg = r.status === 404 ? 'File not found'
          : r.status === 403 ? 'Path is outside the allowed directory'
          : `Request failed (HTTP ${r.status})`;
        return Promise.reject(new Error(msg));
      })
      .then((t) => { if (!cancelled) setText(t); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [url, isTextish]);

  const popOut = () => { try { window.open(url, '_blank', 'noopener'); } catch { /* blocked */ } };

  const header = (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700 flex-shrink-0">
      <span className="text-sm text-gray-200 font-mono truncate flex-1 min-w-0" title={path}>{name}</span>
      <a href={dlUrl} download={name} className="flex items-center gap-1 text-xs text-gray-300 hover:text-white" title="Download file">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
        </svg>
        Download
      </a>
      <button type="button" onClick={popOut} title="Open in a new tab" className="text-gray-400 hover:text-white">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </button>
      <button type="button" onClick={onClose} title="Close" className="text-gray-400 hover:text-white">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );

  const body = (
    <div className="flex-1 min-h-0 overflow-auto p-4">
      {isImage ? (
        <img src={url} alt={name} className="max-w-full mx-auto rounded" />
      ) : isPdf ? (
        <iframe src={url} title={name} className="w-full h-[80vh] rounded bg-white" />
      ) : !isTextish ? (
        <div className="text-gray-400 text-sm text-center py-8">No preview for this file type — use Download above.</div>
      ) : err ? (
        <div className="text-sm">
          <div className="text-red-400">{err}</div>
          <div className="text-gray-500 mt-1 font-mono text-xs break-all">{path}</div>
          <div className="text-gray-500 mt-2 text-xs">
            Relative paths are resolved against the agent&apos;s working directory. If the agent
            referenced a file in a different directory, use its full path.
          </div>
        </div>
      ) : text == null ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : isMd ? (
        <Markdown>{text}</Markdown>
      ) : (
        <pre className="text-xs font-mono text-gray-300 whitespace-pre-wrap break-words">{text}</pre>
      )}
    </div>
  );

  // Desktop: a full-height panel docked beside the chat. Mobile: a modal overlay.
  if (variant === 'panel') {
    return (
      <div
        className="flex flex-col h-full min-w-0 flex-shrink-0 bg-gray-900 border-l border-gray-700"
        style={{ width: '42%', minWidth: 320, maxWidth: 760 }}
      >
        {header}
        {body}
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {header}
        {body}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

function ChatView({ agentId, session }) {
  const { sendAgentInput, answerAgentQuestion, getAgentPane, agentStates, agents } = useApp();
  // Desktop docks the file viewer as a side panel; mobile uses a modal (no room to dock).
  const isDesktop = useMediaQuery('(min-width: 768px)');

  // Which provider's transcript format to render (Claude vs Codex). Kept in a ref
  // too, so the long-lived WebSocket onmessage closure dedupes with the right key.
  const provider = useMemo(
    () => (agents || []).find((a) => String(a.id) === String(agentId))?.config?.provider || 'claude',
    [agents, agentId]
  );
  const providerRef = useRef('claude');
  providerRef.current = provider;

  // Open a working-dir file in the in-app viewer; provided to file links via context.
  const openFile = useCallback((path) => setFileViewerPath(path), []);
  const chatCtx = useMemo(() => ({ agentId, openFile }), [agentId, openFile]);

  const [records, setRecords] = useState([]);
  const [connected, setConnected] = useState(false);
  const [banner, setBanner] = useState(null); // { type: 'error' | 'end', message }
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [pendingSent, setPendingSent] = useState(false);
  // Files attached to the next message: each { id, name, size, status, path?, error? }.
  // Uploaded into the agent's working dir; the sent message references them by path.
  const [attachments, setAttachments] = useState([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);
  // Hidden until the initial history burst settles, so we reveal already pinned
  // at the bottom instead of visibly scrolling through the whole transcript.
  const [ready, setReady] = useState(false);
  const [lightbox, setLightbox] = useState(null); // full-size image src, or null
  const [fileViewerPath, setFileViewerPath] = useState(null); // in-app file viewer, or null
  // "Messages only" hides all tool activity (calls, results, diffs, thinking); persisted.
  const [messagesOnly, setMessagesOnly] = useState(() => {
    try { return localStorage.getItem('maestro-chat-messages-only') === '1'; } catch { return false; }
  });
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
  }, [records, isWorking, activityLabel, activePrompt, atStart, messagesOnly]);

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
  // Upload each picked/dropped file into the agent's working dir. Uses XHR (not fetch)
  // so large files show live progress instead of an indefinite spinner.
  const uploadFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setSendError(null);
    for (const file of files) {
      const id = `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 8)}`;
      setAttachments((a) => [...a, { id, name: file.name, size: file.size, status: 'uploading', progress: 0, path: null }]);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/agents/${encodeURIComponent(agentId)}/upload?name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        setAttachments((a) => a.map((x) => (x.id === id && x.status === 'uploading' ? { ...x, progress: pct } : x)));
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          setAttachments((a) => a.map((x) => (x.id === id ? { ...x, status: 'done', name: data.name || x.name, path: data.path, progress: 100 } : x)));
        } else {
          setAttachments((a) => a.map((x) => (x.id === id ? { ...x, status: 'error', error: data.error || `Upload failed (${xhr.status})` } : x)));
        }
      };
      xhr.onerror = () => setAttachments((a) => a.map((x) => (x.id === id ? { ...x, status: 'error', error: 'Network error during upload' } : x)));
      xhr.onabort = () => setAttachments((a) => a.filter((x) => x.id !== id));
      xhr.send(file);
    }
  }, [agentId]);

  const removeAttachment = useCallback((id) => {
    setAttachments((a) => a.filter((x) => x.id !== id));
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const ready = attachments.filter((a) => a.status === 'done' && a.path);
    const uploading = attachments.some((a) => a.status === 'uploading');
    if (sending || uploading) return;
    if (!text && ready.length === 0) return;
    setSending(true);
    setSendError(null);
    // Reference each uploaded file by its working-dir path so the agent can open it.
    // Claude auto-reads @-mentioned files; Codex just needs the path.
    const ref = (p) => (provider === 'codex' ? p : `@${p}`);
    let composed = text;
    if (ready.length) {
      const list = ready.map((a) => ref(a.path)).join('\n');
      composed = composed ? `${composed}\n\nAttached file(s):\n${list}` : `Attached file(s):\n${list}`;
    }
    try {
      await sendAgentInput(agentId, composed);
      setInput('');
      setAttachments([]);
      setPendingSent(true);
    } catch (err) {
      setSendError(err.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  }, [input, attachments, sending, sendAgentInput, agentId, provider]);

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
    // Map each answered tool_use_id -> its result text (Claude AskUserQuestion).
    const results = {};
    if (provider !== 'codex') {
      records.forEach((rec) => {
        const c = rec.message?.content;
        if (Array.isArray(c)) {
          c.forEach((b) => {
            if (b && b.type === 'tool_result' && b.tool_use_id) {
              results[b.tool_use_id] = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            }
          });
        }
      });
    }
    const ctx = { onImage: setLightbox, onAnswer: onAnswerQuestion, results };
    const partsOf = provider === 'codex' ? codexPart : claudeParts;

    const out = [];
    let buf = [];
    let bufCount = 0;
    const flushTools = () => {
      if (buf.length) {
        out.push(<CollapsedToolGroup key={`tg-${out.length}`} count={bufCount}>{buf}</CollapsedToolGroup>);
        buf = [];
        bufCount = 0;
      }
    };
    records.forEach((rec, idx) => {
      if (!rec || typeof rec !== 'object') return;
      const pt = partsOf(rec, ctx);
      if (!pt.message && !pt.tool) return;
      const rkey = rec.uuid || (rec.payload ? codexKey(rec) : idx);
      const dim = rec.isSidechain ? 'opacity-70' : '';
      if (messagesOnly) {
        // Collapse a run of tool activity into one clickable marker between messages.
        if (pt.message) { flushTools(); out.push(<div key={`m-${rkey}`} className={dim}>{pt.message}</div>); }
        if (pt.tool) { buf.push(<div key={`t-${rkey}`} className={dim}>{pt.tool}</div>); bufCount += pt.toolCount || 0; }
      } else {
        if (pt.message) out.push(<div key={`m-${rkey}`} className={dim}>{pt.message}</div>);
        if (pt.tool) out.push(<div key={`t-${rkey}`} className={dim}>{pt.tool}</div>);
      }
    });
    if (messagesOnly) flushTools();
    return out;
  }, [records, onAnswerQuestion, provider, messagesOnly]);

  return (
    <ChatAgentContext.Provider value={chatCtx}>
    <div className="relative h-full w-full flex bg-gray-900">
      <div className="relative flex-1 min-w-0 flex flex-col bg-gray-900">
      {/* Filter toggle: hide all tool activity, show only the conversation */}
      <button
        type="button"
        onClick={() =>
          setMessagesOnly((v) => {
            const nv = !v;
            try { localStorage.setItem('maestro-chat-messages-only', nv ? '1' : '0'); } catch { /* ignore */ }
            return nv;
          })
        }
        title={messagesOnly ? 'Show tool calls' : 'Hide tool calls — show only messages'}
        className={`absolute top-2 right-2 z-20 flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-sm transition-colors ${
          messagesOnly
            ? 'border-blue-500/60 bg-blue-600/40 text-blue-100'
            : 'border-gray-700 bg-gray-800/85 text-gray-400 hover:text-gray-200'
        }`}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        Messages only
      </button>
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
      <div
        className={`flex-shrink-0 border-t bg-gray-800 p-2 transition-colors ${dragging ? 'border-blue-500 bg-blue-500/5' : 'border-gray-700'}`}
        onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); }}
      >
        {sendError && <div className="text-xs text-red-400 mb-1">{sendError}</div>}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {attachments.map((a) => (
              <span
                key={a.id}
                title={a.status === 'error' ? a.error : (a.path || a.name)}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs border ${a.status === 'error' ? 'border-red-500/50 bg-red-500/10 text-red-300' : 'border-gray-600 bg-gray-900 text-gray-300'}`}
              >
                {a.status === 'uploading' ? (
                  <svg className="w-3 h-3 animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                ) : a.status === 'error' ? (
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                ) : (
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                )}
                <span className="max-w-[160px] truncate">{a.name}</span>
                {a.status === 'uploading' && typeof a.progress === 'number' && (
                  <span className="text-gray-500 tabular-nums">{a.progress}%</span>
                )}
                <button type="button" onClick={() => removeAttachment(a.id)} className="text-gray-500 hover:text-gray-200" title="Remove">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 w-full min-w-0">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            title="Attach files"
            aria-label="Attach files"
            className="flex-shrink-0 self-end p-2 text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
          </button>
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
            disabled={sending || attachments.some((a) => a.status === 'uploading') || (!input.trim() && !attachments.some((a) => a.status === 'done'))}
            className="flex-shrink-0 px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? '…' : 'Send'}
          </button>
        </div>
      </div>
      </div>{/* end chat column */}

      {/* Desktop: the file viewer docks as a side panel next to the chat */}
      {fileViewerPath && isDesktop && (
        <FileViewer variant="panel" agentId={agentId} path={fileViewerPath} onClose={() => setFileViewerPath(null)} />
      )}

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

      {/* Mobile: the file viewer is a modal overlay (not enough room to dock) */}
      {fileViewerPath && !isDesktop && (
        <FileViewer variant="modal" agentId={agentId} path={fileViewerPath} onClose={() => setFileViewerPath(null)} />
      )}
    </div>
    </ChatAgentContext.Provider>
  );
}

export default ChatView;
