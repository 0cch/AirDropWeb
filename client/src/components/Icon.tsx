import React from 'react';

export type IconName =
  | 'box' | 'upload' | 'download' | 'file' | 'folder' | 'link'
  | 'copy' | 'share' | 'qr' | 'check' | 'alert' | 'shield'
  | 'wifi' | 'relay' | 'pause' | 'play' | 'close' | 'retry'
  | 'clock' | 'devices' | 'chevron';

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 20, className = '', strokeWidth = 1.8 }: IconProps) {
  const paths: Record<IconName, React.ReactNode> = {
    box: <><path d="m4 7 8-4 8 4-8 4-8-4Z" /><path d="m4 7 8 4 8-4v10l-8 4-8-4V7Z" /><path d="M12 11v10" /></>,
    upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></>,
    download: <><path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></>,
    file: <><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v5h5" /></>,
    folder: <><path d="M3 6h7l2 2h9v11H3V6Z" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    share: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" /></>,
    qr: <><rect x="3" y="3" width="6" height="6" /><rect x="15" y="3" width="6" height="6" /><rect x="3" y="15" width="6" height="6" /><path d="M15 15h2v2h-2zM19 15h2v4h-2M15 19h2v2h-2M19 21h2" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    alert: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5" /><path d="M12 18h.01" /></>,
    shield: <><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
    wifi: <><path d="M3 9a14 14 0 0 1 18 0" /><path d="M6.5 12.5a9 9 0 0 1 11 0" /><path d="M10 16a4 4 0 0 1 4 0" /><path d="M12 20h.01" /></>,
    relay: <><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 12h10" /><path d="m10 9 2 3-2 3M14 9l-2 3 2 3" /></>,
    pause: <><path d="M9 5v14M15 5v14" /></>,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    retry: <><path d="M20 7v5h-5" /><path d="M4 17a8 8 0 0 0 13.7 1L20 12" /><path d="M4 12a8 8 0 0 1 13.7-5L20 9" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    devices: <><rect x="3" y="5" width="13" height="10" rx="2" /><path d="M8 19h6M11 15v4" /><rect x="17" y="9" width="4" height="9" rx="1" /></>,
    chevron: <path d="m9 6 6 6-6 6" />
  };

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {paths[name]}
    </svg>
  );
}