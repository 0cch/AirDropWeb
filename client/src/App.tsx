import React, { useState, useEffect, useCallback } from 'react';
import { useSignaling } from './hooks/useSignaling';
import { useWebRTC } from './hooks/useWebRTC';
import { GlassCard } from './components/GlassCard';
import { ActionButton } from './components/ActionButton';
import { Progress } from './components/Progress';

type Screen = 'home' | 'waiting' | 'join' | 'transfer';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [inputToken, setInputToken] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const signaling = useSignaling();

  const {
    createOffer, sendFile, close, dcReady,
    progress, transferStatus, receivedFile
  } = useWebRTC(
    signaling.sendSignal,
    useCallback((cb) => signaling.setHandlers({ onSignal: cb }), []),
    signaling.myRole
  );

  // 连接信令服务器
  useEffect(() => {
    signaling.connect();
  }, []);

  // 配对成功后，sender 发起 WebRTC offer
  useEffect(() => {
    if (signaling.matched && signaling.myRole === 'sender') {
      createOffer();
    }
    if (signaling.matched) {
      setScreen('transfer');
    }
  }, [signaling.matched]);

  // 设置 peer-left 处理
  useEffect(() => {
    signaling.setHandlers({
      onPeerLeft: () => {
        close();
        setScreen('home');
        signaling.reset();
      }
    });
  }, []);

  const handleSend = () => {
    if (!signaling.connected) return;
    signaling.createRoom('sender');
    setScreen('waiting');
  };

  const handleReceive = () => {
    if (!signaling.connected) return;
    setScreen('join');
  };

  const handleJoin = () => {
    if (!inputToken.trim()) return;
    signaling.joinRoom('receiver', inputToken.trim());
    setScreen('waiting');
  };

  const handleCopyToken = () => {
    if (signaling.token) {
      navigator.clipboard.writeText(signaling.token);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      sendFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      setSelectedFile(file);
      sendFile(file);
    }
  };

  const handleDownload = () => {
    if (receivedFile) {
      const url = URL.createObjectURL(receivedFile.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = receivedFile.meta.name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleReset = () => {
    close();
    signaling.reset();
    setSelectedFile(null);
    setInputToken('');
    setScreen('home');
    signaling.connect();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {screen === 'home' && <HomeScreen onSend={handleSend} onReceive={handleReceive} connected={signaling.connected} />}

        {screen === 'waiting' && (
          <WaitingScreen
            token={signaling.token}
            myRole={signaling.myRole}
            error={signaling.error}
            onCopyToken={handleCopyToken}
            onBack={handleReset}
          />
        )}

        {screen === 'join' && (
          <JoinScreen
            inputToken={inputToken}
            onTokenChange={setInputToken}
            onJoin={handleJoin}
            onBack={() => setScreen('home')}
            error={signaling.error}
          />
        )}

        {screen === 'transfer' && (
          <TransferScreen
            myRole={signaling.myRole}
            dcReady={dcReady}
            progress={progress}
            transferStatus={transferStatus}
            selectedFile={selectedFile}
            receivedFile={receivedFile}
            onFileSelect={handleFileSelect}
            onDrop={handleDrop}
            onDownload={handleDownload}
            onReset={handleReset}
          />
        )}
      </div>
    </div>
  );
}

function HomeScreen({ onSend, onReceive, connected }: { onSend: () => void; onReceive: () => void; connected: boolean }) {
  return (
    <div className="fade-in">
      <div className="text-center mb-12">
        <div className="text-6xl mb-4">📦</div>
        <h1 className="text-3xl font-semibold text-apple-gray-dark mb-2">AirDrop Web</h1>
        <p className="text-apple-gray-text">点对点文件传输 · 无需服务器中转</p>
        {!connected && <p className="text-orange-500 text-sm mt-2">正在连接服务器...</p>}
      </div>
      <div className="space-y-4">
        <ActionButton onClick={onSend} label="📤 发送文件" disabled={!connected} />
        <ActionButton onClick={onReceive} label="📥 接收文件" variant="secondary" disabled={!connected} />
      </div>
      <p className="text-center text-xs text-apple-gray-text mt-8">
        文件通过 WebRTC 直接在两台设备间传输，安全且私密
      </p>
    </div>
  );
}

function WaitingScreen({ token, myRole, error, onCopyToken, onBack }: any) {
  return (
    <GlassCard>
      <div className="fade-in text-center">
        <div className="flex justify-center gap-1.5 mb-6">
          <span className="w-2.5 h-2.5 bg-apple-blue rounded-full pulse-dot" style={{ animationDelay: '0s' }} />
          <span className="w-2.5 h-2.5 bg-apple-blue rounded-full pulse-dot" style={{ animationDelay: '0.3s' }} />
          <span className="w-2.5 h-2.5 bg-apple-blue rounded-full pulse-dot" style={{ animationDelay: '0.6s' }} />
        </div>
        <h2 className="text-xl font-semibold mb-2">等待{myRole === 'sender' ? '接收方' : '发送方'}连接</h2>
        <p className="text-apple-gray-text text-sm mb-6">将以下 Token 分享给对方</p>
        {token && (
          <div className="mb-6">
            <div className="text-4xl font-bold tracking-wider text-apple-blue mb-2 select-all">{token}</div>
            <button onClick={onCopyToken} className="apple-btn text-sm text-apple-blue hover:underline">
              复制 Token
            </button>
          </div>
        )}
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        <button onClick={onBack} className="apple-btn text-sm text-apple-gray-text hover:underline">
          返回首页
        </button>
      </div>
    </GlassCard>
  );
}

function JoinScreen({ inputToken, onTokenChange, onJoin, onBack, error }: any) {
  return (
    <GlassCard>
      <div className="fade-in">
        <h2 className="text-2xl font-semibold text-center mb-2">输入 Token</h2>
        <p className="text-apple-gray-text text-sm text-center mb-6">请输入发送方分享给你的 Token</p>
        <input
          type="text"
          value={inputToken}
          onChange={(e) => onTokenChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onJoin()}
          placeholder="8位 Token"
          className="w-full text-center text-2xl tracking-widest border border-gray-200 rounded-lg py-4 mb-4 focus:outline-none focus:border-apple-blue focus:ring-2 focus:ring-apple-blue/20 transition-all"
          autoFocus
          maxLength={8}
        />
        {error && <p className="text-red-500 text-sm mb-4 text-center">{error}</p>}
        <div className="space-y-3">
          <ActionButton onClick={onJoin} label="连接" disabled={!inputToken.trim()} />
          <button onClick={onBack} className="apple-btn w-full text-sm text-apple-gray-text hover:underline py-2">
            返回首页
          </button>
        </div>
      </div>
    </GlassCard>
  );
}

function TransferScreen({ myRole, dcReady, progress, transferStatus, selectedFile, receivedFile, onFileSelect, onDrop, onDownload, onReset }: any) {
  const [dragOver, setDragOver] = useState(false);
  const isSender = myRole === 'sender';

  return (
    <GlassCard>
      <div className="fade-in">
        <div className="text-center mb-6">
          <div className="text-5xl mb-3">{isSender ? '📤' : '📥'}</div>
          <h2 className="text-xl font-semibold">{isSender ? '发送文件' : '接收文件'}</h2>
          <p className="text-apple-gray-text text-sm">
            {dcReady ? '已连接，可以' + (isSender ? '发送文件' : '等待接收') : '正在建立连接...'}
          </p>
        </div>

        {isSender && dcReady && transferStatus === 'idle' && (
          <label
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`block border-2 border-dashed rounded-apple-card p-12 text-center cursor-pointer transition-all ${
              dragOver ? 'border-apple-blue bg-apple-blue/5' : 'border-gray-300 hover:border-apple-blue'
            }`}
          >
            <input type="file" onChange={onFileSelect} className="file-input-hidden" />
            <div className="text-4xl mb-3">📁</div>
            <p className="font-medium text-apple-gray-dark">点击或拖拽文件到此处</p>
            <p className="text-sm text-apple-gray-text mt-1">支持任意类型文件</p>
          </label>
        )}

        {transferStatus !== 'idle' && transferStatus !== 'done' && (
          <div className="text-center mb-4">
            <p className="font-medium mb-3">
              {transferStatus === 'sending' ? `发送中: ${selectedFile?.name}` : '接收文件中...'}
            </p>
            <Progress percent={progress} />
          </div>
        )}

        {transferStatus === 'done' && (
          <div className="text-center mb-4 fade-in">
            <div className="text-4xl mb-2">✅</div>
            <p className="font-medium mb-1">{isSender ? '发送完成' : '接收完成'}</p>
            {!isSender && receivedFile && (
              <p className="text-sm text-apple-gray-text mb-4">{receivedFile.meta.name}</p>
            )}
            {!isSender && receivedFile && (
              <ActionButton onClick={onDownload} label="⬇️ 下载文件" />
            )}
            {isSender && dcReady && (
              <label className="block mt-4 cursor-pointer">
                <input type="file" onChange={onFileSelect} className="file-input-hidden" />
                <span className="apple-btn inline-block text-sm text-apple-blue hover:underline">继续发送另一个文件</span>
              </label>
            )}
          </div>
        )}

        <button onClick={onReset} className="apple-btn w-full text-sm text-apple-gray-text hover:underline py-2 mt-4">
          结束并返回首页
        </button>
      </div>
    </GlassCard>
  );
}
