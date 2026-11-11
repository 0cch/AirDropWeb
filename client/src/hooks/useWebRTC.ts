import { useRef, useState, useCallback, useEffect } from 'react';
import {
  CHUNK_SIZE,
  MAX_FILES_PER_BATCH,
  MAX_IN_MEMORY_FILE_SIZE,
  createTransferId,
  fileMetaOf,
  makeUniqueFileNames,
  parseControl,
  type ConnectionRoute,
  type ControlMessage,
  type FileMeta,
  type QueueFileMeta,
  type ReceivedFile,
  type TransferQueueItem,
  type TransferStats
} from '../lib/transferProtocol';

export { MAX_IN_MEMORY_FILE_SIZE, parseControl } from '../lib/transferProtocol';
export type { FileMeta, ReceivedFile, TransferStats, ConnectionRoute, QueueFileMeta, TransferQueueItem } from '../lib/transferProtocol';

const MAX_BUFFERED_BYTES = CHUNK_SIZE * 8;
const LOW_BUFFER_BYTES = CHUNK_SIZE * 2;
const INITIAL_CREDIT_CHUNKS = 16;
const CREDIT_BATCH_CHUNKS = 4;
const CONNECTION_TIMEOUT_MS = 20_000;
const TRANSFER_TIMEOUT_MS = 30_000;
const ACCEPT_TIMEOUT_MS = 60_000;

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export type TransferStatus =
  | 'idle'
  | 'awaiting-accept'
  | 'sending'
  | 'receiving'
  | 'paused'
  | 'recovering'
  | 'done'
  | 'cancelled'
  | 'error';

interface WritableFileStreamLike {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableFileStreamLike>;
}

interface DirectoryHandleLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

