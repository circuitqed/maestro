import React, { useEffect, useState } from 'react';
import Terminal from './Terminal';
import ChatView from './ChatView';
import { useApp } from '../context/AppContext';

function ViewToggle({ mode, onChange }) {
  const base = 'px-2.5 py-1 rounded text-xs transition-colors';
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

function TerminalModal({ agentId, sessionName, hostId, mode = 'terminal', onClose }) {
  const { setViewMode } = useApp();
  const [viewportHeight, setViewportHeight] = useState(
    window.visualViewport?.height ?? window.innerHeight
  );

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Track visual viewport height to resize when mobile keyboard opens/closes
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const handleResize = () => {
      setViewportHeight(vv.height);
    };

    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-gray-900">
      {/* Inner container sized to visual viewport so content fits above keyboard */}
      <div className="flex flex-col" style={{ height: viewportHeight }}>
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 bg-gray-800 border-b border-gray-700">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors flex-shrink-0"
              title="Close"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <span className="text-gray-400 text-sm font-mono truncate">{sessionName}</span>
          </div>
          {agentId != null && <ViewToggle mode={mode} onChange={setViewMode} />}
        </div>

        {/* Body - terminal or chat */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {mode === 'chat' ? (
            <ChatView key={agentId} agentId={agentId} session={sessionName} />
          ) : (
            <Terminal sessionName={sessionName} hostId={hostId} />
          )}
        </div>
      </div>
    </div>
  );
}

export default TerminalModal;
