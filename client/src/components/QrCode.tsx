import { useEffect, useState } from 'react';

interface QrCodeProps {
  value: string;
  size?: number;
}

export function QrCode({ value, size = 184 }: QrCodeProps) {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#1d1d1fff', light: '#ffffffff' }
    })).then((dataUrl) => {
      if (active) setSource(dataUrl);
    }).catch(() => {
      if (active) setSource(null);
    });
    return () => { active = false; };
  }, [size, value]);

  return (
    <div
      className="mx-auto flex items-center justify-center rounded-2xl border border-black/5 bg-white p-2 shadow-sm"
      style={{ width: size + 16, height: size + 16 }}
    >
      {source
        ? <img src={source} width={size} height={size} alt="扫描二维码加入文件传输会话" />
        : <span className="text-xs text-apple-gray-text">正在生成二维码...</span>}
    </div>
  );
}