type SaveFilePicker = (options?: {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<FileHandleLike>;

type DirectoryPicker = () => Promise<DirectoryHandleLike>;

interface BatchState {
  batchId: string;
  files: QueueFileMeta[];
  sourceFiles?: File[];
  direction: 'sender' | 'receiver';
  accepted: boolean;
  currentIndex: number;
  completedBytes: number;
  totalBytes: number;
  startedAt: number;
  paused: boolean;
  saveMode: 'memory' | 'single' | 'directory';
  singleHandle?: FileHandleLike;
  directoryHandle?: DirectoryHandleLike;
  savedNames: string[];
}

interface TxState {
  fileId: string;
  index: number;
  file: File;
  sentBytes: number;
  credits: number;
  accepted: boolean;
  cancelled: boolean;
  attempt: number;
  startedAt: number;
}

interface RxState {
  fileId: string;
  index: number;
  meta: FileMeta;
  savedName: string;
  bytesReceived: number;
  chunksSinceCredit: number;
  completing: boolean;
  failed: boolean;
  savedToDisk: boolean;
  writer?: WritableFileStreamLike;
  memoryChunks: ArrayBuffer[];
  writeChain: Promise<void>;
  startedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function loadIceServers(): Promise<RTCIceServer[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('/api/ice-config', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return FALLBACK_ICE_SERVERS;
    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.iceServers)) return FALLBACK_ICE_SERVERS;
    const servers = data.iceServers.filter((item): item is RTCIceServer => {
      if (!isRecord(item)) return false;
      return typeof item.urls === 'string' || Array.isArray(item.urls);
    });
    return servers.length > 0 ? servers : FALLBACK_ICE_SERVERS;
  } catch {
    return FALLBACK_ICE_SERVERS;
  } finally {
    clearTimeout(timeout);
  }
}

function makeQueue(files: QueueFileMeta[]): TransferQueueItem[] {
  return files.map((file) => ({ ...file, status: 'pending', transferred: 0 }));
}

export function useWebRTC(
  sendSignal: (data: unknown) => boolean | void,
  onSignal: (cb: (data: unknown) => void) => void,
  myRole: 'sender' | 'receiver' | null,
  signalingConnected: boolean
) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const iceServersPromiseRef = useRef<Promise<RTCIceServer[]> | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescriptionSetRef = useRef(false);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryAttemptsRef = useRef(0);
  const recoveryCountRef = useRef(0);
  const recoveringRef = useRef(false);
  const completedFileIdsRef = useRef(new Set<string>());
  const creditWaiterRef = useRef<(() => void) | null>(null);
  const resumeWaiterRef = useRef<(() => void) | null>(null);
  const batchRef = useRef<BatchState | null>(null);
  const txRef = useRef<TxState | null>(null);
  const rxRef = useRef<RxState | null>(null);
  const preparingFileRef = useRef(false);
  const discardIncomingRef = useRef(false);
  const pausedRef = useRef(false);
  const lastProgressUpdateRef = useRef(0);
  const failureRef = useRef<(message: string, notifyPeer?: boolean, fatal?: boolean) => void>(() => {});
  const controlHandlerRef = useRef<(message: ControlMessage) => void>(() => {});
  const chunkHandlerRef = useRef<(data: ArrayBuffer) => void>(() => {});
  const dataChannelOpenRef = useRef<(dc: RTCDataChannel) => void>(() => {});
  const recoveryRef = useRef<(reason: string) => void>(() => {});

  const [dcReady, setDcReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [batchProgress, setBatchProgress] = useState(0);
  const [transferStats, setTransferStats] = useState<TransferStats | null>(null);
  const [transferStatus, setTransferStatus] = useState<TransferStatus>('idle');
  const [transferError, setTransferError] = useState<string | null>(null);
  const [queue, setQueue] = useState<TransferQueueItem[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [connectionRoute, setConnectionRoute] = useState<ConnectionRoute>('unknown');
  const [transferElapsedSeconds, setTransferElapsedSeconds] = useState<number | null>(null);

  const clearTransferTimer = useCallback(() => {
    if (transferTimerRef.current) clearTimeout(transferTimerRef.current);
    transferTimerRef.current = null;
  }, []);

  const clearConnectionTimer = useCallback(() => {
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = null;
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = null;
  }, []);

  const sendControl = useCallback((message: ControlMessage) => {
    const dc = dcRef.current;
    if (dc?.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }, []);

  const setQueueItem = useCallback((index: number, patch: Partial<TransferQueueItem>) => {
    setQueue((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }, []);

  const armTransferTimeout = useCallback((message: string, delay = TRANSFER_TIMEOUT_MS) => {
    clearTransferTimer();
    if (pausedRef.current) return;
    transferTimerRef.current = setTimeout(() => failureRef.current(message, true), delay);
  }, [clearTransferTimer]);

  const updateProgress = useCallback((bytes: number, total: number, startedAt: number) => {
    const now = performance.now();
    const percent = total === 0 ? 100 : Math.min(100, (bytes / total) * 100);
    if (now - lastProgressUpdateRef.current < 100 && bytes < total) return;
    lastProgressUpdateRef.current = now;
    const elapsed = Math.max((now - startedAt) / 1000, 0.001);
    const bytesPerSecond = bytes > 0 ? bytes / elapsed : 0;
    const remaining = Math.max(0, total - bytes);
    setProgress(percent);
    setTransferStats({
      bytes,
      total,
      bytesPerSecond,
      etaSeconds: bytesPerSecond > 0 ? remaining / bytesPerSecond : null
    });
    const batch = batchRef.current;
    if (batch) {
      const completed = Math.min(batch.totalBytes, batch.completedBytes + bytes);
      setBatchProgress(batch.totalBytes === 0 ? 100 : (completed / batch.totalBytes) * 100);
    }
  }, []);
  const inspectConnectionRoute = useCallback(async (pc: RTCPeerConnection) => {
    try {
      const stats = await pc.getStats();
      const reports: Array<Record<string, unknown>> = [];
      stats.forEach((report) => reports.push(report as unknown as Record<string, unknown>));
      const transport = reports.find((report) => report.type === 'transport' && typeof report.selectedCandidatePairId === 'string');
      const selectedId = typeof transport?.selectedCandidatePairId === 'string' ? transport.selectedCandidatePairId : null;
      const selected = selectedId ? stats.get(selectedId) as unknown as Record<string, unknown> | undefined : undefined;
      const pair = selected || reports.find((report) => report.type === 'candidate-pair' && report.state === 'succeeded'
        && (report.nominated === true || report.selected === true));
      if (!pair) return setConnectionRoute('unknown');
      const local = stats.get(String(pair.localCandidateId)) as unknown as Record<string, unknown> | undefined;
      const remote = stats.get(String(pair.remoteCandidateId)) as unknown as Record<string, unknown> | undefined;
      const localType = local?.candidateType;
      const remoteType = remote?.candidateType;
      if (localType === 'relay' || remoteType === 'relay') setConnectionRoute('turn');
      else if (localType === 'host' && remoteType === 'host') setConnectionRoute('lan');
      else if (localType && remoteType) setConnectionRoute('direct');
      else setConnectionRoute('unknown');
    } catch {
      setConnectionRoute('unknown');
    }
  }, []);

  const setupDataChannel = useCallback((dc: RTCDataChannel) => {
    dcRef.current = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_BUFFER_BYTES;

    dc.onopen = () => {
      clearConnectionTimer();
      setDcReady(true);
      setTransferError(null);
      dataChannelOpenRef.current(dc);
    };
    dc.onclose = () => {
      if (dcRef.current !== dc) return;
      dcRef.current = null;
      setDcReady(false);
      if (batchRef.current) recoveryRef.current('数据通道已断开');
    };
    dc.onerror = () => {
      if (batchRef.current) recoveryRef.current('数据通道发生错误');
    };
    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const control = parseControl(event.data);
        if (control) controlHandlerRef.current(control);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        chunkHandlerRef.current(event.data);
        return;
      }
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => chunkHandlerRef.current(buffer)).catch(() => {
          failureRef.current('无法读取数据通道消息', false, true);
        });
      }
    };
  }, [clearConnectionTimer]);

  const getIceServers = useCallback(() => {
    if (!iceServersPromiseRef.current) iceServersPromiseRef.current = loadIceServers();
    return iceServersPromiseRef.current;
  }, []);

  const initPeer = useCallback(async () => {
    if (pcRef.current) return pcRef.current;
    if (typeof RTCPeerConnection === 'undefined') throw new Error('当前浏览器不支持 WebRTC');

    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;
    remoteDescriptionSetRef.current = false;
    pendingCandidatesRef.current = [];
    setConnectionRoute('unknown');

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'ice', candidate: event.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      if (pc.connectionState === 'connected') {
        clearConnectionTimer();
        void inspectConnectionRoute(pc);
      }
      if (pc.connectionState === 'failed') {
        setConnectionRoute('failed');
        if (batchRef.current) recoveryRef.current('WebRTC 连接失败');
        else failureRef.current('无法建立 WebRTC 连接，可能需要 TURN 中继', false, true);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      if (pc.iceConnectionState === 'failed') {
        setConnectionRoute('failed');
        if (batchRef.current) recoveryRef.current('WebRTC 连接失败');
        else failureRef.current('WebRTC 连接失败，请重试或配置 TURN', false, true);
      }
    };

    if (myRole === 'sender') {
      setupDataChannel(pc.createDataChannel('file-transfer', { ordered: true }));
    }
    pc.ondatachannel = (event) => setupDataChannel(event.channel);

    clearConnectionTimer();
    connectionTimerRef.current = setTimeout(() => {
      if (!dcRef.current || dcRef.current.readyState !== 'open') {
        setConnectionRoute('failed');
        if (batchRef.current) recoveryRef.current('WebRTC 连接超时');
        else failureRef.current('WebRTC 连接超时，可能需要 TURN 中继', false, true);
      }
    }, CONNECTION_TIMEOUT_MS);

    return pc;
  }, [clearConnectionTimer, getIceServers, inspectConnectionRoute, myRole, sendSignal, setupDataChannel]);

  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    remoteDescriptionSetRef.current = true;
    const candidates = pendingCandidatesRef.current.splice(0);
    for (const candidate of candidates) {
      try { await pc.addIceCandidate(candidate); } catch { /* Stale candidates can be ignored. */ }
    }
  }, []);

  const handleSignal = useCallback(async (data: unknown) => {
    if (!isRecord(data) || typeof data.type !== 'string') return;
    if (data.type === 'recovery-request') {
      if (myRole === 'sender' && batchRef.current) recoveryRef.current('对方请求恢复连接');
      return;
    }
    try {
      if (data.type === 'offer' && pcRef.current) {
        const previousPc = pcRef.current;
        const previousDc = dcRef.current;
        pcRef.current = null;
        dcRef.current = null;
        try { previousDc?.close(); } catch {}
        try { previousPc.close(); } catch {}
      }
      const pc = pcRef.current || (myRole === 'receiver' ? await initPeer() : null);
      if (!pc) return;

      if (data.type === 'offer') {
        await pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
        await flushPendingCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ type: 'answer', sdp: answer });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
        await flushPendingCandidates(pc);
      } else if (data.type === 'ice' && isRecord(data.candidate)) {
        const candidate = data.candidate as RTCIceCandidateInit;
        if (remoteDescriptionSetRef.current) await pc.addIceCandidate(candidate);
        else pendingCandidatesRef.current.push(candidate);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '信令处理失败';
      setConnectionRoute('failed');
      if (batchRef.current) recoveryRef.current(`WebRTC 协商失败：${message}`);
      else failureRef.current(`WebRTC 协商失败：${message}`, false, true);
    }
  }, [flushPendingCandidates, initPeer, myRole, sendSignal]);

  useEffect(() => {
    onSignal(handleSignal);
  }, [handleSignal, onSignal]);

  const createOffer = useCallback(async () => {
    try {
      const pc = pcRef.current || await initPeer();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (sendSignal({ type: 'offer', sdp: offer }) === false) {
        throw new Error('信令服务器连接不可用');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建连接失败';
      setConnectionRoute('failed');
      failureRef.current(message, false, true);
    }
  }, [initPeer, sendSignal]);
  const handleTransferFailure = useCallback((message: string, notifyPeer = true, fatal = false) => {
    const batch = batchRef.current;
    const tx = txRef.current;
    const rx = rxRef.current;
    const index = tx?.index ?? rx?.index ?? batch?.currentIndex ?? 0;
    clearConnectionTimer();
    clearTransferTimer();
    clearRecoveryTimer();
    recoveringRef.current = false;
    recoveryAttemptsRef.current = 0;
    pausedRef.current = false;
    setIsPaused(false);
    txRef.current = null;
    rxRef.current = null;
    if (rx) discardIncomingRef.current = true;
    if (tx) tx.cancelled = true;
    if (rx) rx.failed = true;
    creditWaiterRef.current?.();
    creditWaiterRef.current = null;
    resumeWaiterRef.current?.();
    resumeWaiterRef.current = null;
    rx?.writer?.abort?.().catch(() => {});

    if (batch && batch.files[index]) setQueueItem(index, { status: 'error', error: message });
    if (notifyPeer) {
      if (tx) sendControl({ type: 'file-cancel', fileId: tx.fileId, reason: message });
      else if (rx) sendControl({ type: 'file-error', fileId: rx.fileId, reason: message });
      else if (batch) sendControl({ type: 'batch-reject', batchId: batch.batchId, reason: message });
    }
    if (fatal) {
      setConnectionRoute('failed');
      setDcReady(false);
      if (batch) batch.accepted = false;
    }
    setTransferStatus('error');
    setTransferError(message);
  }, [clearConnectionTimer, clearRecoveryTimer, clearTransferTimer, sendControl, setQueueItem]);

  const acceptBatch = useCallback(async () => {
    const batch = batchRef.current;
    if (!batch || batch.direction !== 'receiver' || batch.accepted) return;

    const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    const directoryPicker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

    try {
      if (batch.files.length > 1 && directoryPicker) {
        batch.directoryHandle = await directoryPicker();
        batch.saveMode = 'directory';
      } else if (batch.files.length === 1 && picker) {
        batch.singleHandle = await picker({ suggestedName: batch.savedNames[0] });
        batch.saveMode = 'single';
      } else if (batch.totalBytes > MAX_IN_MEMORY_FILE_SIZE) {
        const reason = '当前浏览器不支持大文件流式落盘，请使用最新版 Chrome 或 Edge';
        sendControl({ type: 'batch-reject', batchId: batch.batchId, reason });
        failureRef.current(reason, false);
        return;
      }
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'AbortError') setTransferError('已取消选择保存位置，可重新选择');
      else setTransferError('无法打开保存位置，请重试');
      armTransferTimeout('等待接收方确认超时', ACCEPT_TIMEOUT_MS);
      return;
    }

    batch.accepted = true;
    batch.startedAt = performance.now();
    setTransferStatus('receiving');
    setTransferError(null);
    setBatchProgress(0);
    armTransferTimeout('等待发送方发送文件');
    if (!sendControl({ type: 'batch-accept', batchId: batch.batchId })) {
      failureRef.current('无法确认接收，数据通道已断开', false, true);
    }
  }, [armTransferTimeout, sendControl]);

  const prepareIncomingFile = useCallback(async (message: Extract<ControlMessage, { type: 'file-meta' }>) => {
    const batch = batchRef.current;
    if (!batch || batch.direction !== 'receiver' || !batch.accepted || preparingFileRef.current) return;
    if (message.batchId !== batch.batchId || message.index !== batch.currentIndex || message.index >= batch.files.length) {
      failureRef.current('文件队列状态不一致', true);
      return;
    }

    const manifest = batch.files[message.index];
    const expected = manifest.name === message.meta.name && manifest.size === message.meta.size && manifest.type === message.meta.type;
    if (manifest.id !== message.fileId || !expected) {
      failureRef.current('文件信息与队列清单不一致', true);
      return;
    }
    if (rxRef.current) {
      if (rxRef.current.fileId === message.fileId) {
        setTransferStatus('receiving');
        sendControl({ type: 'file-accept', fileId: message.fileId });
      } else {
        failureRef.current('接收端已有其他文件正在传输', true);
      }
      return;
    }

    preparingFileRef.current = true;
    try {
      let writer: WritableFileStreamLike | undefined;
      if (batch.directoryHandle) {
        const handle = await batch.directoryHandle.getFileHandle(batch.savedNames[message.index], { create: true });
        writer = await handle.createWritable();
      } else if (batch.singleHandle) {
        writer = await batch.singleHandle.createWritable();
      }

      rxRef.current = {
        fileId: message.fileId,
        index: message.index,
        meta: message.meta,
        savedName: batch.savedNames[message.index],
        bytesReceived: 0,
        chunksSinceCredit: 0,
        completing: false,
        failed: false,
        savedToDisk: Boolean(writer),
        writer,
        memoryChunks: [],
        writeChain: Promise.resolve(),
        startedAt: performance.now()
      };
      discardIncomingRef.current = false;
      pausedRef.current = false;
      setIsPaused(false);
      setTransferError(null);
      setTransferStatus('receiving');
      setQueueItem(message.index, { status: 'active', transferred: 0, error: undefined });
      setProgress(0);
      setTransferStats({ bytes: 0, total: message.meta.size, bytesPerSecond: 0, etaSeconds: null });
      armTransferTimeout('准备接收文件超时');
      if (!sendControl({ type: 'file-accept', fileId: message.fileId })) {
        throw new Error('无法确认文件接收');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : '准备接收文件失败';
      failureRef.current(`准备接收文件失败：${reason}`, true);
    } finally {
      preparingFileRef.current = false;
    }
  }, [armTransferTimeout, sendControl, setQueueItem]);

  const consumeChunk = useCallback((data: ArrayBuffer) => {
    const rx = rxRef.current;
    if (!rx) {
      failureRef.current('传输协议状态异常，收到未预期的数据', true);
      return;
    }
    if (rx.bytesReceived + data.byteLength > rx.meta.size) {
      failureRef.current('接收数据超过文件声明大小，传输已中止', true);
      return;
    }

    rx.writeChain = rx.writeChain.then(async () => {
      if (rx.failed || rxRef.current !== rx) return;
      try {
        if (rx.writer) await rx.writer.write(data);
        else rx.memoryChunks.push(data);
        rx.bytesReceived += data.byteLength;
        rx.chunksSinceCredit += 1;
        updateProgress(rx.bytesReceived, rx.meta.size, rx.startedAt);
        setQueueItem(rx.index, { transferred: rx.bytesReceived });
        if (!pausedRef.current) armTransferTimeout('文件接收长时间没有进展');
        if (rx.chunksSinceCredit >= CREDIT_BATCH_CHUNKS) {
          sendControl({ type: 'file-credit', fileId: rx.fileId, credits: rx.chunksSinceCredit });
          rx.chunksSinceCredit = 0;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '写入接收文件失败';
        failureRef.current(`写入文件失败：${message}`, true);
      }
    });
  }, [armTransferTimeout, sendControl, setQueueItem, updateProgress]);

  const finalizeReceiver = useCallback(async (fileId: string, declaredSize: number) => {
    const batch = batchRef.current;
    const rx = rxRef.current;
    if (!batch || !rx || rx.fileId !== fileId) return;
    await rx.writeChain;
    if (rx.failed || rxRef.current !== rx) return;

    if (declaredSize !== rx.meta.size || rx.bytesReceived !== rx.meta.size) {
      failureRef.current('文件大小校验失败，接收不完整', true);
      return;
    }

    try {
      if (rx.writer) await rx.writer.close();
      const blob = rx.writer ? undefined : new Blob(rx.memoryChunks, { type: rx.meta.type });
      const isLast = rx.index === batch.files.length - 1;
      rx.memoryChunks = [];
      rxRef.current = null;
      discardIncomingRef.current = false;
      clearTransferTimer();
      setReceivedFiles((current) => [...current, {
        meta: rx.meta,
        savedName: rx.savedName,
        blob,
        savedToDisk: rx.savedToDisk
      }]);
      setQueueItem(rx.index, { status: 'done', transferred: rx.meta.size, error: undefined });
      batch.completedBytes += rx.meta.size;
      setProgress(100);
      setBatchProgress(Math.min(100, (batch.completedBytes / batch.totalBytes) * 100));
      sendControl({ type: 'file-ack', fileId: rx.fileId });
      completedFileIdsRef.current.add(rx.fileId);

      if (isLast) {
        pausedRef.current = false;
        setIsPaused(false);
        batch.accepted = false;
        batch.directoryHandle = undefined;
        batch.singleHandle = undefined;
        setTransferStatus('done');
        setTransferStats({
          bytes: rx.meta.size,
          total: rx.meta.size,
          bytesPerSecond: rx.meta.size / Math.max((performance.now() - rx.startedAt) / 1000, 0.001),
          etaSeconds: 0
        });
        setTransferElapsedSeconds((performance.now() - batch.startedAt) / 1000);
        batchRef.current = null;
      } else {
        batch.currentIndex = rx.index + 1;
        setTransferStatus('receiving');
        setProgress(0);
        setTransferStats(null);
        armTransferTimeout('等待发送方发送下一个文件', ACCEPT_TIMEOUT_MS);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '完成文件写入失败';
      failureRef.current(`完成文件写入失败：${message}`, true);
    }
  }, [armTransferTimeout, clearTransferTimer, sendControl, setQueueItem]);
  const waitWhilePaused = useCallback(async () => {
    while (pausedRef.current && batchRef.current) {
      await new Promise<void>((resolve) => { resumeWaiterRef.current = resolve; });
    }
  }, []);

  const waitForCredit = useCallback(async (tx: TxState) => {
    const attempt = tx.attempt;
    while (!tx.cancelled && txRef.current === tx && tx.attempt === attempt) {
      await waitWhilePaused();
      if (txRef.current !== tx || tx.attempt !== attempt) throw new Error('传输已取消');
      if (tx.credits > 0) {
        tx.credits -= 1;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          creditWaiterRef.current = null;
          reject(new Error('接收方长时间没有返回流控确认'));
        }, 15_000);
        creditWaiterRef.current = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      if (tx.cancelled || txRef.current !== tx || tx.attempt !== attempt) throw new Error('传输已取消');
    }
    throw new Error('传输已取消');
  }, [waitWhilePaused]);

  const waitForBuffer = useCallback(async (dc: RTCDataChannel, tx: TxState) => {
    if (dc.bufferedAmount <= MAX_BUFFERED_BYTES) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const attempt = tx.attempt;
      const watchdog = setInterval(() => {
        if (dc.readyState !== 'open') finish(new Error('数据通道已断开'));
        if (tx.cancelled || tx.attempt !== attempt) finish(new Error('传输已取消'));
      }, 200);
      const cleanup = () => {
        clearInterval(watchdog);
        dc.removeEventListener('bufferedamountlow', onLow);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onLow = () => finish();
      const timeout = setTimeout(() => finish(new Error('发送缓冲区长时间未释放')), 20_000);
      dc.addEventListener('bufferedamountlow', onLow, { once: true });
      if (dc.bufferedAmount <= LOW_BUFFER_BYTES) finish();
      if (dc.readyState !== 'open') finish(new Error('数据通道已断开'));
      if (tx.cancelled) finish(new Error('传输已取消'));
    });
  }, []);

  const sendLoop = useCallback(async (tx: TxState, startOffset = 0) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') throw new Error('数据通道尚未就绪');
    if (txRef.current !== tx) return;
    const attempt = tx.attempt;

    for (let offset = startOffset; offset < tx.file.size; offset += CHUNK_SIZE) {
      if (tx.cancelled || txRef.current !== tx || tx.attempt !== attempt) return;
      await waitForCredit(tx);
      await waitWhilePaused();
      await waitForBuffer(dc, tx);
      await waitWhilePaused();
      if (dc.readyState !== 'open') throw new Error('数据通道已断开');
      const end = Math.min(offset + CHUNK_SIZE, tx.file.size);
      const buffer = await tx.file.slice(offset, end).arrayBuffer();
      if (tx.cancelled || txRef.current !== tx || tx.attempt !== attempt) return;
      dc.send(buffer);
      tx.sentBytes = end;
      updateProgress(tx.sentBytes, tx.file.size, tx.startedAt);
      setQueueItem(tx.index, { transferred: tx.sentBytes });
      armTransferTimeout('接收方长时间没有响应');
    }

    if (!sendControl({ type: 'file-complete', fileId: tx.fileId, size: tx.file.size })) {
      throw new Error('无法发送完成确认');
    }
    armTransferTimeout('等待接收方确认完成超时');
  }, [armTransferTimeout, sendControl, setQueueItem, updateProgress, waitForBuffer, waitForCredit, waitWhilePaused]);

  const startSenderFile = useCallback((index: number) => {
    const batch = batchRef.current;
    if (!batch || batch.direction !== 'sender' || !batch.sourceFiles) return;
    const file = batch.sourceFiles[index];
    const meta = batch.files[index];
    if (!file || !meta) return failureRef.current('文件队列状态异常', false);

    pausedRef.current = false;
    setIsPaused(false);
    batch.currentIndex = index;
    txRef.current = {
      fileId: meta.id,
      index,
      file,
      sentBytes: 0,
      credits: 0,
      accepted: false,
      cancelled: false,
      attempt: 0,
      startedAt: performance.now()
    };
    setTransferError(null);
    setTransferStatus('sending');
    setQueueItem(index, { status: 'active', transferred: 0, error: undefined });
    setProgress(0);
    setTransferStats({ bytes: 0, total: file.size, bytesPerSecond: 0, etaSeconds: null });
    armTransferTimeout('等待接收方准备文件超时');
    if (!sendControl({
      type: 'file-meta',
      batchId: batch.batchId,
      fileId: meta.id,
      index,
      meta: fileMetaOf(file)
    })) {
      failureRef.current('无法发送文件信息，数据通道已断开', false, true);
    }
  }, [armTransferTimeout, sendControl, setQueueItem]);

  const attemptConnectionRecovery = useCallback((reason: string) => {
    if (!batchRef.current) {
      failureRef.current(reason, false, true);
      return;
    }
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    recoveryAttemptsRef.current += 1;
    recoveryCountRef.current += 1;
    if (txRef.current) txRef.current.attempt += 1;
    creditWaiterRef.current?.();
    creditWaiterRef.current = null;
    resumeWaiterRef.current?.();
    resumeWaiterRef.current = null;
    clearTransferTimer();
    clearConnectionTimer();
    clearRecoveryTimer();
    setDcReady(false);
    setConnectionRoute('unknown');
    setTransferStatus('recovering');
    setTransferError(null);

    const previousPc = pcRef.current;
    const previousDc = dcRef.current;
    pcRef.current = null;
    dcRef.current = null;
    try { previousDc?.close(); } catch {}
    try { previousPc?.close(); } catch {}

    const retry = (message: string) => {
      recoveringRef.current = false;
      clearRecoveryTimer();
      if (!batchRef.current) return;
      if (recoveryAttemptsRef.current >= 12) {
        failureRef.current('连接恢复失败，请重新配对', false, true);
        return;
      }
      const delay = Math.min(5000, 1000 * recoveryAttemptsRef.current);
      recoveryTimerRef.current = setTimeout(() => recoveryRef.current(message), delay);
    };

    const start = async () => {
      if (!signalingConnected) throw new Error('等待信令连接恢复');
      if (myRole === 'sender') {
        const pc = await initPeer();
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        if (sendSignal({ type: 'offer', sdp: offer }) === false) throw new Error('信令服务器暂时不可用');
      } else {
        sendSignal({ type: 'recovery-request' });
      }
      clearRecoveryTimer();
      recoveryTimerRef.current = setTimeout(() => retry('未收到恢复协商'), 12_000);
    };

    void start().catch((error) => {
      retry(error instanceof Error ? error.message : '连接恢复失败');
    });
  }, [clearConnectionTimer, clearRecoveryTimer, clearTransferTimer, initPeer, myRole, sendSignal, signalingConnected]);

  const pauseTransfer = useCallback(() => {
    const batch = batchRef.current;
    if (!batch || !txRef.current && !rxRef.current) return;
    pausedRef.current = true;
    batch.paused = true;
    clearTransferTimer();
    creditWaiterRef.current?.();
    creditWaiterRef.current = null;
    setIsPaused(true);
    setTransferStatus('paused');
    sendControl({ type: 'batch-pause', batchId: batch.batchId });
  }, [clearTransferTimer, sendControl]);

  const applyResume = useCallback((notifyPeer: boolean) => {
    const batch = batchRef.current;
    if (!batch) return;
    pausedRef.current = false;
    batch.paused = false;
    setIsPaused(false);
    resumeWaiterRef.current?.();
    resumeWaiterRef.current = null;
    setTransferStatus(batch.direction === 'sender' ? 'sending' : 'receiving');
    armTransferTimeout('文件传输长时间没有进展');
    if (notifyPeer) sendControl({ type: 'batch-resume', batchId: batch.batchId });
    if (rxRef.current) sendControl({ type: 'file-credit', fileId: rxRef.current.fileId, credits: INITIAL_CREDIT_CHUNKS });
  }, [armTransferTimeout, sendControl]);

  const resumeTransfer = useCallback(() => {
    applyResume(true);
  }, [applyResume]);

  const handleControl = useCallback((message: ControlMessage) => {
    if (message.type === 'batch-meta') {
      if (myRole !== 'receiver') return;
      if (batchRef.current) {
        sendControl({ type: 'batch-reject', batchId: message.batchId, reason: '接收方已有传输任务' });
        return;
      }
      const totalBytes = message.files.reduce((sum, file) => sum + file.size, 0);
      batchRef.current = {
        batchId: message.batchId,
        files: message.files,
        direction: 'receiver',
        accepted: false,
        currentIndex: 0,
        completedBytes: 0,
        totalBytes,
        startedAt: 0,
        paused: false,
        saveMode: 'memory',
        savedNames: makeUniqueFileNames(message.files)
      };
      setQueue(makeQueue(message.files));
      setReceivedFiles([]);
      setTransferError(null);
      setTransferStatus('awaiting-accept');
      setProgress(0);
      setBatchProgress(0);
      setTransferStats(null);
      setTransferElapsedSeconds(null);
      armTransferTimeout('等待接收方确认超时', ACCEPT_TIMEOUT_MS);
      return;
    }

    if (message.type === 'batch-accept') {
      const batch = batchRef.current;
      if (!batch || batch.direction !== 'sender' || batch.batchId !== message.batchId || batch.accepted) return;
      batch.accepted = true;
      batch.startedAt = performance.now();
      startSenderFile(0);
      return;
    }

    if (message.type === 'batch-reject') {
      const batch = batchRef.current;
      if (!batch || batch.batchId !== message.batchId) return;
      if (batch.direction === 'sender') {
        failureRef.current(message.reason, false);
      } else {
        clearTransferTimer();
        txRef.current = null;
        rxRef.current = null;
        batchRef.current = null;
        pausedRef.current = false;
        setIsPaused(false);
        setTransferStatus('cancelled');
        setTransferError(null);
      }
      return;
    }

    if (message.type === 'file-meta') {
      void prepareIncomingFile(message);
      return;
    }

    if (message.type === 'file-accept') {
      const tx = txRef.current;
      if (!tx || tx.fileId !== message.fileId || tx.accepted) return;
      tx.accepted = true;
      tx.startedAt = performance.now();
      tx.credits = INITIAL_CREDIT_CHUNKS;
      lastProgressUpdateRef.current = 0;
      setTransferStatus('sending');
      setTransferError(null);
      armTransferTimeout('接收方长时间没有响应');
      sendLoop(tx).catch((error) => {
        if (tx.cancelled || txRef.current !== tx || tx.attempt !== 0) return;
        recoveryRef.current(error instanceof Error ? error.message : '发送文件失败');
      });
      return;
    }

    if (message.type === 'file-credit') {
      const tx = txRef.current;
      if (!tx || tx.fileId !== message.fileId) return;
      tx.credits += message.credits;
      creditWaiterRef.current?.();
      creditWaiterRef.current = null;
      if (!pausedRef.current) armTransferTimeout('接收方长时间没有响应');
      return;
    }

    if (message.type === 'file-complete') {
      const rx = rxRef.current;
      if (!rx || rx.fileId !== message.fileId || rx.completing) return;
      rx.completing = true;
      finalizeReceiver(message.fileId, message.size).catch(() => {});
      return;
    }

    if (message.type === 'file-ack') {
      const batch = batchRef.current;
      const tx = txRef.current;
      if (!batch || !tx || tx.fileId !== message.fileId) return;
      clearTransferTimer();
      clearRecoveryTimer();
      recoveringRef.current = false;
      recoveryAttemptsRef.current = 0;
      setDcReady(true);
      txRef.current = null;
      const isLast = tx.index === batch.files.length - 1;
      setQueueItem(tx.index, { status: 'done', transferred: tx.file.size, error: undefined });
      batch.completedBytes += tx.file.size;
      setBatchProgress(Math.min(100, (batch.completedBytes / batch.totalBytes) * 100));
      if (isLast) {
        pausedRef.current = false;
        setIsPaused(false);
        batch.accepted = false;
        setTransferStatus('done');
        setProgress(100);
        setTransferStats({
          bytes: tx.file.size,
          total: tx.file.size,
          bytesPerSecond: tx.file.size / Math.max((performance.now() - tx.startedAt) / 1000, 0.001),
          etaSeconds: 0
        });
        setTransferElapsedSeconds((performance.now() - batch.startedAt) / 1000);
        batchRef.current = null;
      } else {
        startSenderFile(tx.index + 1);
      }
      return;
    }

    if (message.type === 'file-cancel' || message.type === 'file-error') {
      const activeId = txRef.current?.fileId || rxRef.current?.fileId;
      if (!activeId || activeId !== message.fileId) return;
      failureRef.current(message.reason, false);
      return;
    }

    if (message.type === 'resume-request') {
      const batch = batchRef.current;
      if (!batch || batch.direction !== 'receiver' || batch.batchId !== message.batchId) {
        sendControl({ type: 'resume-reject', batchId: message.batchId, fileId: message.fileId, reason: '接收方没有可恢复的会话' });
        return;
      }
      if (completedFileIdsRef.current.has(message.fileId)) {
        clearRecoveryTimer();
        recoveringRef.current = false;
        recoveryAttemptsRef.current = 0;
        sendControl({ type: 'file-ack', fileId: message.fileId });
        return;
      }
      const rx = rxRef.current;
      if (!rx || rx.fileId !== message.fileId) {
        sendControl({ type: 'resume-reject', batchId: message.batchId, fileId: message.fileId, reason: '接收端没有当前文件的写入状态' });
        return;
      }
      clearRecoveryTimer();
      recoveringRef.current = false;
      recoveryAttemptsRef.current = 0;
      setDcReady(true);
      setTransferStatus('receiving');
      armTransferTimeout('文件恢复后长时间没有进展');
      void rx.writeChain.then(() => {
        if (rxRef.current !== rx || rx.failed) return;
        sendControl({ type: 'resume-state', batchId: message.batchId, fileId: message.fileId, offset: rx.bytesReceived });
      });
      return;
    }

    if (message.type === 'resume-state') {
      const batch = batchRef.current;
      const tx = txRef.current;
      if (!batch || !tx || batch.direction !== 'sender' || batch.batchId !== message.batchId || tx.fileId !== message.fileId) return;
      if (message.offset > tx.file.size) {
        failureRef.current('恢复位置无效，传输已中止', false, true);
        return;
      }
      clearRecoveryTimer();
      recoveringRef.current = false;
      recoveryAttemptsRef.current = 0;
      tx.attempt += 1;
      tx.accepted = true;
      tx.sentBytes = message.offset;
      tx.credits = INITIAL_CREDIT_CHUNKS;
      tx.startedAt = performance.now();
      setDcReady(true);
      setTransferStatus('sending');
      setTransferError(null);
      setQueueItem(tx.index, { transferred: message.offset });
      updateProgress(message.offset, tx.file.size, tx.startedAt);
      armTransferTimeout('文件恢复后长时间没有响应');
      const attempt = tx.attempt;
      sendLoop(tx, message.offset).catch((error) => {
        if (txRef.current !== tx || tx.attempt !== attempt) return;
        recoveryRef.current(error instanceof Error ? error.message : '恢复发送失败');
      });
      return;
    }

    if (message.type === 'resume-reject') {
      const activeId = txRef.current?.fileId || rxRef.current?.fileId;
      if (activeId && activeId !== message.fileId) return;
      failureRef.current(message.reason, false, true);
      return;
    }

    if (message.type === 'batch-pause') {
      const batch = batchRef.current;
      if (!batch || batch.batchId !== message.batchId) return;
      pausedRef.current = true;
      batch.paused = true;
      clearTransferTimer();
      creditWaiterRef.current?.();
      creditWaiterRef.current = null;
      setIsPaused(true);
      setTransferStatus('paused');
      return;
    }

    if (message.type === 'batch-resume') {
      if (batchRef.current?.batchId !== message.batchId) return;
      applyResume(false);
    }
  }, [applyResume, armTransferTimeout, clearRecoveryTimer, clearTransferTimer, finalizeReceiver, myRole, prepareIncomingFile, sendControl, sendLoop, setQueueItem, startSenderFile, updateProgress]);

  const handleChunk = useCallback((data: ArrayBuffer) => {
    if (!rxRef.current) {
      if (discardIncomingRef.current) return;
      failureRef.current('收到未预期的文件数据', true);
      return;
    }
    consumeChunk(data);
  }, [consumeChunk]);

  const handleDataChannelOpen = useCallback(() => {
    const batch = batchRef.current;
    if (!batch) return;
    clearRecoveryTimer();
    setDcReady(true);
    if (myRole === 'sender') {
      const tx = txRef.current;
      if (tx?.accepted) {
        sendControl({ type: 'resume-request', batchId: batch.batchId, fileId: tx.fileId });
        armTransferTimeout('等待接收方返回恢复位置', 15_000);
      } else if (batch.accepted) {
        startSenderFile(batch.currentIndex);
      }
    } else {
      armTransferTimeout('等待发送方恢复传输', 15_000);
    }
  }, [armTransferTimeout, clearRecoveryTimer, myRole, sendControl, startSenderFile]);

  useEffect(() => {
    failureRef.current = handleTransferFailure;
    controlHandlerRef.current = handleControl;
    chunkHandlerRef.current = handleChunk;
    dataChannelOpenRef.current = handleDataChannelOpen;
    recoveryRef.current = attemptConnectionRecovery;
  }, [attemptConnectionRecovery, handleChunk, handleControl, handleDataChannelOpen, handleTransferFailure]);

  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_E2E !== '1') return;
    const testWindow = window as Window & {
      __airdropTest?: {
        dropDataChannel?: () => void;
        getRecoveryCount?: () => number;
      };
    };
    testWindow.__airdropTest = {
      ...testWindow.__airdropTest,
      dropDataChannel: () => dcRef.current?.close(),
      getRecoveryCount: () => recoveryCountRef.current
    };
    return () => {
      if (testWindow.__airdropTest) delete testWindow.__airdropTest.dropDataChannel;
      if (testWindow.__airdropTest) delete testWindow.__airdropTest.getRecoveryCount;
    };
  }, []);
  const sendFiles = useCallback((files: File[]) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') {
      setTransferStatus('error');
      setTransferError('连接尚未就绪，请稍后重试');
      return;
    }
    const busy = transferStatus === 'awaiting-accept' || transferStatus === 'sending'
      || transferStatus === 'receiving' || transferStatus === 'paused';
    if (busy || txRef.current || rxRef.current) {
      setTransferError('当前已有传输任务');
      return;
    }
    const selected = files.slice(0, MAX_FILES_PER_BATCH);
    if (selected.length === 0) return;

    if (batchRef.current && !txRef.current && !rxRef.current) {
      sendControl({ type: 'batch-reject', batchId: batchRef.current.batchId, reason: '发送方开始了新的传输任务' });
    }

    const metadata: QueueFileMeta[] = selected.map((file) => ({ id: createTransferId(), ...fileMetaOf(file) }));
    const totalBytes = selected.reduce((sum, file) => sum + file.size, 0);
    batchRef.current = {
      batchId: createTransferId(),
      files: metadata,
      sourceFiles: selected,
      direction: 'sender',
      accepted: false,
      currentIndex: 0,
      completedBytes: 0,
      totalBytes,
      startedAt: 0,
      paused: false,
      saveMode: 'memory',
      savedNames: makeUniqueFileNames(metadata)
    };
    pausedRef.current = false;
    completedFileIdsRef.current.clear();
    setIsPaused(false);
    setQueue(makeQueue(metadata));
    setReceivedFiles([]);
    setTransferError(null);
    setProgress(0);
    setBatchProgress(0);
    setTransferStats(null);
    setTransferElapsedSeconds(null);
    setTransferStatus('awaiting-accept');
    if (!sendControl({ type: 'batch-meta', batchId: batchRef.current.batchId, files: metadata })) {
      failureRef.current('无法发送文件队列信息，数据通道已断开', false, true);
      return;
    }
    armTransferTimeout('等待接收方确认超时', ACCEPT_TIMEOUT_MS);
  }, [armTransferTimeout, sendControl, transferStatus]);

  const sendFile = useCallback((file: File) => sendFiles([file]), [sendFiles]);

  const retryFile = useCallback(() => {
    const batch = batchRef.current;
    if (!batch || batch.direction !== 'sender' || !batch.accepted || !dcRef.current || dcRef.current.readyState !== 'open') {
      setTransferError('当前连接无法重试，请重新建立会话');
      return;
    }
    if (txRef.current || rxRef.current) return;
    startSenderFile(batch.currentIndex);
  }, [startSenderFile]);

  const rejectOrCancel = useCallback(() => {
    const batch = batchRef.current;
    if (!batch) return;
    const tx = txRef.current;
    const rx = rxRef.current;
    const index = tx?.index ?? rx?.index ?? batch.currentIndex;
    clearTransferTimer();
    clearRecoveryTimer();
    recoveringRef.current = false;
    recoveryAttemptsRef.current = 0;
    pausedRef.current = false;
    batch.paused = false;
    batch.accepted = false;
    setIsPaused(false);
    creditWaiterRef.current?.();
    creditWaiterRef.current = null;
    resumeWaiterRef.current?.();
    resumeWaiterRef.current = null;

    if (tx) {
      tx.cancelled = true;
      sendControl({ type: 'file-cancel', fileId: tx.fileId, reason: '发送方取消了传输' });
    } else if (rx) {
      rx.failed = true;
      sendControl({ type: 'file-cancel', fileId: rx.fileId, reason: '接收方取消了传输' });
      rx.writer?.abort?.().catch(() => {});
    } else {
      sendControl({ type: 'batch-reject', batchId: batch.batchId, reason: '对方取消了传输' });
    }

    txRef.current = null;
    rxRef.current = null;
    discardIncomingRef.current = false;
    setQueueItem(index, { status: 'error', error: '已取消' });
    setTransferStatus('cancelled');
    setTransferError(null);
  }, [clearRecoveryTimer, clearTransferTimer, sendControl, setQueueItem]);

  const close = useCallback(() => {
    const batch = batchRef.current;
    const tx = txRef.current;
    const rx = rxRef.current;
    if (batch) {
      if (tx) sendControl({ type: 'file-cancel', fileId: tx.fileId, reason: '会话已结束' });
      else if (rx) sendControl({ type: 'file-cancel', fileId: rx.fileId, reason: '会话已结束' });
      else sendControl({ type: 'batch-reject', batchId: batch.batchId, reason: '会话已结束' });
    }
    txRef.current = null;
    rxRef.current = null;
    discardIncomingRef.current = false;
    batchRef.current = null;
    pausedRef.current = false;
    if (tx) tx.cancelled = true;
    if (rx) {
      rx.failed = true;
      rx.writer?.abort?.().catch(() => {});
    }
    creditWaiterRef.current?.();
    creditWaiterRef.current = null;
    resumeWaiterRef.current?.();
    resumeWaiterRef.current = null;
    clearTransferTimer();
    clearConnectionTimer();
    clearRecoveryTimer();
    recoveringRef.current = false;
    recoveryAttemptsRef.current = 0;
    const dc = dcRef.current;
    const pc = pcRef.current;
    dcRef.current = null;
    pcRef.current = null;
    try { dc?.close(); } catch {}
    try { pc?.close(); } catch {}
    setDcReady(false);
    setProgress(0);
    setBatchProgress(0);
    setTransferStats(null);
    setTransferStatus('idle');
    setTransferError(null);
    setQueue([]);
    setReceivedFiles([]);
    setIsPaused(false);
    setConnectionRoute('unknown');
    setTransferElapsedSeconds(null);
  }, [clearConnectionTimer, clearRecoveryTimer, clearTransferTimer, sendControl]);

  return {
    dcReady,
    progress,
    batchProgress,
    transferStats,
    transferStatus,
    transferError,
    queue,
    receivedFiles,
    isPaused,
    connectionRoute,
    transferElapsedSeconds,
    createOffer,
    sendFiles,
    sendFile,
    acceptBatch,
    pauseTransfer,
    resumeTransfer,
    retryFile,
    rejectOrCancel,
    close
  };
}
