import React from 'react';

interface ProgressProps {
  percent: number;
  label?: string;
}

export function Progress({ percent, label = '文件传输进度' }: ProgressProps) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div className="w-full">
      <div
        className="h-2 bg-gray-200 rounded-full overflow-hidden"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
      >
        <div
          className="h-full bg-apple-blue transition-all duration-300 ease-out rounded-full"
          style={{ width: `${value}%` }}
        />
      </div>
      <div className="mt-2 text-sm text-apple-gray-text text-center" aria-hidden="true">{Math.round(value)}%</div>
    </div>
  );
}