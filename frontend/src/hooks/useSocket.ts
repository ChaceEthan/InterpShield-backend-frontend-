import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { SOCKET_TRANSPORTS, SOCKET_URL } from '../config/socket';

interface UseSocketOptions {
  url?: string;
  enabled?: boolean;
  token?: string | null;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  onReconnect?: (attempt: number) => void;
}

interface SocketStatus {
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  attemptCount: number;
  lastError?: Error;
}

/**
 * Enterprise-grade Socket.IO hook with auto-reconnect, heartbeat, and recovery
 */
export const useSocket = (options: UseSocketOptions = {}) => {
  const {
    url = SOCKET_URL,
    enabled = true,
    token,
    onConnect,
    onDisconnect,
    onError,
    onReconnect,
  } = options;

  const socketRef = useRef<Socket | null>(null);
  const [status, setStatus] = useState<SocketStatus>({
    connected: false,
    connecting: false,
    reconnecting: false,
    attemptCount: 0,
  });
  const attemptCountRef = useRef(0);
  const heartbeatTimerRef = useRef<number | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  // Initialize socket
  const initSocket = useCallback(() => {
    if (!enabled || !url || socketRef.current) return;

    try {
      socketRef.current = io(url, {
        transports: [...SOCKET_TRANSPORTS],
        reconnection: true,
        reconnectionAttempts: 8,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        timeout: 20000,
        autoConnect: true,
        auth: token ? { token } : undefined,
        upgrade: true,
        rememberUpgrade: true,
        rejectUnauthorized: false,
      });

      // Connection established
      socketRef.current.on('connect', () => {
        attemptCountRef.current = 0;
        setStatus({
          connected: true,
          connecting: false,
          reconnecting: false,
          attemptCount: 0,
        });
        onConnect?.();

        // Start heartbeat
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = window.setInterval(() => {
          if (socketRef.current?.connected) {
            socketRef.current.emit('ping', { timestamp: Date.now() });
          }
        }, 30000);
      });

      // Connection paused
      socketRef.current.on('disconnect', (reason: string) => {
        if (heartbeatTimerRef.current) {
          clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
        }
        setStatus((prev) => ({
          ...prev,
          connected: false,
          reconnecting: reason !== 'io client namespace disconnect',
        }));
        onDisconnect?.(reason);
      });

      // Reconnecting
      socketRef.current.io.on('reconnect_attempt', () => {
        attemptCountRef.current += 1;
        setStatus((prev) => ({
          ...prev,
          connecting: true,
          reconnecting: true,
          attemptCount: attemptCountRef.current,
        }));
        onReconnect?.(attemptCountRef.current);
      });

      // Connection error
      socketRef.current.on('error', (error: any) => {
        const err = error instanceof Error ? error : new Error(String(error));
        setStatus((prev) => ({
          ...prev,
          lastError: err,
        }));
        onError?.(err);
      });

      // Listen for pong
      socketRef.current.on('pong', (data: any) => {
        if (data?.timestamp) {
          const latency = Date.now() - data.timestamp;
          // Emit latency event for monitoring
          socketRef.current?.emit('latency', { value: latency });
        }
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to initialize socket');
      setStatus((prev) => ({
        ...prev,
        lastError: err,
      }));
      onError?.(err);
    }
  }, [enabled, url, token, onConnect, onDisconnect, onError, onReconnect]);

  // Monitor visibility and reconnect on tab focus
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (document.hidden) return;

      // Reconnect when tab becomes visible
      if (!socketRef.current?.connected) {
        socketRef.current?.connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [enabled]);

  // Initialize on mount
  useEffect(() => {
    initSocket();
    return () => {
      cleanup();
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [initSocket, cleanup]);

  // Emit helper
  const emit = useCallback((event: string, ...args: any[]) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit(event, ...args);
      return true;
    }
    return false;
  }, []);

  // On listener helper
  const on = useCallback((event: string, handler: (...args: any[]) => void) => {
    if (!socketRef.current) return () => {};

    socketRef.current.on(event, handler);
    return () => {
      socketRef.current?.off(event, handler);
    };
  }, []);

  // Once listener helper
  const once = useCallback((event: string, handler: (...args: any[]) => void) => {
    if (!socketRef.current) return () => {};

    socketRef.current.once(event, handler);
    return () => {
      socketRef.current?.off(event, handler);
    };
  }, []);

  return {
    socket: socketRef.current,
    status,
    emit,
    on,
    once,
    disconnect: () => socketRef.current?.disconnect(),
    reconnect: () => socketRef.current?.connect(),
  };
};
