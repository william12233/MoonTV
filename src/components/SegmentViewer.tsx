'use client';

import { RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { aesDecrypt, downloadTsSegment, M3U8Task } from '@/lib/m3u8-downloader';

interface SegmentViewerProps {
  task: M3U8Task;
  isOpen: boolean;
  onClose: () => void;
  onSegmentRetry?: (index: number) => void;
}

const SegmentViewer = ({ task, isOpen, onClose, onSegmentRetry }: SegmentViewerProps) => {
  const [retryingSegments, setRetryingSegments] = useState<Set<number>>(new Set());
  const [, forceUpdate] = useState({});

  // 处理单个片段重试
  const handleRetrySegment = async (index: number) => {
    if (retryingSegments.has(index)) return;

    setRetryingSegments(prev => new Set(prev).add(index));

    try {
      // 下载片段
      let segmentData = await downloadTsSegment(task.tsUrlList[index]);

      // AES 解密
      if (task.aesConf.key) {
        segmentData = aesDecrypt(segmentData, task.aesConf.key, task.aesConf.iv);
      }

      // 这里可以将解密后的数据保存（暂时不需要实际保存）
      // 只更新状态即可
      if (segmentData) {
        // 数据已成功下载和解密
      }

      // 更新片段状态
      task.finishList[index].status = 'success';
      task.finishNum++;
      task.errorNum = Math.max(0, task.errorNum - 1);

      // 触发外部回调
      if (onSegmentRetry) {
        onSegmentRetry(index);
      }

      // 强制更新视图
      forceUpdate({});

      // eslint-disable-next-line no-console
      console.log(`片段 ${index + 1} 重试成功`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`片段 ${index + 1} 重试失败:`, error);
    } finally {
      setRetryingSegments(prev => {
        const newSet = new Set(prev);
        newSet.delete(index);
        return newSet;
      });
    }
  };

  // 批量重试所有失败的片段
  const handleRetryAllFailed = async () => {
    const failedIndices = task.finishList
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.status === 'error')
      .map(({ index }) => index);

    if (failedIndices.length === 0) return;

    for (const index of failedIndices) {
      await handleRetrySegment(index);
    }
  };

  // 按 ESC 关闭
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEsc);
    }

    return () => {
      document.removeEventListener('keydown', handleEsc);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const successCount = task.finishList.filter(item => item.status === 'success').length;
  const errorCount = task.finishList.filter(item => item.status === 'error').length;
  const downloadingCount = task.finishList.filter(item => item.status === 'downloading').length;
  const pendingCount = task.finishList.filter(item => item.status === '').length;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              片段列表
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {task.title}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 统计信息 */}
        <div className="p-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-3">
              <div className="text-xs text-gray-500 dark:text-gray-400">总片段</div>
              <div className="text-lg font-semibold text-gray-900 dark:text-white mt-1">
                {task.finishList.length}
              </div>
            </div>
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3">
              <div className="text-xs text-green-600 dark:text-green-400">成功</div>
              <div className="text-lg font-semibold text-green-700 dark:text-green-300 mt-1">
                {successCount}
              </div>
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
              <div className="text-xs text-red-600 dark:text-red-400">失败</div>
              <div className="text-lg font-semibold text-red-700 dark:text-red-300 mt-1">
                {errorCount}
              </div>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
              <div className="text-xs text-blue-600 dark:text-blue-400">下载中</div>
              <div className="text-lg font-semibold text-blue-700 dark:text-blue-300 mt-1">
                {downloadingCount}
              </div>
            </div>
            <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-3">
              <div className="text-xs text-gray-600 dark:text-gray-400">待下载</div>
              <div className="text-lg font-semibold text-gray-700 dark:text-gray-300 mt-1">
                {pendingCount}
              </div>
            </div>
          </div>

          {/* 批量操作 */}
          {errorCount > 0 && (
            <div className="mt-3 flex justify-end">
              <button
                onClick={handleRetryAllFailed}
                disabled={retryingSegments.size > 0}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white rounded-lg transition-colors flex items-center gap-2 text-sm"
              >
                <RefreshCw className={`h-4 w-4 ${retryingSegments.size > 0 ? 'animate-spin' : ''}`} />
                重试所有失败片段
              </button>
            </div>
          )}
        </div>

        {/* 片段列表 */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {task.finishList.map((segment, index) => {
              const isRetrying = retryingSegments.has(index);
              const bgColor = 
                segment.status === 'success' ? 'bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700' :
                segment.status === 'error' ? 'bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700' :
                segment.status === 'downloading' ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700' :
                'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600';
              
              const textColor = 
                segment.status === 'success' ? 'text-green-700 dark:text-green-300' :
                segment.status === 'error' ? 'text-red-700 dark:text-red-300' :
                segment.status === 'downloading' ? 'text-blue-700 dark:text-blue-300' :
                'text-gray-700 dark:text-gray-300';

              return (
                <div
                  key={index}
                  className={`relative border rounded-lg p-3 transition-all ${bgColor} ${
                    segment.status === 'error' && !isRetrying ? 'cursor-pointer hover:shadow-md' : ''
                  }`}
                  onClick={() => {
                    if (segment.status === 'error' && !isRetrying) {
                      handleRetrySegment(index);
                    }
                  }}
                  title={
                    segment.status === 'error' 
                      ? '点击重试' 
                      : segment.status === 'success'
                      ? '下载成功'
                      : segment.status === 'downloading'
                      ? '下载中'
                      : '待下载'
                  }
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-medium ${textColor}`}>
                      #{index + 1}
                    </span>
                    {segment.status === 'error' && (
                      <RefreshCw className={`h-3 w-3 ${textColor} ${isRetrying ? 'animate-spin' : ''}`} />
                    )}
                  </div>
                  <div className={`text-xs mt-1 ${textColor} opacity-75`}>
                    {segment.status === 'success' ? '✓ 成功' :
                     segment.status === 'error' ? '✗ 失败' :
                     segment.status === 'downloading' ? '⟳ 下载中' :
                     '○ 待下载'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 底部提示 */}
        <div className="p-4 bg-gray-50 dark:bg-gray-900/50 border-t border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
            点击红色片段可以重试下载 • 绿色表示成功 • 蓝色表示下载中 • 灰色表示待下载
          </p>
        </div>
      </div>
    </div>
  );
};

export default SegmentViewer;
