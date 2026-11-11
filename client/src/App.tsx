import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSignaling, type ConnectionState, type Role } from './hooks/useSignaling';
import {
  useWebRTC,
  MAX_IN_MEMORY_FILE_SIZE,
  type ConnectionRoute,
  type ReceivedFile,
  type TransferQueueItem,
  type TransferStats,
  type TransferStatus
} from './hooks/useWebRTC';
import { useWakeLock } from './hooks/useWakeLock';
import { GlassCard } from './components/GlassCard';
import { ActionButton } from './components/ActionButton';
import { Progress } from './components/Progress';
import { Icon } from './components/Icon';
import { QrCode } from './components/QrCode';
import { QrScanner } from './components/QrScanner';
import { extractToken } from './lib/transferProtocol';

type Screen = 'home' | 'waiting' | 'join' | 'transfer';
type CopiedTarget = 'token' | 'link' | null;
const TOKEN_PATTERN = /^[A-HJ-NP-Za-hj-np-z2-9]{8}$/;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '计算中';
}

function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '计算中';
  if (seconds < 1) return '即将完成';
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes} 分 ${remainder} 秒`;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const success = document.execCommand('copy');
    input.remove();
    return success;
  }
}

function routeLabel(route: ConnectionRoute): string {
  return {
    lan: '局域网直连',
    direct: '公网 P2P 直连',
    turn: 'TURN 加密中继',
    failed: '连接失败',
    unknown: '正在选择最佳路径'
  }[route];
}

function errorHelp(message: string | null): { title: string; detail: string } {
  const value = message || '传输未能完成';
  if (value.includes('TURN') || value.includes('WebRTC') || value.includes('连接超时') || value.includes('数据通道')) {
    return { title: '当前网络无法建立直连', detail: `${value}。请确认网络允许 UDP，或让管理员配置 TURN 中继后重新配对。` };
  }
  if (value.includes('断开') || value.includes('信令')) {
    return { title: '会话连接已中断', detail: `${value}。返回首页后可重新生成会话。` };
  }
  if (value.includes('保存') || value.includes('写入') || value.includes('文件')) {
    return { title: '无法完成文件写入', detail: `${value}。请检查保存位置、磁盘空间和浏览器权限后重试。` };
  }
  return { title: '传输没有完成', detail: value };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [inputToken, setInputToken] = useState('');
  const [copied, setCopied] = useState<CopiedTarget>(null);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const offeredRef = useRef(false);

  const signaling = useSignaling();
  const registerSignalHandler = useCallback((cb: (data: unknown) => void) => {
    signaling.setHandlers({ onSignal: cb });
  }, [signaling.setHandlers]);

  const {
    createOffer,
    sendFiles,
    acceptBatch,
    pauseTransfer,
    resumeTransfer,
    retryFile,
    rejectOrCancel,
    close,
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
    transferElapsedSeconds
  } = useWebRTC(signaling.sendSignal, registerSignalHandler, signaling.myRole, signaling.connected);

  useWakeLock(screen === 'transfer' && (transferStatus === 'sending' || transferStatus === 'receiving' || transferStatus === 'paused' || transferStatus === 'recovering'));

  const goHome = useCallback((message: string | null, reconnect: boolean) => {
    close();
    setInputToken('');
    setCopied(null);
    setSessionMessage(message);
    setScreen('home');
    offeredRef.current = false;
    if (reconnect) {
      signaling.reset();
      signaling.connect();
    }
  }, [close, signaling.connect, signaling.reset]);

  useEffect(() => {
    signaling.connect();
  }, [signaling.connect]);

  useEffect(() => {
    const sharedToken = new URLSearchParams(window.location.search).get('token');
    if (sharedToken && TOKEN_PATTERN.test(sharedToken)) {
      setInputToken(sharedToken);
      setScreen('join');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    signaling.setHandlers({
      onPeerLeft: (message) => goHome(message, true),
      onSessionEnded: (message) => goHome(message, false)
    });
  }, [goHome, signaling.setHandlers]);

  useEffect(() => {
    if (!signaling.matched) return;
    if (signaling.myRole === 'sender' && !offeredRef.current) {
      offeredRef.current = true;
      void createOffer();
    }
    setSessionMessage(null);
    setScreen('transfer');
  }, [createOffer, signaling.matched, signaling.myRole]);

  useEffect(() => {
    if (screen !== 'transfer' || !['sending', 'receiving', 'paused', 'recovering'].includes(transferStatus)) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [screen, transferStatus]);

  useEffect(() => {
    if (screen === 'join') return;
    const heading = document.querySelector<HTMLElement>('main h1, main h2');
    heading?.focus({ preventScroll: true });
  }, [screen]);

  const inviteUrl = signaling.token
    ? `${window.location.origin}${window.location.pathname}?token=${encodeURIComponent(signaling.token)}`
    : '';

  const handleSend = () => {
    if (!signaling.connected) return;
    setSessionMessage(null);
    signaling.createRoom('sender');
    setScreen('waiting');
  };

  const handleReceive = () => {
    if (!signaling.connected) return;
    setSessionMessage(null);
    setScreen('join');
  };

  const joinWithToken = (token: string) => {
    if (!signaling.connected) return;
    setInputToken(token);
    setSessionMessage(null);
    signaling.joinRoom('receiver', token);
    setScreen('waiting');
  };

  const handleJoin = () => {
    const token = extractToken(inputToken);
    if (token) joinWithToken(token);
  };

  const handleTokenInput = (value: string) => {
    setInputToken(extractToken(value) || value);
  };

  const handleCopy = async (value: string, target: CopiedTarget) => {
    if (!value) return;
    const success = await copyText(value);
    setCopied(success ? target : null);
    setTimeout(() => setCopied(null), 1800);
  };

  const handleShare = async () => {
    if (!inviteUrl) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'AirDrop Web 文件传输', text: `使用 Token ${signaling.token} 接收文件`, url: inviteUrl });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    await handleCopy(inviteUrl, 'link');
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length > 0) sendFiles(files);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) sendFiles(files);
  };

  const handleDownload = (file: ReceivedFile) => {
    if (!file.blob) return;
    const url = URL.createObjectURL(file.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.savedName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleReset = () => goHome(null, true);

  return (
    <div className="app-shell flex min-h-[100dvh]">
      <main className="my-auto mx-auto w-full max-w-lg py-2">
        {screen === 'home' && (
          <HomeScreen
            onSend={handleSend}
            onReceive={handleReceive}
            connectionState={signaling.connectionState}
            message={sessionMessage}
          />
        )}

        {screen === 'waiting' && (
          <WaitingScreen
            token={signaling.token}
            expiresAt={signaling.roomExpiresAt}
            myRole={signaling.myRole}
            error={signaling.error}
            copied={copied}
            inviteUrl={inviteUrl}
            onCopyToken={() => signaling.token && void handleCopy(signaling.token, 'token')}
            onCopyLink={() => void handleCopy(inviteUrl, 'link')}
            onShare={() => void handleShare()}
            onBack={handleReset}
          />
        )}

        {screen === 'join' && (
          <JoinScreen
            inputToken={inputToken}
            connected={signaling.connected}
            onTokenChange={handleTokenInput}
            onJoin={handleJoin}
            onScannedToken={joinWithToken}
            onBack={() => setScreen('home')}
            error={signaling.error}
          />
        )}

        {screen === 'transfer' && (
          <TransferScreen
            myRole={signaling.myRole}
            peerState={signaling.peerState}
            dcReady={dcReady}
            progress={progress}
            batchProgress={batchProgress}
            transferStats={transferStats}
            transferStatus={transferStatus}
            transferError={transferError}
            queue={queue}
            receivedFiles={receivedFiles}
            isPaused={isPaused}
            connectionRoute={connectionRoute}
            transferElapsedSeconds={transferElapsedSeconds}
            onFilesSelected={handleFileSelect}
            onDrop={handleDrop}
            onAccept={() => void acceptBatch()}
            onPause={pauseTransfer}
            onResume={resumeTransfer}
            onRetry={retryFile}
            onCancel={rejectOrCancel}
            onDownload={handleDownload}
            onReset={handleReset}
          />
        )}
      </main>
    </div>
  );
}
interface HomeScreenProps {
  onSend: () => void;
  onReceive: () => void;
  connectionState: ConnectionState;
  message: string | null;
}

function HomeScreen({ onSend, onReceive, connectionState, message }: HomeScreenProps) {
  const connected = connectionState === 'connected';
  const statusText = {
    connecting: '正在连接信令服务器...',
    connected: '',
    reconnecting: '连接中断，正在自动重连...',
    disconnected: '信令服务器未连接'
  }[connectionState];

  return (
    <div className="fade-in py-8 sm:py-12">
      <div className="text-center mb-10 sm:mb-12">
        <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[28px] bg-white text-apple-blue shadow-[0_18px_50px_rgba(0,0,0,0.08)]">
          <Icon name="box" size={42} strokeWidth={1.5} />
        </div>
        <h1 tabIndex={-1} className="text-3xl sm:text-4xl font-semibold tracking-tight text-apple-gray-dark mb-3 focus:outline-none">AirDrop Web</h1>
        <p className="text-apple-gray-text leading-6">在浏览器之间安全、直接地传输文件</p>
        {statusText && <p className="text-orange-600 text-sm mt-3" role="status">{statusText}</p>}
      </div>

      {message && (
        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
          <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
          <span>{message}</span>
        </div>
      )}

      <div className="space-y-3.5">
        <button type="button" onClick={onSend} disabled={!connected} className="send-choice group">
          <span className="choice-icon bg-apple-blue text-white"><Icon name="upload" size={23} /></span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-base font-semibold text-apple-gray-dark">发送文件</span>
            <span className="block text-sm text-apple-gray-text mt-0.5">生成链接或二维码，邀请对方接收</span>
          </span>
          <Icon name="chevron" size={18} className="text-gray-400 group-hover:text-apple-blue transition-colors" />
        </button>

        <button type="button" onClick={onReceive} disabled={!connected} className="send-choice group">
          <span className="choice-icon bg-gray-100 text-apple-gray-dark"><Icon name="download" size={23} /></span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-base font-semibold text-apple-gray-dark">接收文件</span>
            <span className="block text-sm text-apple-gray-text mt-0.5">输入 Token，或直接打开分享链接</span>
          </span>
          <Icon name="chevron" size={18} className="text-gray-400 group-hover:text-apple-blue transition-colors" />
        </button>
      </div>

      <div className="mt-8 grid grid-cols-3 gap-2 text-center text-[11px] text-apple-gray-text">
        <div className="rounded-xl bg-white/55 px-2 py-3"><Icon name="shield" size={17} className="mx-auto mb-1" />端到端加密</div>
        <div className="rounded-xl bg-white/55 px-2 py-3"><Icon name="wifi" size={17} className="mx-auto mb-1" />优先直连</div>
        <div className="rounded-xl bg-white/55 px-2 py-3"><Icon name="devices" size={17} className="mx-auto mb-1" />跨设备</div>
      </div>
      <p className="text-center text-xs text-apple-gray-text mt-5 leading-5">
        文件默认不经过服务器；无法直连时可使用加密 TURN 中继。
      </p>
    </div>
  );
}

interface WaitingScreenProps {
  token: string | null;
  expiresAt: number | null;
  myRole: Role | null;
  error: string | null;
  copied: CopiedTarget;
  inviteUrl: string;
  onCopyToken: () => void;
  onCopyLink: () => void;
  onShare: () => void;
  onBack: () => void;
}

function WaitingScreen({ token, expiresAt, myRole, error, copied, inviteUrl, onCopyToken, onCopyLink, onShare, onBack }: WaitingScreenProps) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      setRemaining(null);
      return;
    }
    const update = () => setRemaining(Math.max(0, expiresAt - Date.now()));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const minutes = remaining === null ? null : Math.floor(remaining / 60000);
  const seconds = remaining === null ? null : Math.floor((remaining % 60000) / 1000);

  return (
    <GlassCard className="fade-in !p-6 sm:!p-8">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-apple-blue">
          <Icon name="link" size={24} />
        </div>
        <h2 tabIndex={-1} className="text-2xl font-semibold tracking-tight focus:outline-none">邀请对方加入</h2>
        <p className="text-apple-gray-text text-sm mt-2 mb-6">分享链接、二维码或 Token，等待{myRole === 'sender' ? '接收方' : '发送方'}连接</p>

        {token && (
          <>
            <div className="mb-5 flex items-center justify-center gap-2" aria-label={`Token ${token.slice(0, 4)} ${token.slice(4)}`}>
              <span className="token-box">{token.slice(0, 4)}</span>
              <span className="text-gray-300 font-semibold">—</span>
              <span className="token-box">{token.slice(4)}</span>
            </div>

            <QrCode value={inviteUrl} size={176} />

            <div className="mt-5 space-y-2.5">
              <ActionButton onClick={onShare} label={copied === 'link' ? '链接已复制' : '分享邀请链接'} />
              <div className="grid grid-cols-2 gap-2.5">
                <button type="button" onClick={onCopyLink} className="secondary-action">
                  <Icon name="copy" size={17} />{copied === 'link' ? '已复制' : '复制链接'}
                </button>
                <button type="button" onClick={onCopyToken} className="secondary-action">
                  <Icon name="copy" size={17} />{copied === 'token' ? '已复制' : '复制 Token'}
                </button>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-apple-gray-text" aria-live="polite">
              <Icon name="clock" size={14} />
              {remaining === null ? '等待连接中' : `会话剩余 ${minutes}:${String(seconds).padStart(2, '0')}`}
            </div>
            <p className="mt-2 break-all text-[11px] text-gray-400">{inviteUrl}</p>
          </>
        )}

        {error && <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
        <button type="button" onClick={onBack} className="mt-5 text-sm text-apple-gray-text hover:underline py-2">
          结束并返回首页
        </button>
      </div>
    </GlassCard>
  );
}

interface JoinScreenProps {
  inputToken: string;
  connected: boolean;
  onTokenChange: (value: string) => void;
  onJoin: () => void;
  onScannedToken: (token: string) => void;
  onBack: () => void;
  error: string | null;
}

function JoinScreen({ inputToken, connected, onTokenChange, onJoin, onScannedToken, onBack, error }: JoinScreenProps) {
  const tokenValid = TOKEN_PATTERN.test(inputToken.trim());
  const [scanning, setScanning] = useState(false);

  const handlePaste = async () => {
    try {
      const value = await navigator.clipboard.readText();
      const token = extractToken(value);
      if (token) onTokenChange(token);
    } catch {
      // Clipboard permission is optional; manual input remains available.
    }
  };

  return (
    <GlassCard className="fade-in !p-6 sm:!p-8">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100 text-apple-gray-dark">
        <Icon name="download" size={24} />
      </div>
      <h2 tabIndex={-1} className="text-2xl font-semibold text-center mb-2 focus:outline-none">输入 Token</h2>
      <p className="text-apple-gray-text text-sm text-center mb-6">可粘贴 8 位 Token，也可以直接粘贴分享链接</p>

      <button type="button" onClick={() => setScanning(true)} className="secondary-action mb-4 w-full">
        <Icon name="qr" size={18} />扫描邀请二维码
      </button>

      <div className="relative mb-4">
        <input
          type="text"
          value={inputToken}
          onChange={(event) => onTokenChange(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && onJoin()}
          placeholder="ABCD2345"
          aria-label="配对 Token"
          className="token-input"
          autoFocus
          maxLength={256}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="button" onClick={() => void handlePaste()} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-3 py-2 text-xs font-medium text-apple-blue hover:bg-blue-50">
          粘贴
        </button>
      </div>

      {error && <p className="text-red-600 text-sm mb-4 text-center" role="alert">{error}</p>}
      {!connected && <p className="text-orange-600 text-xs mb-3 text-center" role="status">正在连接信令服务器...</p>}
      <div className="space-y-3">
        <ActionButton onClick={onJoin} label="连接对方" disabled={!tokenValid || !connected} />
        <button type="button" onClick={onBack} className="apple-btn w-full text-sm text-apple-gray-text hover:underline py-2">
          返回首页
        </button>
      </div>
      {scanning && (
        <QrScanner
          onClose={() => setScanning(false)}
          onResult={(token) => {
            setScanning(false);
            onScannedToken(token);
          }}
        />
      )}
    </GlassCard>
  );
}
function ConnectionStatusBar({ route, dcReady, paused, peerState }: { route: ConnectionRoute; dcReady: boolean; paused: boolean; peerState: 'connected' | 'reconnecting' }) {
  const routeIcon = route === 'turn' ? 'relay' : route === 'failed' ? 'alert' : 'wifi';
  return (
    <div className="mb-5 flex flex-wrap items-center justify-center gap-2 text-[11px] font-medium" aria-label="连接状态">
      <span className={`status-pill ${route === 'turn' ? 'bg-amber-50 text-amber-800' : route === 'failed' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
        <Icon name={routeIcon} size={14} />
        {routeLabel(route)}
      </span>
      {dcReady && (
        <span className="status-pill bg-blue-50 text-blue-700">
          <Icon name="shield" size={14} />端到端加密
        </span>
      )}
      {peerState === 'reconnecting' && (
        <span className="status-pill bg-amber-50 text-amber-800">
          <Icon name="retry" size={14} />对方信令重连中
        </span>
      )}
      {paused && (
        <span className="status-pill bg-gray-100 text-gray-700">
          <Icon name="pause" size={14} />已暂停
        </span>
      )}
    </div>
  );
}

