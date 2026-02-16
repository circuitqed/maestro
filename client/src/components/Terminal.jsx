import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react';
import useTerminal from '../hooks/useTerminal';
import '@xterm/xterm/css/xterm.css';

// Escape sequences for terminal key events
const KEYS = {
  PAGE_UP: '\x1b[5~',
  PAGE_DOWN: '\x1b[6~',
  // tmux prefix (Ctrl+b) then q to exit copy mode
  EXIT_COPY_MODE: 'q',
};

const Terminal = forwardRef(function Terminal({ sessionName, showStatusBar = true }, ref) {
  const containerRef = useRef(null);
  const { initTerminal, connected, ready, error, replaced, fontSize, fitTerminal, sendInput, sendKeys, focusTerminal, changeFontSize, reconnect } = useTerminal(sessionName);
  const scrollIntervalRef = useRef(null);
  const [scrollControlsVisible, setScrollControlsVisible] = useState(false);
  const hideTimeoutRef = useRef(null);

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
      const timer = setTimeout(() => fitTerminal(), 100);
      return () => clearTimeout(timer);
    }
  }, [connected, fitTerminal]);

  // Show scroll controls on touch, hide after inactivity
  const showControls = useCallback(() => {
    setScrollControlsVisible(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => setScrollControlsVisible(false), 4000);
  }, []);

  // Continuous scroll on hold - sends PgUp/PgDown through the PTY
  const startScrolling = useCallback((key) => {
    sendKeys(key);
    showControls();
    scrollIntervalRef.current = setInterval(() => sendKeys(key), 200);
  }, [sendKeys, showControls]);

  const stopScrolling = useCallback(() => {
    if (scrollIntervalRef.current) {
      clearInterval(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scrollIntervalRef.current) clearInterval(scrollIntervalRef.current);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  return (
    <div className="h-full w-full flex flex-col" style={{ backgroundColor: '#0d1117' }}>
      {/* Status bar */}
      {showStatusBar && (
        <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-gray-800/50 border-b border-gray-700/50 text-xs">
          <span className="text-gray-400 font-mono truncate">{sessionName}</span>
          <div className="flex items-center gap-2">
            {/* Font size controls */}
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => changeFontSize(-1)}
                className="w-6 h-5 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                title="Decrease font size"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                </svg>
              </button>
              <span className="text-gray-500 w-6 text-center tabular-nums">{fontSize}</span>
              <button
                onClick={() => changeFontSize(1)}
                className="w-6 h-5 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                title="Increase font size"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>
            <span className="text-gray-600">|</span>
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

      {/* Terminal container with scroll controls */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative" onTouchStart={showControls}>
        <div
          ref={containerRef}
          className="terminal-container"
          style={{ position: 'absolute', inset: 0 }}
        />

        {/* Floating scroll controls - sends PgUp/PgDown through the PTY */}
        <div
          className={`absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1.5 z-10 transition-opacity duration-300 ${
            scrollControlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <button
            onTouchStart={(e) => { e.preventDefault(); startScrolling(KEYS.PAGE_UP); }}
            onTouchEnd={stopScrolling}
            onMouseDown={() => startScrolling(KEYS.PAGE_UP)}
            onMouseUp={stopScrolling}
            onMouseLeave={stopScrolling}
            className="w-10 h-14 flex items-center justify-center bg-gray-700/80 hover:bg-gray-600/90 text-gray-300 rounded-lg backdrop-blur-sm active:bg-gray-500/90 select-none"
            title="Page Up"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onTouchStart={(e) => { e.preventDefault(); sendKeys(KEYS.EXIT_COPY_MODE); showControls(); }}
            onClick={() => { sendKeys(KEYS.EXIT_COPY_MODE); showControls(); }}
            className="w-10 h-9 flex items-center justify-center bg-blue-700/80 hover:bg-blue-600/90 text-blue-200 rounded-lg backdrop-blur-sm active:bg-blue-500/90 select-none text-xs font-medium"
            title="Exit scroll mode (q)"
          >
            ESC
          </button>
          <button
            onTouchStart={(e) => { e.preventDefault(); startScrolling(KEYS.PAGE_DOWN); }}
            onTouchEnd={stopScrolling}
            onMouseDown={() => startScrolling(KEYS.PAGE_DOWN)}
            onMouseUp={stopScrolling}
            onMouseLeave={stopScrolling}
            className="w-10 h-14 flex items-center justify-center bg-gray-700/80 hover:bg-gray-600/90 text-gray-300 rounded-lg backdrop-blur-sm active:bg-gray-500/90 select-none"
            title="Page Down"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
});

export default Terminal;
