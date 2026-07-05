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
  const [viewport, setViewport] = useState(() => ({
    height: window.visualViewport?.height ?? window.innerHeight,
    offsetTop: window.visualViewport?.offsetTop ?? 0,
  }));

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Track the visual viewport so the modal follows the area above the mobile
  // keyboard. We need BOTH height and offsetTop: when the keyboard opens, iOS
  // scrolls the page and the visual viewport gains an offset — a fixed element
  // pinned to the layout-viewport top would otherwise slide off the top of the
  // screen, taking the input box with it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => setViewport({ height: vv.height, offsetTop: vv.offsetTop });
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
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
    <div
      className="fixed left-0 right-0 z-50 bg-gray-900 overflow-hidden"
      style={{ top: viewport.offsetTop, height: viewport.height }}
    >
      {/* Inner container fills the visible area above the keyboard */}
      <div className="flex flex-col h-full w-full overflow-hidden">
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
