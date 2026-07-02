import React from 'react';

interface ActionButtonProps {
  onClick: () => void;
  label: string;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}

export function ActionButton({ onClick, label, variant = 'primary', disabled }: ActionButtonProps) {
  const bg = variant === 'primary' ? 'bg-apple-blue hover:bg-apple-blue-hover' : 'bg-apple-gray hover:bg-gray-200';
  const textColor = variant === 'primary' ? 'text-white' : 'text-apple-gray-dark';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`apple-btn w-full rounded-apple-btn py-4 font-semibold text-lg ${bg} ${textColor} transition-colors ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {label}
    </button>
  );
}
