import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { extractToken } from '../lib/transferProtocol';

interface DetectedBarcodeLike {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcodeLike[]>;
}

interface BarcodeDetectorConstructor {
  new(options: { formats: string[] }): BarcodeDetectorLike;
}

interface QrScannerProps {
  onResult: (token: string) => void;
  onClose: () => void;
}

export function QrScanner({ onResult, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onResultRef = useRef(onResult);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => { onResultRef.current = onResult; }, [onResult]);

  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let stream: MediaStream | null = null;
    let detector: BarcodeDetectorLike | null = null;
    let fallbackDecoder: typeof import('jsqr').default | null = null;

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      for (const track of stream?.getTracks() || []) track.stop();
      stream = null;
    };

    const handleResult = (value: string): boolean => {
      const token = extractToken(value);
      if (!token) return false;
      stop();
      onResultRef.current(token);
      return true;
    };

    const scan = async () => {
      if (disposed) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        frame = requestAnimationFrame(() => void scan());
        return;
      }
      try {
        if (detector) {
          const results = await detector.detect(video);
          if (results.some((result) => handleResult(result.rawValue))) return;
        } else {
          if (!fallbackDecoder) {
            const module = await import('jsqr');
            fallbackDecoder = module.default;
          }
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (context) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            const result = fallbackDecoder(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
            if (result?.data && handleResult(result.data)) return;
          }
        }
      } catch {
        // A single unreadable frame should not stop the scanner.
      }
      if (!disposed) frame = requestAnimationFrame(() => void scan());
    };

    const start = async () => {
      if (!window.isSecureContext) {
        setError('摄像头扫码需要 HTTPS 或 localhost 安全环境');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('当前浏览器不支持摄像头访问，请手动输入 Token');
        return;
      }
      try {
        const BarcodeDetector = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
        if (BarcodeDetector) {
          try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        if (disposed) {
          stop();
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        if (!disposed) {
          setReady(true);
          frame = requestAnimationFrame(() => void scan());
        }
      } catch (cameraError) {
        const denied = cameraError instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(cameraError.name);
        const missing = cameraError instanceof DOMException && ['NotFoundError', 'DevicesNotFoundError'].includes(cameraError.name);
        setError(denied ? '摄像头权限被拒绝，请在浏览器设置中允许后重试' : missing ? '未找到可用摄像头' : '无法启动摄像头，请手动输入 Token');
      }
    };

    void start();
    return () => {
      disposed = true;
      stop();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
      <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="flex items-center justify-between px-5 pt-5">
          <div>
            <h2 id="scanner-title" className="text-lg font-semibold">扫描邀请二维码</h2>
            <p className="mt-1 text-xs text-apple-gray-text">二维码只在本地识别，不会上传摄像头画面</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-gray-500 hover:bg-gray-100" aria-label="关闭扫码">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="relative m-4 aspect-[4/3] overflow-hidden rounded-2xl bg-gray-950">
          <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
          <canvas ref={canvasRef} className="hidden" />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-44 w-44 rounded-2xl border-2 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]">
              <span className="absolute -left-0.5 -top-0.5 h-7 w-7 rounded-tl-xl border-l-4 border-t-4 border-apple-blue" />
              <span className="absolute -right-0.5 -top-0.5 h-7 w-7 rounded-tr-xl border-r-4 border-t-4 border-apple-blue" />
              <span className="absolute -bottom-0.5 -left-0.5 h-7 w-7 rounded-bl-xl border-b-4 border-l-4 border-apple-blue" />
              <span className="absolute -bottom-0.5 -right-0.5 h-7 w-7 rounded-br-xl border-b-4 border-r-4 border-apple-blue" />
            </div>
          </div>
          {!ready && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">正在启动摄像头...</div>
          )}
        </div>

        {error && <p className="mx-4 mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
        <button type="button" onClick={onClose} className="w-full border-t border-gray-100 py-3.5 text-sm font-medium text-apple-blue hover:bg-blue-50">
          手动输入 Token
        </button>
      </div>
    </div>
  );
}