import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';

const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000]; // Exponential backoff
const VISIBILITY_RECONNECT_DELAY = 300; // ms to wait after tab becomes visible before reconnecting
const MAX_QUICK_RETRIES = 3; // Retries for manual reconnect attempts
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 28;
const FONT_SIZE_KEY = 'terminal-font-size';

function getDefaultFontSize() {
  const stored = localStorage.getItem(FONT_SIZE_KEY);
  if (stored) return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parseInt(stored, 10)));
  // Larger default on mobile for readability
  return window.matchMedia('(max-width: 768px)').matches ? 16 : 14;
}

function useTerminal(sessionName) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  const currentSessionRef = useRef(null); // Track current session to detect changes
  const mountedRef = useRef(true); // Track if component is mounted
  const lastConnectTimeRef = useRef(0); // Track when we last connected
  const connectingRef = useRef(false); // Prevent multiple simultaneous connections
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [replaced, setReplaced] = useState(false);
  const [fontSize, setFontSize] = useState(getDefaultFontSize);
  const copyFlashTimeoutRef = useRef(null);
  const [copyFlash, setCopyFlash] = useState(false);
  const flashCopyRef = useRef(null);

  // Keep flash trigger ref up-to-date (so event listeners in initTerminal can use it)
  flashCopyRef.current = () => {
    setCopyFlash(true);
    if (copyFlashTimeoutRef.current) clearTimeout(copyFlashTimeoutRef.current);
    copyFlashTimeoutRef.current = setTimeout(() => setCopyFlash(false), 1200);
  };

  // Fit terminal and notify server of new size
  const fitTerminal = useCallback(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;

    try {
      fitAddonRef.current.fit();

      // Send resize to server if connected
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'resize',
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        }));
      }
    } catch (e) {
      // Ignore fit errors during transitions
    }
  }, []);

  // Initialize terminal
  const initTerminal = useCallback((container) => {
    if (!container || xtermRef.current) return;

    terminalRef.current = container;

    const xterm = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      fontSize: getDefaultFontSize(),
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "DejaVu Sans Mono", "Noto Sans Mono", "Courier New", monospace',
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.2,
      letterSpacing: 0,
      allowProposedApi: true,
      scrollback: 15000,
      smoothScrollDuration: 100,
      scrollSensitivity: 1,
      fastScrollSensitivity: 5,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(56, 139, 253, 0.4)',
        selectionForeground: '#ffffff',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
    });

    // Load addons (before open)
    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(unicode11Addon);
    xterm.loadAddon(webLinksAddon);
    xterm.loadAddon(searchAddon);

    // Activate Unicode 11 support
    xterm.unicode.activeVersion = '11';

    // Open terminal in container
    xterm.open(container);

    // Load CanvasAddon AFTER opening (GPU-accelerated rendering)
    try {
      const canvasAddon = new CanvasAddon();
      xterm.loadAddon(canvasAddon);
    } catch (e) {
      // Canvas addon may fail in some environments, terminal still works
      console.warn('CanvasAddon failed to load, using default renderer');
    }

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Fit after a short delay to ensure DOM is ready
    setTimeout(() => {
      fitAddon.fit();
    }, 50);

    // Handle terminal input
    xterm.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Handle resize from terminal
    xterm.onResize(({ cols, rows }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    // Auto-copy selection to clipboard on mouse up (Shift+drag to select in tmux)
    container.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = xterm.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).then(() => {
            if (flashCopyRef.current) flashCopyRef.current();
          }).catch(() => {});
        }
      }, 10);
    });

    // Keyboard shortcuts for copy/paste
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      // Copy: Ctrl+Shift+C or Cmd+C (Mac)
      if ((event.ctrlKey && event.shiftKey && event.code === 'KeyC') ||
          (isMac && event.metaKey && event.code === 'KeyC')) {
        const sel = xterm.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).then(() => {
            if (flashCopyRef.current) flashCopyRef.current();
          }).catch(() => {});
        }
        return false;
      }

      // Paste: Ctrl+Shift+V or Cmd+V (Mac)
      if ((event.ctrlKey && event.shiftKey && event.code === 'KeyV') ||
          (isMac && event.metaKey && event.code === 'KeyV')) {
        navigator.clipboard.readText().then(text => {
          if (text && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'input', data: text }));
          }
        }).catch(() => {});
        return false;
      }

      return true;
    });

    // Signal that terminal is ready
    setTerminalReady(true);
  }, []);

  // Connect to WebSocket with reconnection support
  const connectWebSocket = useCallback(() => {
    if (!sessionName || !terminalReady) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (connectingRef.current) return; // Already connecting
    connectingRef.current = true;

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal?session=${encodeURIComponent(sessionName)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      connectingRef.current = false;
      if (!mountedRef.current) return;
      setConnected(true);
      setError(null);
      reconnectAttemptRef.current = 0; // Reset on successful connect
      lastConnectTimeRef.current = Date.now(); // Track connection time

      // Fit and send size after connection
      setTimeout(() => {
        if (!mountedRef.current) return;
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          ws.send(JSON.stringify({
            type: 'resize',
            cols: xtermRef.current.cols,
            rows: xtermRef.current.rows,
          }));
        }
      }, 100);
    };

    ws.onclose = () => {
      connectingRef.current = false;
      if (!mountedRef.current) return;
      setConnected(false);
      wsRef.current = null;
      console.log(`Terminal WebSocket closed for ${sessionName}`);
    };

    ws.onerror = () => {
      connectingRef.current = false;
      if (!mountedRef.current) return;

      // Auto-retry with backoff for initial connections (e.g., visibility reconnect)
      const attempt = reconnectAttemptRef.current;
      if (attempt < RECONNECT_DELAYS.length) {
        const delay = RECONNECT_DELAYS[attempt];
        reconnectAttemptRef.current = attempt + 1;
        console.log(`Terminal connection failed, retrying in ${delay}ms (attempt ${attempt + 1})`);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current && currentSessionRef.current === sessionName) {
            connectWebSocket();
          }
        }, delay);
      } else {
        setError('Connection failed');
      }
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(event.data);
        if (!xtermRef.current) return;

        switch (data.type) {
          case 'output':
            // Decode base64 if encoding is specified
            let outputData = data.data;
            if (data.encoding === 'base64') {
              // Decode base64 to binary, then binary to UTF-8
              const binaryStr = atob(data.data);
              const bytes = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
              }
              outputData = new TextDecoder('utf-8').decode(bytes);
            }
            xtermRef.current.write(outputData);
            break;
          case 'ready':
            setReady(true);
            // Fit and send size when ready
            setTimeout(() => {
              fitTerminal();
              // Force send current size to trigger tmux redraw
              if (wsRef.current?.readyState === WebSocket.OPEN && xtermRef.current) {
                wsRef.current.send(JSON.stringify({
                  type: 'resize',
                  cols: xtermRef.current.cols,
                  rows: xtermRef.current.rows,
                }));
              }
            }, 50);
            break;
          case 'request_resize':
            // Server requests current size - send immediately
            if (xtermRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: 'resize',
                cols: xtermRef.current.cols,
                rows: xtermRef.current.rows,
              }));
            }
            break;
          case 'error':
            xtermRef.current.write(`\r\n\x1b[31mError: ${data.message}\x1b[0m\r\n`);
            break;
          case 'exit':
            xtermRef.current.write(`\r\n\x1b[33mSession ended (code: ${data.code})\x1b[0m\r\n`);
            break;
          case 'replaced':
            // Another tab took over this session - don't reconnect
            xtermRef.current.write(`\r\n\x1b[33m${data.message}\x1b[0m\r\n`);
            // Mark that we shouldn't reconnect and set replaced state
            currentSessionRef.current = null;
            setReplaced(true);
            break;
        }
      } catch (err) {
        // Ignore parse errors
      }
    };
  }, [sessionName, terminalReady, fitTerminal]);

  // Handle initial connection - only depends on sessionName and terminalReady
  useEffect(() => {
    if (!sessionName || !terminalReady) return;

    const isSessionChange = currentSessionRef.current && currentSessionRef.current !== sessionName;

    if (isSessionChange) {
      console.log(`Switching terminal from ${currentSessionRef.current} to ${sessionName}`);

      // Clean up existing connection
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }

      // Clear terminal
      if (xtermRef.current) {
        xtermRef.current.clear();
        xtermRef.current.write('\x1b[2J\x1b[H');
      }

      // Reset state
      if (mountedRef.current) {
        setConnected(false);
        setReady(false);
        setError(null);
        setReplaced(false);
      }
      reconnectAttemptRef.current = 0;
    }

    // Update current session ref
    currentSessionRef.current = sessionName;

    // Connect if not already connected
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      const connectTimer = setTimeout(() => {
        connectWebSocket();
      }, isSessionChange ? 50 : 0);

      return () => clearTimeout(connectTimer);
    }
  }, [sessionName, terminalReady]); // Removed connectWebSocket dependency

  // Cleanup only on unmount
  useEffect(() => {
    return () => {
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
  }, []);

  // Auto-reconnect when tab becomes visible (critical for mobile)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!sessionName || !terminalReady) return;
      if (replaced) return; // Don't auto-reconnect if replaced by another tab

      // Check if connection is dead or dying
      const ws = wsRef.current;
      const isDisconnected = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;

      if (isDisconnected) {
        console.log(`Tab visible, auto-reconnecting terminal: ${sessionName}`);

        // Small delay to let mobile browser fully resume network
        setTimeout(() => {
          if (!mountedRef.current) return;
          // Re-check - connection might have recovered during the delay
          const currentWs = wsRef.current;
          if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
            // Clean up any lingering connection state
            if (currentWs) {
              currentWs.onclose = null;
              currentWs.close();
              wsRef.current = null;
            }
            connectingRef.current = false;
            reconnectAttemptRef.current = 0;
            setError(null);
            connectWebSocket();
          }
        }, VISIBILITY_RECONNECT_DELAY);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [sessionName, terminalReady, replaced, connectWebSocket]);

  // Setup resize observer - only after terminal is ready
  useEffect(() => {
    if (!terminalReady) return;

    const container = terminalRef.current;
    if (!container) return;

    // Initial fit
    fitTerminal();

    let resizeTimeout;
    const resizeObserver = new ResizeObserver((entries) => {
      // Only fit if the container actually has dimensions
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => fitTerminal(), 50);
      }
    });

    resizeObserver.observe(container);
    window.addEventListener('resize', fitTerminal);

    return () => {
      clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      window.removeEventListener('resize', fitTerminal);
    };
  }, [terminalReady, fitTerminal]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyFlashTimeoutRef.current) clearTimeout(copyFlashTimeoutRef.current);
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // Send input to terminal (for global keyboard capture)
  const sendInput = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  // Focus the terminal
  const focusTerminal = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.focus();
    }
  }, []);

  // Send key sequences through the PTY (for scrolling in tmux/apps)
  const sendKeys = useCallback((sequence) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: sequence }));
    }
  }, []);

  // Simulate mouse wheel on the xterm element - this sends wheel events through
  // xterm.js's mouse handling, which converts them to escape sequences for tmux.
  // Same mechanism as desktop mouse wheel scrolling.
  const scrollWheel = useCallback((direction) => {
    const el = xtermRef.current?.element;
    if (!el) return;
    el.dispatchEvent(new WheelEvent('wheel', {
      deltaY: direction * 120,
      bubbles: true,
      cancelable: true,
    }));
  }, []);

  // Copy terminal selection to clipboard
  const copySelection = useCallback(async () => {
    if (!xtermRef.current) return false;
    const selection = xtermRef.current.getSelection();
    if (!selection) return false;
    try {
      await navigator.clipboard.writeText(selection);
      if (flashCopyRef.current) flashCopyRef.current();
      return true;
    } catch {
      return false;
    }
  }, []);

  // Paste from clipboard into terminal
  const pasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data: text }));
        return true;
      }
    } catch {
      // Clipboard access denied
    }
    return false;
  }, []);

  // Copy visible terminal screen to clipboard
  const copyScreen = useCallback(async () => {
    if (!xtermRef.current) return false;
    const buffer = xtermRef.current.buffer.active;
    const rows = xtermRef.current.rows;
    const startRow = buffer.viewportY;
    const lines = [];
    for (let i = startRow; i < startRow + rows; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    const text = lines.join('\n');
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      if (flashCopyRef.current) flashCopyRef.current();
      return true;
    } catch {
      return false;
    }
  }, []);

  // Change font size and refit
  const changeFontSize = useCallback((delta) => {
    if (!xtermRef.current) return;
    const newSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, xtermRef.current.options.fontSize + delta));
    xtermRef.current.options.fontSize = newSize;
    setFontSize(newSize);
    localStorage.setItem(FONT_SIZE_KEY, String(newSize));
    // Refit after font size change
    setTimeout(() => fitTerminal(), 10);
  }, [fitTerminal]);

  // Force reconnect with retry logic (e.g., after being replaced or mobile tab switch)
  const quickRetryRef = useRef(0);

  const reconnect = useCallback(() => {
    if (!sessionName || !terminalReady) return;

    // Cancel any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    // Reset state
    currentSessionRef.current = sessionName;
    reconnectAttemptRef.current = 0;
    quickRetryRef.current = 0;
    connectingRef.current = false; // Reset connecting lock
    setConnected(false);
    setReady(false);
    setError(null);
    setReplaced(false); // Clear replaced state on manual reconnect

    // Connect with retry wrapper
    const attemptConnect = () => {
      if (!mountedRef.current) return;

      const ws = new WebSocket(
        `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/terminal?session=${encodeURIComponent(sessionName)}`
      );
      wsRef.current = ws;
      connectingRef.current = true;

      // Reuse the same handlers as connectWebSocket but add retry on failure
      ws.onopen = () => {
        connectingRef.current = false;
        quickRetryRef.current = 0;
        if (!mountedRef.current) return;
        setConnected(true);
        setError(null);
        reconnectAttemptRef.current = 0;
        lastConnectTimeRef.current = Date.now();

        setTimeout(() => {
          if (!mountedRef.current) return;
          if (fitAddonRef.current && xtermRef.current) {
            fitAddonRef.current.fit();
            ws.send(JSON.stringify({
              type: 'resize',
              cols: xtermRef.current.cols,
              rows: xtermRef.current.rows,
            }));
          }
        }, 100);
      };

      ws.onclose = () => {
        connectingRef.current = false;
        if (!mountedRef.current) return;
        setConnected(false);
        wsRef.current = null;
      };

      ws.onerror = () => {
        connectingRef.current = false;
        if (!mountedRef.current) return;

        // Retry a few times with increasing delays (network may still be resuming)
        if (quickRetryRef.current < MAX_QUICK_RETRIES) {
          quickRetryRef.current++;
          const delay = quickRetryRef.current * 500;
          console.log(`Reconnect attempt failed, retrying in ${delay}ms (${quickRetryRef.current}/${MAX_QUICK_RETRIES})`);
          setError(`Retrying (${quickRetryRef.current}/${MAX_QUICK_RETRIES})...`);
          reconnectTimeoutRef.current = setTimeout(attemptConnect, delay);
        } else {
          setError('Connection failed');
        }
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data);
          if (!xtermRef.current) return;

          switch (data.type) {
            case 'output': {
              let outputData = data.data;
              if (data.encoding === 'base64') {
                const binaryStr = atob(data.data);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                  bytes[i] = binaryStr.charCodeAt(i);
                }
                outputData = new TextDecoder('utf-8').decode(bytes);
              }
              xtermRef.current.write(outputData);
              break;
            }
            case 'ready':
              setReady(true);
              setTimeout(() => {
                fitTerminal();
                if (wsRef.current?.readyState === WebSocket.OPEN && xtermRef.current) {
                  wsRef.current.send(JSON.stringify({
                    type: 'resize',
                    cols: xtermRef.current.cols,
                    rows: xtermRef.current.rows,
                  }));
                }
              }, 50);
              break;
            case 'request_resize':
              if (xtermRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                  type: 'resize',
                  cols: xtermRef.current.cols,
                  rows: xtermRef.current.rows,
                }));
              }
              break;
            case 'error':
              xtermRef.current.write(`\r\n\x1b[31mError: ${data.message}\x1b[0m\r\n`);
              break;
            case 'exit':
              xtermRef.current.write(`\r\n\x1b[33mSession ended (code: ${data.code})\x1b[0m\r\n`);
              break;
            case 'replaced':
              xtermRef.current.write(`\r\n\x1b[33m${data.message}\x1b[0m\r\n`);
              currentSessionRef.current = null;
              setReplaced(true);
              break;
          }
        } catch (err) {
          // Ignore parse errors
        }
      };
    };

    attemptConnect();
  }, [sessionName, terminalReady, fitTerminal]);

  return {
    initTerminal,
    connected,
    ready,
    error,
    replaced,
    fontSize,
    copyFlash,
    fitTerminal,
    sendInput,
    sendKeys,
    scrollWheel,
    focusTerminal,
    copySelection,
    copyScreen,
    pasteClipboard,
    changeFontSize,
    reconnect,
  };
}

export default useTerminal;
