'use client';

import { Download } from 'lucide-react';
import Link from 'next/link';
import { memo, useEffect, useState } from 'react';

import { BackButton } from './BackButton';
import { useSite } from './SiteProvider';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

interface MobileHeaderProps {
  showBackButton?: boolean;
}

const MobileHeader = ({ showBackButton = false }: MobileHeaderProps) => {
  const { siteName } = useSite();
  
  // 下载任务数量统计
  const [downloadTaskCount, setDownloadTaskCount] = useState(0);

  // 监听下载任务变化，更新角标
  useEffect(() => {
    const updateTaskCount = () => {
      if (typeof window !== 'undefined') {
        const saved = localStorage.getItem('downloadTasks');
        if (saved) {
          try {
            const tasks = JSON.parse(saved);
            // 统计未完成的任务数量（下载中、暂停、等待、错误）
            const activeCount = tasks.filter(
              (t: { status: string }) => 
                t.status === 'downloading' || 
                t.status === 'paused' || 
                t.status === 'waiting' || 
                t.status === 'error'
            ).length;
            setDownloadTaskCount(activeCount);
          } catch {
            setDownloadTaskCount(0);
          }
        } else {
          setDownloadTaskCount(0);
        }
      }
    };

    // 初始加载
    updateTaskCount();

    // 监听 localStorage 变化
    const handleStorageChange = () => {
      updateTaskCount();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', handleStorageChange);
      // 自定义事件：当任务列表更新时
      window.addEventListener('downloadTasksUpdated', handleStorageChange as EventListener);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', handleStorageChange);
        window.removeEventListener('downloadTasksUpdated', handleStorageChange as EventListener);
      }
    };
  }, []);

  return (
    <>
    <header className='md:hidden relative w-full bg-white/70 backdrop-blur-xl border-b border-gray-200/50 shadow-sm dark:bg-gray-900/70 dark:border-gray-700/50'>
      <div className='h-12 flex items-center justify-between px-4'>
        {/* 左侧：Logo 和返回按钮 */}
        <div className='flex items-center gap-3'>
          {showBackButton && <BackButton />}
          <Link
            href='/'
            className='text-xl font-bold text-green-600 tracking-tight hover:opacity-80 transition-opacity'
          >
            {siteName}
          </Link>
        </div>

        {/* 右侧按钮 */}
        <div className='flex items-center gap-2'>
          <button
            onClick={() => {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new Event('showDownloadManager'));
              }
            }}
            className='p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors relative'
            title='下载管理器'
          >
            <Download className='h-5 w-5' />
            {downloadTaskCount > 0 && (
              <span className='absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full h-4 w-4 flex items-center justify-center'>
                {downloadTaskCount > 9 ? '9+' : downloadTaskCount}
              </span>
            )}
          </button>
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
    </>
  );
};

// 使用 React.memo 优化，避免父组件更新时导致不必要的重新渲染
export default memo(MobileHeader);
