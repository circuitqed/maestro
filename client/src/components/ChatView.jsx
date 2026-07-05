import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp } from '../context/AppContext';

const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000]; // Exponential backoff

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

const markdownComponents = {
  a: ({ node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 underline hover:text-blue-300"
    />
  ),
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

function Markdown({ children }) {
  return (
    <div className="text-sm text-gray-100 break-words min-w-0 max-w-full overflow-hidden">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children || ''}
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

function ToolResultCard({ result }) {
  const content = result.content;
  const parts = [];
  if (typeof content === 'string') {
    parts.push({ kind: 'text', text: content });
  } else if (Array.isArray(content)) {
    content.forEach((b) => {
      if (!b) return;
      if (b.type === 'text') {
        parts.push({ kind: 'text', text: b.text });
      } else if (b.type === 'image' && b.source?.type === 'base64') {
        parts.push({
          kind: 'image',
          src: `data:${b.source.media_type};base64,${b.source.data}`,
        });
      }
    });
  }
  if (parts.length === 0) return null;
  return (
    <div className="rounded border border-gray-700 bg-gray-900/60">
      <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-700/60">
        result
      </div>
      <div className="p-2 max-h-64 overflow-auto">
        {parts.map((p, i) =>
          p.kind === 'text' ? (
            <pre
              key={i}
              className="text-xs font-mono text-gray-300 whitespace-pre-wrap break-words"
            >
              {p.text}
            </pre>
          ) : (
            <img key={i} src={p.src} alt="tool result" className="max-w-full rounded my-1" />
          )
        )}
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

function renderAssistant(rec) {
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

function renderToolResults(rec) {
  const blocks = rec.message?.content;
  if (!Array.isArray(blocks)) return null;
  const results = blocks.filter((b) => b && b.type === 'tool_result');
  if (results.length === 0) return null;
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] w-full space-y-1">
        {results.map((r, i) => (
          <ToolResultCard key={`${rec.uuid}-${i}`} result={r} />
        ))}
      </div>
    </div>
  );
}

function renderRecord(rec) {
  if (rec.type === 'assistant') return renderAssistant(rec);
  if (rec.type === 'user') {
    if (rec.isMeta) return null;
    const content = rec.message?.content;
    const hasToolResult = Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
    if (hasToolResult) return renderToolResults(rec);
    return renderUserPrompt(rec);
  }
  return null;
}

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

function ChatView({ agentId, session }) {
  const { sendAgentInput, agentStates } = useApp();

  const [records, setRecords] = useState([]);
  const [connected, setConnected] = useState(false);
  const [banner, setBanner] = useState(null); // { type: 'error' | 'end', message }
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [pendingSent, setPendingSent] = useState(false);

  const wsRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  const mountedRef = useRef(true);
  const seenUuidsRef = useRef(new Set());
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);

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
        // All renderable message records carry a uuid; use it to dedupe across
        // reconnects (which replay history from the top). Drop uuid-less noise.
        if (!rec.uuid) return;
        if (seenUuidsRef.current.has(rec.uuid)) return;
        seenUuidsRef.current.add(rec.uuid);
        setRecords((prev) => [...prev, rec]);
      } else if (msg.type === 'error') {
        setBanner({ type: 'error', message: msg.message || 'Transcript error' });
      } else if (msg.type === 'end') {
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
  }, [agentId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
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
  }, [connect]);

  // --- Auto-scroll ----------------------------------------------------------
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distanceFromBottom < 80;
  }, []);

  // --- Working / activity indicator ----------------------------------------
  // The pane monitor (agentStates) reports 'busy' while the agent produces
  // output — the reliable "is it working" signal even with no terminal attached.
  // pendingSent bridges the brief gap right after sending, before the monitor
  // catches up.
  const isBusy = agentStates?.[agentId] === 'busy';
  const activityLabel = useMemo(() => deriveActivity(records), [records]);
  const isWorking = isBusy || pendingSent;

  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [records, isWorking, activityLabel]);

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

  const renderedRecords = useMemo(() => {
    const out = [];
    records.forEach((rec) => {
      const el = renderRecord(rec);
      if (!el) return;
      out.push(
        <div key={rec.uuid} className={rec.isSidechain ? 'opacity-70' : ''}>
          {el}
        </div>
      );
    });
    return out;
  }, [records]);

  return (
    <div className="h-full w-full flex flex-col bg-gray-900">
      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-2"
      >
        {renderedRecords.length === 0 && !isWorking ? (
          <div className="h-full flex items-center justify-center text-center text-sm text-gray-500 px-4">
            {connected
              ? 'No messages yet. Send something below to get started.'
              : 'Connecting to transcript…'}
          </div>
        ) : (
          <>
            {renderedRecords}
            {isWorking && <WorkingIndicator label={activityLabel} />}
          </>
        )}
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
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="flex-1 min-h-[38px] max-h-40 resize-y rounded bg-gray-900 border border-gray-600 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
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
    </div>
  );
}

export default ChatView;
