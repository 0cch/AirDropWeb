import { useRef, useState, useCallback } from 'react';

const CHUNK_SIZE = 16 * 1024; // 16KB per chunk
const ICE_SERVERS = {
  iceServers: [
    // 国内 STUN 优先（低延迟）
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' },
    // Google STUN 兜底（海外用户）
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

export function useWebRTC(
  sendSignal: (data: any) => void,
  onSignal: (cb: (data: any) => void) => void,
  myRole: 'sender' | 'receiver' | null
) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const [dcReady, setDcReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [transferStatus, setTransferStatus] = useState<'idle' | 'sending' | 'receiving' | 'done' | 'error'>('idle');
  const [receivedFile, setReceivedFile] = useState<{ meta: FileMeta; blob: Blob } | null>(null);

  // 接收缓冲
  const recvBufRef = useRef<ArrayBuffer[]>([]);
  const recvMetaRef = useRef<FileMeta | null>(null);
  const recvSizeRef = useRef(0);

  const initPeer = useCallback(() => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({ type: 'ice', candidate: e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        setTransferStatus('error');
      }
    };

    // sender 创建 DataChannel
    if (myRole === 'sender') {
      const dc = pc.createDataChannel('file-transfer', { ordered: true });
      setupDataChannel(dc);
    }

    // receiver 监听 DataChannel
    pc.ondatachannel = (e) => {
      setupDataChannel(e.channel);
    };

    return pc;
  }, [myRole, sendSignal]);

  const setupDataChannel = useCallback((dc: RTCDataChannel) => {
    dcRef.current = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = CHUNK_SIZE * 4;

    dc.onopen = () => {
      setDcReady(true);
    };
    dc.onclose = () => {
      setDcReady(false);
    };
    dc.onerror = () => {
      setTransferStatus('error');
    };

    dc.onmessage = (e) => {
      const data = e.data;
      if (typeof data === 'string') {
        // 文件元信息
        const meta: FileMeta = JSON.parse(data);
        recvMetaRef.current = meta;
        recvBufRef.current = [];
        recvSizeRef.current = 0;
        setTransferStatus('receiving');
        setProgress(0);
      } else {
        // 文件数据块
        recvBufRef.current.push(data);
        recvSizeRef.current += data.byteLength;
        const meta = recvMetaRef.current;
        if (meta) {
          setProgress(Math.min(100, (recvSizeRef.current / meta.size) * 100));
          if (recvSizeRef.current >= meta.size) {
            const blob = new Blob(recvBufRef.current, { type: meta.type });
            setReceivedFile({ meta, blob });
            setTransferStatus('done');
            setProgress(100);
            // 重置
            recvBufRef.current = [];
            recvMetaRef.current = null;
            recvSizeRef.current = 0;
          }
        }
      }
    };
  }, []);

  // 创建 offer (sender)
  const createOffer = useCallback(async () => {
    const pc = pcRef.current || initPeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: 'offer', sdp: offer });
  }, [initPeer, sendSignal]);

  // 处理远端信号
  const handleSignal = useCallback(async (data: any) => {
    if (!data) return;
    const pc = pcRef.current || (myRole === 'receiver' ? initPeer() : null);
    if (!pc) return;

    if (data.type === 'offer') {
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(data.sdp);
    } else if (data.type === 'ice') {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (e) {
        // 忽略重复候选
      }
    }
  }, [myRole, initPeer, sendSignal]);

  // 注册信号处理
  onSignal(handleSignal);

  // 发送文件 — 使用 async 等待 + 缓冲背压控制
  const sendFile = useCallback(async (file: File) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;

    const meta: FileMeta = { name: file.name, size: file.size, type: file.type };
    dc.send(JSON.stringify(meta));
    setTransferStatus('sending');
    setProgress(0);

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let sentChunks = 0;

    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();

      // 背压控制：如果缓冲过多，等待 drain
      if (dc.bufferedAmount > CHUNK_SIZE * 16) {
        await new Promise<void>((resolve) => {
          const check = () => {
            if (dc.bufferedAmount < CHUNK_SIZE * 4) {
              resolve();
            } else {
              setTimeout(check, 5);
            }
          };
          check();
        });
      }

      dc.send(buf);
      sentChunks++;
      setProgress(Math.min(100, (sentChunks / totalChunks) * 100));
    }

    setTransferStatus('done');
    setProgress(100);
  }, []);

  const close = useCallback(() => {
    dcRef.current?.close();
    pcRef.current?.close();
    pcRef.current = null;
    dcRef.current = null;
    setDcReady(false);
  }, []);

  return {
    dcReady, progress, transferStatus, receivedFile,
    createOffer, sendFile, close, initPeer
  };
}
