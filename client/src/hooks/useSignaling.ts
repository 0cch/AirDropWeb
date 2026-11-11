import { useRef, useState, useCallback, useEffect } from 'react';

export type Role = 'sender' | 'receiver';
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type PeerConnectionState = 'connected' | 'reconnecting';

interface SignalingMessage {
  type: string;
  token?: string;
  role?: Role;
  data?: unknown;
  message?: string;
  expiresAt?: number | null;
  sessionId?: string;
  code?: string;
  matched?: boolean;
}

interface SignalingHandlers {
  onSignal?: (data: unknown) => void;
  onPeerLeft?: (message: string) => void;
  onSessionEnded?: (message: string) => void;
  onPeerStatus?: (state: PeerConnectionState) => void;
}

interface SessionCredentials {
  token: string;
  role: Role;
  sessionId: string;
}

export function useSignaling() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const shouldConnect = useRef(true);
  const roomActive = useRef(false);
  const roomIntent = useRef(false);
  const sessionRef = useRef<SessionCredentials | null>(null);
  const resumePending = useRef(false);
  const ignoredSockets = useRef(new WeakSet<WebSocket>());
  const handlersRef = useRef<SignalingHandlers>({});
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [peerState, setPeerState] = useState<PeerConnectionState>('connected');
  const [token, setToken] = useState<string | null>(null);
  const [roomExpiresAt, setRoomExpiresAt] = useState<number | null>(null);
  const [matched, setMatched] = useState(false);
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearResumeTimer = useCallback(() => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = null;
  }, []);

  const clearRoomState = useCallback(() => {
    roomActive.current = false;
    roomIntent.current = false;
    sessionRef.current = null;
    resumePending.current = false;
    clearResumeTimer();
    setToken(null);
    setRoomExpiresAt(null);
    setMatched(false);
    setMyRole(null);
    setPeerState('connected');
  }, [clearResumeTimer]);

  const failResume = useCallback((message: string) => {
    clearRoomState();
    setConnectionState(wsRef.current?.readyState === WebSocket.OPEN ? 'connected' : 'reconnecting');
    handlersRef.current.onSessionEnded?.(message);
  }, [clearRoomState]);

  const scheduleReconnect = useCallback(() => {
    if (!shouldConnect.current) return;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    const delay = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts.current));
    reconnectAttempts.current += 1;
    reconnectTimer.current = setTimeout(doConnectRef.current, delay);
  }, []);

  const doConnectRef = useRef<() => void>(() => {});

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
      if (sessionRef.current) {
        resumePending.current = true;
        setConnectionState('reconnecting');
        ws.send(JSON.stringify({ type: 'resume-room', ...sessionRef.current }));
        clearResumeTimer();
        resumeTimer.current = setTimeout(() => {
          if (resumePending.current) failResume('会话恢复超时，请重新配对');
        }, 8000);
      } else {
        setConnectionState('connected');
      }
      setError(null);
    };

    ws.onclose = () => {
      if (ignoredSockets.current.delete(ws)) return;
      if (wsRef.current === ws) wsRef.current = null;
      resumePending.current = false;
      clearResumeTimer();
      setConnectionState(shouldConnect.current ? 'reconnecting' : 'disconnected');

      if (roomIntent.current && !sessionRef.current) {
        clearRoomState();
        handlersRef.current.onSessionEnded?.('创建会话时连接中断，请重新配对');
      } else if (shouldConnect.current) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose performs retry and recovery.
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
        case 'room-joined': {
          if (typeof msg.token !== 'string' || typeof msg.sessionId !== 'string' || !msg.role) return;
          const credentials = { token: msg.token, role: msg.role, sessionId: msg.sessionId };
          sessionRef.current = credentials;
          roomActive.current = true;
          roomIntent.current = false;
          setToken(credentials.token);
          setMyRole(credentials.role);
          setRoomExpiresAt(typeof msg.expiresAt === 'number' ? msg.expiresAt : null);
          setConnectionState('connected');
          setPeerState('connected');
          break;
        }
        case 'room-resumed': {
          if (typeof msg.token !== 'string' || typeof msg.sessionId !== 'string' || !msg.role) return;
          sessionRef.current = { token: msg.token, role: msg.role, sessionId: msg.sessionId };
          roomActive.current = true;
          resumePending.current = false;
          clearResumeTimer();
          setToken(msg.token);
          setMyRole(msg.role);
          setRoomExpiresAt(typeof msg.expiresAt === 'number' ? msg.expiresAt : null);
          setMatched(Boolean(msg.matched));
          setConnectionState('connected');
          setPeerState('connected');
          setError(null);
          handlersRef.current.onPeerStatus?.('connected');
          break;
        }
        case 'matched':
          setMatched(true);
          break;
        case 'signal':
          handlersRef.current.onSignal?.(msg.data);
          break;
        case 'peer-reconnecting':
          setPeerState('reconnecting');
          handlersRef.current.onPeerStatus?.('reconnecting');
          break;
        case 'peer-reconnected':
          setPeerState('connected');
          handlersRef.current.onPeerStatus?.('connected');
          break;
        case 'peer-left':
          clearRoomState();
          handlersRef.current.onPeerLeft?.(msg.message || '对方已离开');
          break;
        case 'error':
          setError(msg.message || '未知错误');
          if (msg.code === 'resume-failed' || resumePending.current) {
            failResume(msg.message || '会话恢复失败，请重新配对');
          }
          break;
      }
    };
  }, [clearResumeTimer, failResume, scheduleReconnect]);

  doConnectRef.current = doConnect;

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
    if (wsRef.current?.readyState !== WebSocket.OPEN || resumePending.current) return false;
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
    clearResumeTimer();
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
  }, [clearResumeTimer, clearRoomState]);

  useEffect(() => {
    return () => {
      shouldConnect.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      clearResumeTimer();
      wsRef.current?.close();
    };
  }, [clearResumeTimer]);

  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_E2E !== '1') return;
    const testWindow = window as Window & {
      __airdropTest?: {
        dropSignaling?: () => void;
      };
    };
    testWindow.__airdropTest = {
      ...testWindow.__airdropTest,
      dropSignaling: () => wsRef.current?.close()
    };
    return () => {
      if (testWindow.__airdropTest) delete testWindow.__airdropTest.dropSignaling;
    };
  }, []);

  return {
    connected: connectionState === 'connected',
    connectionState,
    peerState,
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
