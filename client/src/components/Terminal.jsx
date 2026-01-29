import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import useTerminal from '../hooks/useTerminal';
import '@xterm/xterm/css/xterm.css';

const Terminal = forwardRef(function Terminal({ sessionName, showStatusBar = true }, ref) {
  const containerRef = useRef(null);
  const { initTerminal, connected, ready, error, replaced, fitTerminal, sendInput, focusTerminal, reconnect } = useTerminal(sessionName);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    sendInput,
    focus: focusTerminal,
    connected,
    ready,
    replaced,
    reconnect,
  }), [sendInput, focusTerminal, connected, ready, replaced, reconnect]);

  useEffect(() => {
    if (containerRef.current) {
      initTerminal(containerRef.current);
    }
  }, [initTerminal]);

  // Refit when component becomes visible
  useEffect(() => {
    if (connected) {
      // Small delay to ensure layout is complete
      const timer = setTimeout(() => fitTerminal(), 100);
      return () => clearTimeout(timer);
    }
  }, [connected, fitTerminal]);

  return (
    <div className="h-full w-full flex flex-col" style={{ backgroundColor: '#0d1117' }}>
      {/* Status bar - optional */}
      {showStatusBar && (
        <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-gray-800/50 border-b border-gray-700/50 text-xs">
          <span className="text-gray-400 font-mono truncate">{sessionName}</span>
          <div className="flex items-center gap-2">
            {error && <span className="text-red-400">{error}</span>}
            {replaced ? (
              <>
                <button
                  onClick={reconnect}
                  className="px-2 py-0.5 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded transition-colors"
                >
                  Take Over
                </button>
                <span className="flex items-center gap-1.5 text-orange-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
                  Replaced
                </span>
              </>
            ) : !connected ? (
              <>
                <button
                  onClick={reconnect}
                  className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                >
                  Reconnect
                </button>
                <span className="flex items-center gap-1.5 text-yellow-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                  Disconnected
                </span>
              </>
            ) : (
              <span className="flex items-center gap-1.5 text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                {ready ? 'Connected' : 'Attaching...'}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Terminal container - must fill remaining space */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 min-w-0 overflow-hidden terminal-container"
        style={{ position: 'relative', width: '100%' }}
      />
    </div>
  );
});

export default Terminal;
