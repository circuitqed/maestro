import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';

const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000]; // Exponential backoff

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
      fontSize: 14,
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
      // Don't auto-reconnect - user can click reconnect button if needed
      console.log(`Terminal WebSocket closed for ${sessionName}`);
    };

    ws.onerror = () => {
      connectingRef.current = false;
      if (!mountedRef.current) return;
      setError('Connection failed');
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

  // No auto-reconnect on visibility change - user can click reconnect button

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

  // Force reconnect (e.g., after being replaced)
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
      wsRef.current.close();
      wsRef.current = null;
    }

    // Reset state
    currentSessionRef.current = sessionName;
    reconnectAttemptRef.current = 0;
    connectingRef.current = false; // Reset connecting lock
    setConnected(false);
    setReady(false);
    setError(null);
    setReplaced(false); // Clear replaced state on manual reconnect

    // Connect
    connectWebSocket();
  }, [sessionName, terminalReady, connectWebSocket]);

  return {
    initTerminal,
    connected,
    ready,
    error,
    replaced,
    fitTerminal,
    sendInput,
    focusTerminal,
    reconnect,
  };
}

export default useTerminal;
