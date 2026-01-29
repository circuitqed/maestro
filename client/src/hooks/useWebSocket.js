import { useEffect, useRef, useState, useCallback } from 'react';

function useWebSocket(url, options = {}) {
  const { onMessage, onError, onOpen, onClose, autoConnect = true } = options;

  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = url.startsWith('ws') ? url : `${protocol}//${window.location.host}${url}`;

      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        setConnected(true);
        setError(null);
        onOpen?.();
      };

      wsRef.current.onclose = (event) => {
        setConnected(false);
        onClose?.(event);
      };

      wsRef.current.onerror = (event) => {
        setError('WebSocket connection error');
        onError?.(event);
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessage?.(data);
        } catch (err) {
          // If not JSON, pass raw data
          onMessage?.(event.data);
        }
      };
    } catch (err) {
      setError(err.message);
    }
  }, [url, onMessage, onError, onOpen, onClose]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      wsRef.current.send(message);
    }
  }, []);

  useEffect(() => {
    if (autoConnect && url) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [url, autoConnect, connect, disconnect]);

  return { connected, error, send, connect, disconnect };
}

export default useWebSocket;
