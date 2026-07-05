import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react';
import useTerminal from '../hooks/useTerminal';
import useMediaQuery from '../hooks/useMediaQuery';
import '@xterm/xterm/css/xterm.css';

// Control characters / escape sequences
const KEYS = {
  TAB: '\t',
  CTRL_B: '\x02',
  CTRL_C: '\x03',
  CTRL_O: '\x0f',
  ESCAPE: '\x1b',
  PAGE_UP: '\x1b[5~',
  PAGE_DOWN: '\x1b[6~',
};

const Terminal = forwardRef(function Terminal({ sessionName, hostId, showStatusBar = true }, ref) {
  const containerRef = useRef(null);
  const scrollUpRef = useRef(null);
  const scrollDownRef = useRef(null);
  const escBtnRef = useRef(null);
  const {
    initTerminal, connected, ready, error, replaced, fontSize, copyFlash,
    fitTerminal, sendInput, sendKeys, scrollWheel, focusTerminal,
    copySelection, copyScreen, pasteClipboard, changeFontSize, reconnect,
    getBufferText,
  } = useTerminal(sessionName, hostId);
  const isMobile = useMediaQuery('(max-width: 767px)');
  const scrollIntervalRef = useRef(null);
  const [scrollControlsVisible, setScrollControlsVisible] = useState(false);
  const hideTimeoutRef = useRef(null);
  const [selectMode, setSelectMode] = useState(false);
  const [bufferText, setBufferText] = useState('');
  const bufferEndRef = useRef(null);

  const enterSelectMode = useCallback(() => {
    const text = getBufferText();
    setBufferText(text);
    setSelectMode(true);
    setTimeout(() => {
      if (bufferEndRef.current) {
        bufferEndRef.current.scrollTop = bufferEndRef.current.scrollHeight;
      }
    }, 50);
  }, [getBufferText]);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    sendInput,
    focus: focusTerminal,
    connected,
    ready,
    replaced,
    reconnect,
    enterSelectMode,
  }), [sendInput, focusTerminal, connected, ready, replaced, reconnect, enterSelectMode]);

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

  const stopScrolling = useCallback(() => {
    if (scrollIntervalRef.current) {
      clearInterval(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }
  }, []);

  // Use native DOM event listeners for scroll buttons - React synthetic events
  // rely on event delegation which can be broken by xterm.js stopPropagation calls
  const scrollWheelRef = useRef(scrollWheel);
  const sendKeysRef = useRef(sendKeys);
  const showControlsRef = useRef(showControls);
  const stopScrollingRef = useRef(stopScrolling);
  scrollWheelRef.current = scrollWheel;
  sendKeysRef.current = sendKeys;
  showControlsRef.current = showControls;
  stopScrollingRef.current = stopScrolling;

  useEffect(() => {
    const upBtn = scrollUpRef.current;
    const downBtn = scrollDownRef.current;
    const escBtn = escBtnRef.current;
    if (!upBtn || !downBtn || !escBtn) return;

    const startScroll = (direction) => {
      scrollWheelRef.current(direction);
      showControlsRef.current();
      scrollIntervalRef.current = setInterval(() => scrollWheelRef.current(direction), 100);
    };

    const handleUpStart = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      startScroll(-1);
    };
    const handleDownStart = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      startScroll(1);
    };
    const handleEnd = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      stopScrollingRef.current();
    };
    const handleEsc = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      sendKeysRef.current(KEYS.ESCAPE);
      showControlsRef.current();
    };

    // Use capture phase + native listeners to guarantee we get the event
    const opts = { capture: true, passive: false };
    upBtn.addEventListener('touchstart', handleUpStart, opts);
    upBtn.addEventListener('touchend', handleEnd, opts);
    upBtn.addEventListener('mousedown', handleUpStart, opts);
    upBtn.addEventListener('mouseup', handleEnd, opts);
    downBtn.addEventListener('touchstart', handleDownStart, opts);
    downBtn.addEventListener('touchend', handleEnd, opts);
    downBtn.addEventListener('mousedown', handleDownStart, opts);
    downBtn.addEventListener('mouseup', handleEnd, opts);
    escBtn.addEventListener('touchstart', handleEsc, opts);
    escBtn.addEventListener('mousedown', handleEsc, opts);

    return () => {
      upBtn.removeEventListener('touchstart', handleUpStart, opts);
      upBtn.removeEventListener('touchend', handleEnd, opts);
      upBtn.removeEventListener('mousedown', handleUpStart, opts);
      upBtn.removeEventListener('mouseup', handleEnd, opts);
      downBtn.removeEventListener('touchstart', handleDownStart, opts);
      downBtn.removeEventListener('touchend', handleEnd, opts);
      downBtn.removeEventListener('mousedown', handleDownStart, opts);
      downBtn.removeEventListener('mouseup', handleEnd, opts);
      escBtn.removeEventListener('touchstart', handleEsc, opts);
      escBtn.removeEventListener('mousedown', handleEsc, opts);
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scrollIntervalRef.current) clearInterval(scrollIntervalRef.current);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  // Shared style for toolbar buttons
  const toolBtn = 'h-9 px-2.5 flex items-center justify-center bg-gray-700 active:bg-gray-500 text-gray-200 rounded text-xs font-mono font-medium select-none whitespace-nowrap';

  return (
    <div className="h-full w-full flex flex-col relative" style={{ backgroundColor: '#0d1117' }}>
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
            {copyFlash && (
              <span className="text-green-400 font-medium animate-pulse">Copied!</span>
            )}
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

      {/* Terminal container */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative" onTouchStart={showControls}>
        <div
          ref={containerRef}
          className="terminal-container"
          style={{ position: 'absolute', inset: 0 }}
        />
      </div>

      {/* Floating scroll controls - positioned at top level, outside terminal container
          to avoid xterm.js touch event interception */}
      <div
        className={`absolute right-2 flex flex-col gap-1.5 transition-opacity duration-300 ${
          scrollControlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{
          top: '50%',
          transform: 'translateY(-50%)',
          zIndex: 9999,
          touchAction: 'manipulation',
        }}
      >
        <button
          ref={scrollUpRef}
          className="w-10 h-14 flex items-center justify-center bg-gray-700/80 hover:bg-gray-600/90 text-gray-300 rounded-lg active:bg-gray-500/90 select-none"
          style={{ touchAction: 'manipulation' }}
          title="Page Up"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
        <button
          ref={escBtnRef}
          className="w-10 h-9 flex items-center justify-center bg-blue-700/80 hover:bg-blue-600/90 text-blue-200 rounded-lg active:bg-blue-500/90 select-none text-xs font-medium"
          style={{ touchAction: 'manipulation' }}
          title="Escape"
        >
          ESC
        </button>
        <button
          ref={scrollDownRef}
          className="w-10 h-14 flex items-center justify-center bg-gray-700/80 hover:bg-gray-600/90 text-gray-300 rounded-lg active:bg-gray-500/90 select-none"
          style={{ touchAction: 'manipulation' }}
          title="Page Down"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Text selection overlay - renders buffer as native selectable text */}
      {selectMode && (
        <div
          className="absolute inset-0 z-50 flex flex-col"
          style={{ backgroundColor: '#0d1117' }}
        >
          <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700/50">
            <span className="text-xs text-gray-400">{isMobile ? 'Long-press to select text' : 'Click and drag to select text'}</span>
            <button
              onTouchStart={(e) => { e.preventDefault(); setSelectMode(false); }}
              onClick={() => setSelectMode(false)}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded"
            >
              Done
            </button>
          </div>
          <pre
            className="flex-1 min-h-0 p-3 text-sm leading-relaxed whitespace-pre-wrap break-all"
            style={{
              fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
              fontSize: `${fontSize}px`,
              color: '#e6edf3',
              userSelect: 'text',
              WebkitUserSelect: 'text',
              overflowY: 'scroll',
              WebkitOverflowScrolling: 'touch',
            }}
            ref={bufferEndRef}
          >
            {bufferText}
          </pre>
        </div>
      )}

      {/* Mobile toolbar - special keys + copy/paste */}
      {isMobile && (
        <div className="flex-shrink-0 flex items-center gap-1.5 px-2 py-1.5 bg-gray-800 border-t border-gray-700/50 overflow-x-auto">
          <button
            onTouchStart={(e) => { e.preventDefault(); sendKeys(KEYS.TAB); }}
            className={toolBtn}
          >
            Tab
          </button>
          <button
            onTouchStart={(e) => { e.preventDefault(); sendKeys(KEYS.CTRL_B); }}
            className={toolBtn}
          >
            ^B
          </button>
          <button
            onTouchStart={(e) => { e.preventDefault(); sendKeys(KEYS.CTRL_C); }}
            className={toolBtn}
          >
            ^C
          </button>
          <button
            onTouchStart={(e) => { e.preventDefault(); sendKeys(KEYS.CTRL_O); }}
            className={toolBtn}
          >
            ^O
          </button>
          <button
            onTouchStart={(e) => { e.preventDefault(); sendKeys(KEYS.ESCAPE); }}
            className={toolBtn}
          >
            Esc
          </button>
          <div className="w-px h-6 bg-gray-600 flex-shrink-0" />
          <button
            onTouchStart={(e) => { e.preventDefault(); enterSelectMode(); }}
            className={toolBtn}
          >
            Select
          </button>
          <button
            onTouchStart={(e) => { e.preventDefault(); copyScreen(); }}
            className={`${toolBtn} ${copyFlash ? '!bg-green-600 !text-white' : ''}`}
          >
            {copyFlash ? 'Copied' : 'Screen'}
          </button>
          <button
            onTouchStart={(e) => { e.preventDefault(); pasteClipboard(); }}
            className={toolBtn}
          >
            Paste
          </button>
        </div>
      )}
    </div>
  );
});

export default Terminal;
