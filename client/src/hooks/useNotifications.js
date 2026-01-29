import { useEffect, useRef, useCallback, useState } from 'react';

const NOTIFICATION_SOUND_URL = 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleREAnOTrjk0VF5HesGNIHCaLyrRlSSY1dM/PZD0pQ43R0l43NEaKy+dvPj9rmbvMfTsoVZe60ZZULDWNz8tdM0N8u8+ETz03h9bhY0YvVpzSuGslKWCj1dVzKy5wmNHeYzM9cq/R11c+Rm6jy+6sMChMm9HbcishcbTLwV8uQnW14MFfMEV2teLGYDBKfbrNl1YwRoXF3nEzPXi+6qdCGDuKzOFwND56wuxFJkF8v+dpND5+xO1FJ0eCx+1pOEKJzvJmND+JzPFoNkKQ0fBkNEGX1+9eLj6g3O1ZKkCk3uxTJj+o4ehNJUGr4ORMJT6u5eVJI0Gx5eVIIj+15uNGIj+35eFFIT+55t9CID+76Nw/ID+96tk7Hz+/69U2Hz/B7NIyHz/E7s0vHz/G78opHj/I8MUlHj/K8sEiHj/M870fHj/O9LkcHT/Q9LYaHT/S9bMXHT/U9rAVHT/W96wTHT/Y96kRHD/a+KYPHD/c+KQNHD/e+aELGz/g+Z0JGz/i+poHGz/k+pcFGj/m+5QEGD/o+5ECFj/q/I0AFL/s/IkA';

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]; // Exponential backoff

export function useNotifications(authenticated) {
  const wsRef = useRef(null);
  const audioRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  const [agentStates, setAgentStates] = useState({});
  const [soundEnabled, setSoundEnabled] = useState(() => {
    return localStorage.getItem('notificationSound') !== 'false';
  });
  const [connected, setConnected] = useState(false);

  // Initialize audio
  useEffect(() => {
    audioRef.current = new Audio(NOTIFICATION_SOUND_URL);
    audioRef.current.volume = 0.5;
  }, []);

  // Toggle sound preference
  const toggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const newValue = !prev;
      localStorage.setItem('notificationSound', String(newValue));
      return newValue;
    });
  }, []);

  // Play notification sound
  const playSound = useCallback(() => {
    if (soundEnabled && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {
        // Ignore autoplay errors
      });
    }
  }, [soundEnabled]);

  // Connect to notifications WebSocket with reconnection
  const connect = useCallback(() => {
    if (!authenticated) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/notifications`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Notifications WebSocket connected');
      setConnected(true);
      reconnectAttemptRef.current = 0; // Reset reconnect counter on successful connect
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'initial_states') {
          setAgentStates(data.states);
        } else if (data.type === 'agent_state_change') {
          setAgentStates((prev) => ({
            ...prev,
            [data.agentId]: data.state,
          }));

          // Play sound when agent becomes idle (finished working)
          if (data.state === 'idle' && data.previousState === 'busy') {
            playSound();

            // Also show browser notification if permitted
            if (Notification.permission === 'granted') {
              new Notification('Agent Ready', {
                body: `${data.sessionName} is waiting for input`,
                icon: '/favicon.ico',
              });
            }
          }
        }
      } catch (err) {
        console.error('Error parsing notification:', err);
      }
    };

    ws.onclose = () => {
      console.log('Notifications WebSocket disconnected');
      setConnected(false);
      wsRef.current = null;

      // Schedule reconnect with exponential backoff
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS.length - 1)];
      reconnectAttemptRef.current++;
      console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current})`);
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    };

    ws.onerror = (err) => {
      console.error('Notifications WebSocket error:', err);
    };
  }, [authenticated, playSound]);

  // Initial connection
  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // Reconnect when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && authenticated) {
        // Always force a fresh reconnect when tab becomes visible
        // WebSocket might appear OPEN but be stale
        console.log('Tab visible, forcing notifications reconnect...');

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

        // Reset and reconnect immediately
        reconnectAttemptRef.current = 0;
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [authenticated, connect]);

  // Request notification permission
  const requestPermission = useCallback(async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  }, []);

  return {
    agentStates,
    soundEnabled,
    toggleSound,
    connected,
    requestPermission,
  };
}
