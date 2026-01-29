import React, { forwardRef, useRef, useImperativeHandle } from 'react';
import Terminal from './Terminal';

const TerminalPanel = forwardRef(function TerminalPanel({ sessionName, onClose }, ref) {
  const terminalRef = useRef(null);

  // Expose terminal methods to parent
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

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 w-full bg-gray-900 border-l border-gray-700">
      {/* Header - session name as title */}
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
        <span className="text-white font-medium text-sm truncate">{sessionName}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReconnect}
            className="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
            title="Reconnect"
          >
            ↻
          </button>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors flex-shrink-0"
            title="Close terminal"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Terminal - flex-1 with min-h-0 and min-w-0 to allow proper sizing */}
      <div className="flex-1 min-h-0 min-w-0 w-full">
        <Terminal ref={terminalRef} sessionName={sessionName} showStatusBar={false} />
      </div>
    </div>
  );
});

export default TerminalPanel;