function QueueList({ items }: { items: TransferQueueItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="queue-list" aria-label="文件队列">
      {items.map((item, index) => {
        const percent = item.size === 0 ? (item.status === 'done' ? 100 : 0) : Math.min(100, (item.transferred / item.size) * 100);
        const status = {
          pending: '等待中',
          active: `${Math.round(percent)}%`,
          done: '已完成',
          error: item.error || '失败'
        }[item.status];
        return (
          <div key={item.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
              item.status === 'done' ? 'bg-green-50 text-green-700' : item.status === 'error' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'
            }`}>
              <Icon name={item.status === 'done' ? 'check' : item.status === 'error' ? 'alert' : 'file'} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-apple-gray-dark">{item.name}</p>
                <span className="ml-auto shrink-0 text-[11px] text-apple-gray-text">{formatBytes(item.size)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div className={`h-full rounded-full transition-all ${item.status === 'error' ? 'bg-red-400' : item.status === 'done' ? 'bg-green-500' : 'bg-apple-blue'}`} style={{ width: `${percent}%` }} />
                </div>
                <span className={`max-w-[42%] truncate text-[11px] ${item.status === 'error' ? 'text-red-600' : 'text-apple-gray-text'}`}>{status}</span>
              </div>
            </div>
            <span className="sr-only">第 {index + 1} 个文件</span>
          </div>
        );
      })}
    </div>
  );
}

function ReceivedFilesList({ files, onDownload }: { files: ReceivedFile[]; onDownload: (file: ReceivedFile) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="mt-4 space-y-2" aria-label="已接收文件">
      {files.map((file, index) => (
        <div key={`${file.savedName}-${index}`} className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white px-3 py-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700"><Icon name="file" size={18} /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.savedName}</p>
            <p className="text-[11px] text-apple-gray-text">
              {formatBytes(file.meta.size)} · {file.savedToDisk ? '已保存到所选位置' : '已接收，可下载'}
            </p>
          </div>
          {file.blob && (
            <button type="button" onClick={() => onDownload(file)} className="rounded-lg p-2 text-apple-blue hover:bg-blue-50" aria-label={`下载 ${file.savedName}`}>
              <Icon name="download" size={19} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function CompletionSummary({ items, route, elapsed }: { items: TransferQueueItem[]; route: ConnectionRoute; elapsed: number | null }) {
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  return (
    <div className="mt-4 grid grid-cols-3 gap-2 text-center">
      <div className="summary-cell"><strong>{items.length}</strong><span>个文件</span></div>
      <div className="summary-cell"><strong>{formatBytes(totalBytes)}</strong><span>总大小</span></div>
      <div className="summary-cell"><strong>{formatDuration(elapsed)}</strong><span>{routeLabel(route)}</span></div>
    </div>
  );
}

interface TransferScreenProps {
  myRole: Role | null;
  peerState: 'connected' | 'reconnecting';
  dcReady: boolean;
  progress: number;
  batchProgress: number;
  transferStats: TransferStats | null;
  transferStatus: TransferStatus;
  transferError: string | null;
  queue: TransferQueueItem[];
  receivedFiles: ReceivedFile[];
  isPaused: boolean;
  connectionRoute: ConnectionRoute;
  transferElapsedSeconds: number | null;
  onFilesSelected: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: React.DragEvent) => void;
  onAccept: () => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onDownload: (file: ReceivedFile) => void;
  onReset: () => void;
}

function TransferScreen({
  myRole,
  peerState,
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
  onFilesSelected,
  onDrop,
  onAccept,
  onPause,
  onResume,
  onRetry,
  onCancel,
  onDownload,
  onReset
}: TransferScreenProps) {
  const [dragOver, setDragOver] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const isSender = myRole === 'sender';
  const isBusy = transferStatus === 'awaiting-accept' || transferStatus === 'sending' || transferStatus === 'receiving'
    || transferStatus === 'paused' || transferStatus === 'recovering';
  const activeIndex = queue.findIndex((item) => item.status === 'active');
  const activeItem = activeIndex >= 0 ? queue[activeIndex] : null;
  const totalBytes = queue.reduce((sum, item) => sum + item.size, 0);
  const mainProgress = queue.length > 1 ? batchProgress : progress;
  const directorySupported = typeof window !== 'undefined'
    && typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  const pickerAvailable = typeof window !== 'undefined'
    && (typeof (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function' || directorySupported);

  const picker = (
    <label
      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => { setDragOver(false); onDrop(event); }}
      className={`file-drop-zone ${dragOver ? 'is-dragging' : ''}`}
    >
      <input type="file" multiple onChange={onFilesSelected} className="file-input-hidden" />
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-apple-blue"><Icon name="folder" size={24} /></span>
      <p className="font-semibold text-apple-gray-dark">点击或拖拽文件到此处</p>
      <p className="text-sm text-apple-gray-text mt-1">支持同时选择多个文件</p>
    </label>
  );

  const error = errorHelp(transferError);

  return (
    <GlassCard className="fade-in !p-5 sm:!p-7">
      <div className="text-center mb-5">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-[20px] bg-blue-50 text-apple-blue">
          <Icon name={isSender ? 'upload' : 'download'} size={27} />
        </div>
        <h2 tabIndex={-1} className="text-xl font-semibold focus:outline-none">{isSender ? '发送文件' : '接收文件'}</h2>
        <p className="text-apple-gray-text text-sm mt-1">{dcReady ? '对方已连接' : '正在建立 WebRTC 通道...'}</p>
      </div>

      {(dcReady || transferStatus === 'recovering') && <ConnectionStatusBar route={connectionRoute} dcReady={dcReady} paused={isPaused} peerState={peerState} />}

      {transferStatus === 'idle' && isSender && (dcReady ? picker : (
        <div className="rounded-xl bg-gray-50 p-5 text-center text-sm text-apple-gray-text" role="status">通道建立后即可选择文件。</div>
      ))}

      {transferStatus === 'idle' && !isSender && (
        <div className="rounded-xl bg-gray-50 p-5 text-center text-sm text-apple-gray-text" role="status">等待发送方选择文件...</div>
      )}

      {transferStatus === 'awaiting-accept' && (
        <div>
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-apple-blue"><Icon name="file" size={20} /></span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-apple-gray-dark">{isSender ? '等待接收方确认' : '收到文件接收请求'}</p>
                <p className="text-sm text-apple-gray-text mt-1">{queue.length} 个文件 · {formatBytes(totalBytes)}</p>
              </div>
            </div>
            <QueueList items={queue} />
          </div>

          {!isSender && (
            <>
              <p className="mt-4 text-xs leading-5 text-apple-gray-text">
                {queue.length > 1 && directorySupported
                  ? '确认后将选择一次保存目录，队列中的文件会依次写入该目录。'
                  : pickerAvailable
                    ? '确认后将选择保存位置，文件会直接写入磁盘。'
                    : `当前浏览器使用内存接收，本次总大小上限 ${formatBytes(MAX_IN_MEMORY_FILE_SIZE)}。`}
              </p>
              {!pickerAvailable && totalBytes > MAX_IN_MEMORY_FILE_SIZE && (
                <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">当前文件超过内存模式上限，请使用最新版 Chrome 或 Edge。</p>
              )}
              {transferError && <p className="mt-3 text-center text-xs text-red-600" role="alert">{transferError}</p>}
              <div className="mt-4">
                <ActionButton
                  onClick={onAccept}
                  disabled={!pickerAvailable && totalBytes > MAX_IN_MEMORY_FILE_SIZE}
                  label={!pickerAvailable ? '开始接收' : queue.length > 1 && directorySupported ? '选择保存目录并接收' : '选择位置并接收'}
                />
              </div>
            </>
          )}
        </div>
      )}

      {(transferStatus === 'sending' || transferStatus === 'receiving' || transferStatus === 'paused' || transferStatus === 'recovering') && (
        <div>
          <QueueList items={queue} />
          <div className="mt-5 text-center" aria-live="polite">
            <p className="font-medium mb-2 truncate">
              {transferStatus === 'recovering' ? '正在恢复连接...' : isPaused ? '传输已暂停' : transferStatus === 'sending' ? '正在发送' : activeItem ? '正在接收' : '准备接收下一个文件'}
            </p>
            {activeItem && <p className="mb-3 truncate text-xs text-apple-gray-text">{activeItem.name}</p>}
            <Progress percent={mainProgress} />
            <div className="mt-2 flex justify-center gap-4 text-xs text-apple-gray-text">
              <span>{formatBytes(transferStats?.bytes || 0)} / {formatBytes(transferStats?.total || 0)}</span>
              <span>{formatSpeed(transferStats?.bytesPerSecond || 0)}</span>
              <span>{formatEta(transferStats?.etaSeconds ?? null)}</span>
            </div>
          </div>

          <div className={`mt-4 grid gap-2.5 ${transferStatus === 'recovering' ? 'grid-cols-1' : 'grid-cols-2'}`}>
            {transferStatus !== 'recovering' && (
              <button type="button" onClick={isPaused ? onResume : onPause} className="secondary-action">
                <Icon name={isPaused ? 'play' : 'pause'} size={17} />{isPaused ? '继续传输' : '暂停'}
              </button>
            )}
            <button type="button" onClick={() => setConfirmCancel(true)} className="danger-action">
              <Icon name="close" size={17} />取消传输
            </button>
          </div>
        </div>
      )}

      {transferStatus === 'done' && (
        <div aria-live="polite">
          <div className="text-center">
            <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-green-600"><Icon name="check" size={28} /></span>
            <p className="text-lg font-semibold">{isSender ? '对方已确认接收完成' : '全部文件接收完成'}</p>
            <p className="text-sm text-apple-gray-text mt-1">{isSender ? '文件已安全送达' : '文件已按队列顺序处理完成'}</p>
          </div>
          <CompletionSummary items={queue} route={connectionRoute} elapsed={transferElapsedSeconds} />
          {!isSender && <ReceivedFilesList files={receivedFiles} onDownload={onDownload} />}
          {isSender && <div className="mt-5">{picker}</div>}
        </div>
      )}

      {transferStatus === 'cancelled' && (
        <div className="rounded-2xl bg-gray-50 p-5 text-center" role="status">
          <Icon name="close" size={28} className="mx-auto mb-2 text-gray-500" />
          <p className="font-medium">本次传输已取消</p>
          <p className="mt-1 text-sm text-apple-gray-text">可以重新选择文件或结束会话。</p>
          {isSender && dcReady && <div className="mt-4">{picker}</div>}
        </div>
      )}

      {transferStatus === 'error' && (
        <div>
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4" role="alert">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-red-600"><Icon name="alert" size={20} /></span>
              <div>
                <p className="font-semibold text-red-900">{error.title}</p>
                <p className="mt-1 text-sm leading-5 text-red-800">{error.detail}</p>
              </div>
            </div>
          </div>
          {isSender && dcReady && (
            <div className="mt-4 grid grid-cols-2 gap-2.5">
              <button type="button" onClick={onRetry} className="secondary-action"><Icon name="retry" size={17} />重试当前文件</button>
              <button type="button" onClick={onReset} className="secondary-action"><Icon name="link" size={17} />重新配对</button>
            </div>
          )}
          {!isSender && <p className="mt-4 text-center text-xs text-apple-gray-text">等待发送方重试；如果连接已断开，请双方重新配对。</p>}
          {isSender && dcReady && <div className="mt-4">{picker}</div>}
        </div>
      )}

      {isBusy && confirmCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-5 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
            <h3 id="cancel-title" className="text-lg font-semibold">确认取消传输？</h3>
            <p className="mt-2 text-sm leading-5 text-apple-gray-text">当前文件不会完成，队列中的后续文件也会停止。</p>
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              <button type="button" autoFocus onClick={() => setConfirmCancel(false)} className="secondary-action">继续传输</button>
              <button type="button" onClick={() => { setConfirmCancel(false); onCancel(); }} className="danger-action justify-center bg-red-600 text-white hover:bg-red-700">确认取消</button>
            </div>
          </div>
        </div>
      )}

      <button type="button" onClick={isBusy ? () => setConfirmCancel(true) : onReset} className="mt-5 w-full py-2 text-sm text-apple-gray-text hover:underline">
        结束并返回首页
      </button>
    </GlassCard>
  );
}
