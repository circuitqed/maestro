import React, { forwardRef, useRef, useImperativeHandle } from 'react';
import Terminal from './Terminal';
import ChatView from './ChatView';
import { useApp } from '../context/AppContext';

function ViewToggle({ mode, onChange }) {
  const base = 'px-2 py-0.5 rounded text-xs transition-colors';
  return (
    <div className="flex items-center rounded bg-gray-700 p-0.5">
      <button
        type="button"
        onClick={() => mode !== 'terminal' && onChange('terminal')}
        className={`${base} ${mode === 'terminal' ? 'bg-gray-900 text-white' : 'text-gray-400 hover:text-white'}`}
      >
        Terminal
      </button>
      <button
        type="button"
        onClick={() => mode !== 'chat' && onChange('chat')}
        className={`${base} ${mode === 'chat' ? 'bg-gray-900 text-white' : 'text-gray-400 hover:text-white'}`}
      >
        Chat
      </button>
    </div>
  );
}

const TerminalPanel = forwardRef(function TerminalPanel(
  { agentId, sessionName, hostId, mode = 'terminal', onClose },
  ref
) {
  const terminalRef = useRef(null);
  const { setViewMode } = useApp();

  // Expose terminal methods to parent (no-ops when the terminal isn't mounted)
  useImperativeHandle(ref, () => ({
    sendInput: (data) => terminalRef.current?.sendInput(data),
    focus: () => terminalRef.current?.focus(),
    reconnect: () => terminalRef.current?.reconnect(),
    get connected() { return terminalRef.current?.connected; },
    get ready() { return terminalRef.current?.ready; },
  }), []);

  const handleReconnect = () => {
    terminalRef.current?.reconnect();
  };

  const handleSelect = () => {
    terminalRef.current?.enterSelectMode();
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 w-full bg-gray-900 border-l border-gray-700">
      {/* Header - session name as title */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 bg-gray-800 border-b border-gray-700">
        <span className="text-white font-medium text-sm truncate min-w-0">{sessionName}</span>
        <div className="flex items-center gap-2 flex-shrink-0">
          {agentId != null && <ViewToggle mode={mode} onChange={setViewMode} />}
          {mode === 'terminal' && (
            <>
              <button
                onClick={handleSelect}
                className="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
                title="Select &amp; copy text"
              >
                Select
              </button>
              <button
                onClick={handleReconnect}
                className="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
                title="Reconnect"
              >
                ↻
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors flex-shrink-0"
            title="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body - terminal or chat */}
      <div className="flex-1 min-h-0 min-w-0 w-full">
        {mode === 'chat' ? (
          <ChatView key={agentId} agentId={agentId} session={sessionName} />
        ) : (
          <Terminal ref={terminalRef} sessionName={sessionName} hostId={hostId} showStatusBar={false} />
        )}
      </div>
    </div>
  );
});

export default TerminalPanel;
