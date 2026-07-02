import React from 'react';

interface ProgressProps {
  percent: number;
}

export function Progress({ percent }: ProgressProps) {
  return (
    <div className="w-full">
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-apple-blue transition-all duration-300 ease-out rounded-full"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-2 text-sm text-apple-gray-text text-center">{Math.round(percent)}%</div>
    </div>
  );
}
