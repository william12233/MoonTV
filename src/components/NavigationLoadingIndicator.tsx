'use client';

import { useEffect, useState } from 'react';

import { useNavigationLoading } from './NavigationLoadingProvider';

export function NavigationLoadingIndicator() {
  const { isLoading } = useNavigationLoading();
  const [visible, setVisible] = useState(false);
  const [doorsClosed, setDoorsClosed] = useState(false);

  useEffect(() => {
    if (isLoading) {
      // 先挂载遮罩，再在下一帧打开，保证首次出现时也有淡入过渡
      setVisible(true);
      const raf = requestAnimationFrame(() => setDoorsClosed(true));
      return () => cancelAnimationFrame(raf);
    }

    // 关闭时先淡出，等过渡结束后再卸载，避免动画被截断
    setDoorsClosed(false);
    const timer = setTimeout(() => setVisible(false), 500);
    return () => clearTimeout(timer);
  }, [isLoading]);

  if (!visible) return null;

  return (
    <>
      {/* 全屏加载遮罩 */}
      <div
        className='fixed inset-0 z-[50] flex items-center justify-center bg-white/90 backdrop-blur-xl transition-opacity duration-500 dark:bg-gray-900/90'
        style={{
          opacity: doorsClosed ? 1 : 0,
          pointerEvents: doorsClosed ? 'auto' : 'none',
        }}
      >
        {/* 中心加载动画 + 文字（flex-col 布局，保证首次加载也居中） */}
        <div className='flex flex-col items-center justify-center gap-6'>
          {/* 月亮形状 */}
          <div className='relative w-20 h-20'>
            {/* 月亮主体 */}
            <div
              className='absolute inset-0 bg-gradient-to-br from-yellow-300 to-yellow-500 dark:from-yellow-400 dark:to-yellow-600 rounded-full shadow-lg shadow-yellow-500/30 animate-bounce'
              style={{ animationDuration: '2s' }}
            >
              {/* 月亮上的小坑 */}
              <div className='absolute top-3 left-4 w-2 h-2 bg-yellow-600/40 dark:bg-yellow-700/40 rounded-full' />
              <div className='absolute top-6 right-5 w-1.5 h-1.5 bg-yellow-600/40 dark:bg-yellow-700/40 rounded-full' />
              <div className='absolute bottom-4 left-6 w-1 h-1 bg-yellow-600/40 dark:bg-yellow-700/40 rounded-full' />
            </div>

            <div
              className='absolute -bottom-1 -left-1 w-2 h-2 bg-yellow-400 dark:bg-yellow-300 rounded-full animate-spin'
              style={{ animationDuration: '4s', animationDirection: 'reverse' }}
            >
              <div className='absolute inset-0 flex items-center justify-center'>
                <div className='w-0.5 h-0.5 bg-yellow-600 dark:bg-yellow-500 rounded-full' />
              </div>
            </div>
          </div>

          {/* 加载文字 */}
          <div className='text-gray-700 dark:text-gray-300 font-medium text-sm'>
            <span className='animate-pulse'>🌙</span>
            <span className='animate-pulse' style={{ animationDelay: '0.2s' }}>
              {' '}
              月亮正在努力加载中
            </span>
            <span className='animate-pulse' style={{ animationDelay: '0.4s' }}>
              {' '}
              ✨
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
