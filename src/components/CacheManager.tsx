'use client';

import { Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  type EpisodeCacheStat,
  type SegmentMeta,
  clearVideoCache,
  deleteEpisodeCache,
  getCachedSegmentRecords,
  getEpisodeCacheStats,
  loadCacheSettings,
  mergeCachedTimeRanges,
  saveCacheSettings,
} from '@/lib/video-cache';

function formatCacheTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function normalizeSourceName(source?: string): string {
  const value = source?.trim();
  if (!value) return '未知来源';

  if (/^https?:\/\//i.test(value)) {
    try {
      const host = new URL(value).hostname.replace(/^www\./i, '');
      return host || '未知来源';
    } catch {
      return '未知来源';
    }
  }

  if (value.includes('.') && !/\s/.test(value)) {
    const host = value.replace(/^www\./i, '').split('.')[0];
    return host || '未知来源';
  }

  return value;
}

function formatEpisodeCacheMetadata(ep: {
  source?: string;
  episodeKey: string;
}): string {
  const source = normalizeSourceName(ep.source);
  const episodeParts = ep.episodeKey.split(':').filter(Boolean);
  const rawEpisodeIndex = Number(episodeParts[episodeParts.length - 1]);
  const episodeNumber = Number.isNaN(rawEpisodeIndex) ? 1 : rawEpisodeIndex + 1;

  return `${source} · 第 ${episodeNumber} 集`;
}

interface CacheManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * 视频缓存管理面板：展示每个已缓存剧集的占用，支持按剧集删除或一键清空。
 */
