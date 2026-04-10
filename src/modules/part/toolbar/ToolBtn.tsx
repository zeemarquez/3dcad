import React, { useState } from 'react';

export const ToolBtn: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  variant?: 'default' | 'constraint' | 'dimension' | 'danger';
  onClick: () => void;
  title?: string;
  iconSrc?: string;
  iconAlt?: string;
  showLabel?: boolean;
  disabled?: boolean;
}> = ({
  icon: Icon,
  label,
  active,
  variant = 'default',
  onClick,
  title,
  iconSrc,
  iconAlt,
  showLabel = true,
  disabled = false,
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const ring =
    variant === 'constraint'
      ? 'hover:border-blue-500/50'
      : variant === 'dimension'
        ? 'hover:border-amber-500/50'
        : variant === 'danger'
          ? 'border-red-500/40 hover:border-red-400'
          : 'hover:border-zinc-300';
  const bg =
    variant === 'danger'
      ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400'
      : 'bg-white hover:bg-zinc-100';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={`flex flex-col items-center justify-center w-14 h-12 rounded-md border transition-colors ${
        active
          ? 'bg-blue-600/20 border-blue-500 text-blue-500'
          : `${bg} border-zinc-300 ${ring}`
      } ${disabled ? 'opacity-45 cursor-not-allowed hover:bg-white hover:border-zinc-300' : ''}`}
    >
      {iconSrc && !imgFailed ? (
        <img
          src={iconSrc}
          alt={iconAlt ?? label}
          onError={() => setImgFailed(true)}
          className={`w-9 h-9 object-contain ${showLabel ? 'mb-0.5' : ''}`}
        />
      ) : (
        <Icon className={`w-6 h-6 stroke-[1.5] ${showLabel ? 'mb-0.5' : ''}`} />
      )}
      {showLabel && <span className="text-[9px] font-medium leading-tight whitespace-nowrap">{label}</span>}
    </button>
  );
};

export const Sep = () => <div className="w-px self-stretch bg-zinc-300 mx-1 shrink-0" />;
