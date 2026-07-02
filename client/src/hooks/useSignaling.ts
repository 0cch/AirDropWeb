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
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setMatched(false);
    };
    ws.onerror = () => setError('连接服务器失败');

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
    setToken(null);
    setMatched(false);
    setError(null);
    setMyRole(null);
  }, []);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  return {
    connected, token, matched, myRole, error,
    connect, createRoom, joinRoom, sendSignal, sendFileMeta,
    setHandlers, reset, wsRef
  };
}