export default function CacheManager({ isOpen, onClose }: CacheManagerProps) {
  const [episodes, setEpisodes] = useState<EpisodeCacheStat[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(false);
  const [autoClear, setAutoClear] = useState(false);
  const [records, setRecords] = useState<SegmentMeta[]>([]);
  const [expandedEpisode, setExpandedEpisode] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [stats, segments] = await Promise.all([
        getEpisodeCacheStats(),
        getCachedSegmentRecords(),
      ]);
      setEpisodes(stats);
      setRecords(segments);
      setTotalBytes(segments.reduce((sum, record) => sum + record.bytes, 0));
    } catch {
      // 暂时无法读取存储时保留上次展示结果。
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setAutoClear(loadCacheSettings().autoClearOnEpisodeChange);
      void refresh();
      const timer = window.setInterval(() => void refresh(true), 2000);
      return () => window.clearInterval(timer);
    }
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  const handleDeleteEpisode = async (episodeKey: string) => {
    await deleteEpisodeCache(episodeKey);
    void refresh();
  };

  const handleClearAll = async () => {
    await clearVideoCache();
    void refresh();
  };

  return (
    <div className='fixed inset-0 z-[3000] flex items-center justify-center bg-black/50 p-4'>
      <div className='w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl bg-white dark:bg-gray-800 shadow-xl'>
        {/* 头部 */}
        <div className='flex items-center justify-between border-b border-gray-200/60 dark:border-gray-700/60 px-5 py-4'>
          <div>
            <h2 className='text-base font-medium text-gray-900 dark:text-gray-100'>
              视频缓存管理
            </h2>
            <p className='text-xs text-gray-500 dark:text-gray-400 mt-0.5'>
              共占用 {formatBytes(totalBytes)}
            </p>
          </div>
          <button
            onClick={onClose}
            className='rounded-full p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'
            aria-label='关闭'
          >
            <X className='h-5 w-5' />
          </button>
        </div>

        <div className='flex items-center justify-between gap-4 border-b border-gray-200/60 px-5 py-3 dark:border-gray-700/60'>
          <div>
            <div className='text-sm text-gray-900 dark:text-gray-100'>
              切集/换片自动清空
            </div>
            <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
              切换集数或换片时清理其他缓存，保留当前集和下一集预热
            </p>
          </div>
          <button
            type='button'
            role='switch'
            aria-checked={autoClear}
            aria-label='切集/换片自动清空'
            onClick={() => {
              const enabled = !autoClear;
              saveCacheSettings({ autoClearOnEpisodeChange: enabled });
              setAutoClear(enabled);
            }}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 ${
              autoClear ? 'bg-[#56c267]' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${
                autoClear ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* 列表 */}
        <div className='flex-1 overflow-y-auto px-5 py-4'>
          {loading ? (
            <div className='py-10 text-center text-sm text-gray-400'>
              加载中...
            </div>
          ) : episodes.length === 0 ? (
            <div className='py-10 text-center text-sm text-gray-400'>
              暂无缓存内容
            </div>
          ) : (
            <ul className='space-y-2'>
              {episodes.map((ep) => {
                const episodeRecords = records.filter(
                  (record) => record.episodeKey === ep.episodeKey
                );
                const ranges = mergeCachedTimeRanges(episodeRecords);
                const coveredSeconds = ranges.reduce(
                  (sum, range) => sum + range.endTime - range.startTime,
                  0
                );
                const unknownCount = episodeRecords.filter(
                  (record) =>
                    record.startTime === undefined ||
                    record.endTime === undefined
                ).length;
                return (
                  <li
                    key={ep.episodeKey}
                    className='rounded-lg bg-gray-50 dark:bg-gray-700/40 px-3 py-2'
                  >
                    <div className='flex items-start justify-between gap-3'>
                      <div className='min-w-0 flex-1'>
                        <div className='whitespace-normal text-sm leading-5 text-gray-800 [overflow-wrap:anywhere] dark:text-gray-200'>
                          {ep.title?.trim() || '未知影片'}
                        </div>
                        <div className='mt-1 whitespace-normal text-xs leading-5 text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400'>
                          {formatEpisodeCacheMetadata(ep)}
                        </div>
                        <div className='mt-0.5 whitespace-normal text-xs leading-5 text-gray-500 [overflow-wrap:anywhere] dark:text-gray-400'>
                          {ep.segments} 片段 · {formatBytes(ep.bytes)}
                          {coveredSeconds > 0 &&
                            ` · 已覆盖 ${formatCacheTime(coveredSeconds)}`}
                        </div>
                        <button
                          type='button'
                          aria-expanded={expandedEpisode === ep.episodeKey}
                          onClick={() =>
                            setExpandedEpisode(
                              expandedEpisode === ep.episodeKey
                                ? null
                                : ep.episodeKey
                            )
                          }
                          className='mt-1 text-xs text-green-600 hover:text-green-700 dark:text-green-400'
                        >
                          {expandedEpisode === ep.episodeKey
                            ? '收起详情'
                            : '缓存详情'}
                        </button>
                      </div>
                      <button
                        onClick={() => handleDeleteEpisode(ep.episodeKey)}
                        className='shrink-0 rounded-full p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/30'
                        aria-label='删除该剧集缓存'
                        title='删除该剧集缓存'
                      >
                        <Trash2 className='h-4 w-4' />
                      </button>
                    </div>
                    {expandedEpisode === ep.episodeKey && (
                      <div className='mt-3 space-y-2 border-t border-gray-200/60 pt-2 text-xs dark:border-gray-600'>
                        {ranges.map((range) => (
                          <div
                            key={`${range.startTime}-${range.endTime}`}
                            className='flex flex-wrap justify-between gap-1 text-gray-600 dark:text-gray-300'
                          >
                            <span>
                              片段 {range.firstIndex} - {range.lastIndex}
                            </span>
                            <span className='font-mono tabular-nums'>
                              {formatCacheTime(range.startTime)} -{' '}
                              {formatCacheTime(range.endTime)}
                            </span>
                          </div>
                        ))}
                        {unknownCount > 0 && (
                          <p className='text-gray-400'>
                            {unknownCount}{' '}
                            个旧片段暂无时间信息，播放该集后自动补齐
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 底部 */}
        <div className='border-t border-gray-200/60 dark:border-gray-700/60 px-5 py-3'>
          <button
            onClick={handleClearAll}
            disabled={episodes.length === 0}
            className='w-full rounded-lg bg-red-500 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40'
          >
            清空全部缓存
          </button>
        </div>
      </div>
    </div>
  );
}
