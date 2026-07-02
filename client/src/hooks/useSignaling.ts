import { useRef, useState, useCallback, useEffect } from 'react';

export type Role = 'sender' | 'receiver';

interface SignalingMessage {
  type: string;
  token?: string;
  role?: Role;
  data?: any;
  message?: string;
}

export function useSignaling() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const shouldConnect = useRef(true);
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [matched, setMatched] = useState(false);
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handlersRef = useRef<{
    onSignal?: (data: any) => void;
    onFileMeta?: (data: any) => void;
    onPeerLeft?: () => void;
  }>({});

  const connect = useCallback(() => {
    shouldConnect.current = true;
    reconnectAttempts.current = 0;
    doConnect();
  }, []);

  const doConnect = useCallback(() => {
    if (!shouldConnect.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;

    // 开发环境：直连信令服务器端口；生产环境：同源 /ws
    const isDev = import.meta.env.DEV;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = isDev
      ? `${proto}//${location.hostname}:8080/ws`
      : `${proto}//${location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttempts.current = 0;
      setError(null);
    };

    ws.onclose = () => {
      setConnected(false);
      setMatched(false);
      // 自动重连（指数退避，最大 30 秒）
      if (shouldConnect.current) {
        const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts.current));
        reconnectTimer.current = setTimeout(() => {
          reconnectAttempts.current++;
          doConnect();
        }, delay);
      }
    };

    ws.onerror = () => {
      // onclose 会处理重连
    };

    ws.onmessage = (event) => {
      const msg: SignalingMessage = JSON.parse(event.data);
      switch (msg.type) {
        case 'room-created':
          setToken(msg.token!);
          break;
        case 'room-joined':
          setToken(msg.token!);
          break;
        case 'matched':
          setMatched(true);
          break;
        case 'signal':
          handlersRef.current.onSignal?.(msg.data);
          break;
        case 'file-meta':
          handlersRef.current.onFileMeta?.(msg.data);
          break;
        case 'peer-left':
          handlersRef.current.onPeerLeft?.();
          break;
        case 'error':
          setError(msg.message || '未知错误');
          break;
      }
    };
  }, []);

  const createRoom = useCallback((role: Role) => {
    setMyRole(role);
    setError(null);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'create-room', role }));
    }
  }, []);

  const joinRoom = useCallback((role: Role, token: string) => {
    setMyRole(role);
    setError(null);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'join-room', role, token }));
    }
  }, []);

  const sendSignal = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'signal', data }));
    }
  }, []);

  const sendFileMeta = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'file-meta', data }));
    }
  }, []);

  const setHandlers = useCallback((handlers: {
    onSignal?: (data: any) => void;
    onFileMeta?: (data: any) => void;
    onPeerLeft?: () => void;
  }) => {
    handlersRef.current = { ...handlersRef.current, ...handlers };
  }, []);

  const reset = useCallback(() => {
    shouldConnect.current = false;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    setToken(null);
    setMatched(false);
    setError(null);
    setMyRole(null);
  }, []);

  useEffect(() => {
    return () => {
      shouldConnect.current = false;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      wsRef.current?.close();
    };
  }, []);

  return {
    connected, token, matched, myRole, error,
    connect, createRoom, joinRoom, sendSignal, sendFileMeta,
    setHandlers, reset, wsRef
  };
}
