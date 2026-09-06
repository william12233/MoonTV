import React from 'react';

interface FollowingIconProps {
  filled?: boolean;
  size?: number;
  className?: string;
  variant?: 'default' | 'add' | 'remove';
}

const FollowingIcon: React.FC<FollowingIconProps> = ({
  filled = false,
  size = 20,
  className = '',
  variant = 'default',
}) => {
  const iconPath =
    variant === 'remove'
      ? 'M4.25 11.25a.75.75 0 0 0 0 1.5h15.5a.75.75 0 0 0 0-1.5H4.25Z'
      : 'M12 2.75a.75.75 0 0 1 .75.75V11h7.5a.75.75 0 0 1 0 1.5h-7.5v7.5a.75.75 0 0 1-1.5 0v-7.5H4.25a.75.75 0 0 1 0-1.5h7.5V3.5a.75.75 0 0 1 .75-.75Z';

  return (
    <svg
      viewBox='0 0 24 24'
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke='currentColor'
      strokeWidth={Math.max(1.5, size / 8)}
      strokeLinecap='round'
      strokeLinejoin='round'
      className={className}
      aria-hidden='true'
    >
      <path d={iconPath} />
    </svg>
  );
};

interface FollowingIconButtonProps {
  following: boolean;
  size?: number;
  padding?: number;
  theme?: 'card' | 'detail';
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export const FollowingIconButton: React.FC<FollowingIconButtonProps> = ({
  following,
  size = 16,
  padding = 8,
  theme = 'card',
  className = '',
  onClick,
}) => {
  const buttonSize = size + padding * 2;
  const themeClasses =
    theme === 'detail'
      ? following
        ? 'bg-amber-500 text-white'
        : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-amber-100 dark:hover:bg-gray-600'
      : following
        ? 'bg-amber-500 text-white'
        : 'bg-gray-200/95 text-gray-700 hover:bg-amber-100';

  return (
    <button
      type='button'
      onClick={onClick}
      style={{ width: buttonSize, height: buttonSize }}
      className={`flex flex-shrink-0 items-center justify-center rounded-full shadow-md transition-all duration-300 ease-out hover:scale-[1.1] ${themeClasses} ${className}`}
      title={following ? '取消追更' : '加入追更'}
      aria-label={following ? '取消追更' : '加入追更'}
    >
      <FollowingIcon filled={following} size={size} />
    </button>
  );
};

export default FollowingIcon;
