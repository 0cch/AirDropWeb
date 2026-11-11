import { useRef, useState, useCallback, useEffect } from 'react';

export type Role = 'sender' | 'receiver';
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface SignalingMessage {
  type: string;
  token?: string;
  role?: Role;
  data?: unknown;
  message?: string;
  expiresAt?: number;
}

interface SignalingHandlers {
  onSignal?: (data: unknown) => void;
  onPeerLeft?: (message: string) => void;
  onSessionEnded?: (message: string) => void;
}

export function useSignaling() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const shouldConnect = useRef(true);
  const roomActive = useRef(false);
  const roomIntent = useRef(false);
  const ignoredSockets = useRef(new WeakSet<WebSocket>());
  const handlersRef = useRef<SignalingHandlers>({});
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [token, setToken] = useState<string | null>(null);
  const [roomExpiresAt, setRoomExpiresAt] = useState<number | null>(null);
  const [matched, setMatched] = useState(false);
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearRoomState = useCallback(() => {
    roomActive.current = false;
    roomIntent.current = false;
    setToken(null);
    setRoomExpiresAt(null);
    setMatched(false);
    setMyRole(null);
  }, []);

  const doConnect = useCallback(() => {
    if (!shouldConnect.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;

    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;
    setConnectionState(reconnectAttempts.current > 0 ? 'reconnecting' : 'connecting');

    ws.onopen = () => {
      reconnectAttempts.current = 0;
      setConnectionState('connected');
      setError(null);
    };

    ws.onclose = () => {
      if (ignoredSockets.current.delete(ws)) return;
      if (wsRef.current === ws) wsRef.current = null;
      setConnectionState(shouldConnect.current ? 'reconnecting' : 'disconnected');
      setMatched(false);

      if (roomActive.current || roomIntent.current) {
        clearRoomState();
        handlersRef.current.onSessionEnded?.('与信令服务器的连接已断开，本次会话已结束');
      }

      if (shouldConnect.current) {
        const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts.current));
        reconnectAttempts.current += 1;
        reconnectTimer.current = setTimeout(doConnect, delay);
      }
    };

    ws.onerror = () => {
      // onclose performs the retry and session cleanup.
    };

    ws.onmessage = (event) => {
      let msg: SignalingMessage;
      try {
        const parsed = JSON.parse(event.data);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return;
        msg = parsed;
      } catch {
        setError('服务器返回了无法解析的消息');
        return;
      }

      switch (msg.type) {
        case 'room-created':
        case 'room-joined':
          if (typeof msg.token !== 'string') return;
          roomActive.current = true;
          setToken(msg.token);
          setRoomExpiresAt(typeof msg.expiresAt === 'number' ? msg.expiresAt : null);
          break;
        case 'matched':
          setMatched(true);
          break;
        case 'signal':
          handlersRef.current.onSignal?.(msg.data);
          break;
        case 'peer-left':
          clearRoomState();
          handlersRef.current.onPeerLeft?.(msg.message || '对方已离开');
          break;
        case 'error':
          setError(msg.message || '未知错误');
          break;
      }
    };
  }, [clearRoomState]);

  const connect = useCallback(() => {
    shouldConnect.current = true;
    reconnectAttempts.current = 0;
    doConnect();
  }, [doConnect]);

  const createRoom = useCallback((role: Role) => {
    roomIntent.current = true;
    setMyRole(role);
    setError(null);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'create-room', role }));
    } else {
      setError('尚未连接信令服务器');
    }
  }, []);

  const joinRoom = useCallback((role: Role, tokenValue: string) => {
    roomIntent.current = true;
    setMyRole(role);
    setError(null);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'join-room', role, token: tokenValue }));
    } else {
      setError('尚未连接信令服务器');
    }
  }, []);

  const sendSignal = useCallback((data: unknown) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    try {
      wsRef.current.send(JSON.stringify({ type: 'signal', data }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const setHandlers = useCallback((handlers: SignalingHandlers) => {
    handlersRef.current = { ...handlersRef.current, ...handlers };
  }, []);

  const reset = useCallback(() => {
    shouldConnect.current = false;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify({ type: 'leave-room' })); } catch {}
    }
    if (wsRef.current) {
      ignoredSockets.current.add(wsRef.current);
      wsRef.current.close();
    }
    wsRef.current = null;
    clearRoomState();
    setError(null);
    setConnectionState('disconnected');
  }, [clearRoomState]);

  useEffect(() => {
    return () => {
      shouldConnect.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return {
    connected: connectionState === 'connected',
    connectionState,
    token,
    roomExpiresAt,
    matched,
    myRole,
    error,
    connect,
    createRoom,
    joinRoom,
    sendSignal,
    setHandlers,
    reset
  };
}
