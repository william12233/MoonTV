/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import { Download, Heart } from 'lucide-react';

import { SearchResult } from '@/lib/types';
import { processImageUrl } from '@/lib/utils';

import { FollowingIconButton } from '@/components/FollowingIcon';

interface VideoDetailPanelProps {
  videoTitle: string;
  videoYear: string;
  totalEpisodes: number;
  currentEpisodeIndex: number;
  detail: SearchResult | null;
  favorited: boolean;
  following: boolean;
  onToggleFavorite: () => void;
  onToggleFollowing: () => void;
  videoUrl: string;
  videoDoubanId: number;
  currentSource: string;
  currentId: string;
  onDownload: () => void;
}

/**
 * 播放页下方的影片标题、操作按钮与简介区域。
 */
export function VideoDetailPanel(props: VideoDetailPanelProps) {
  const {
    videoTitle,
    videoYear,
    totalEpisodes,
    currentEpisodeIndex,
    detail,
    favorited,
    following,
    onToggleFavorite,
    onToggleFollowing,
    videoUrl,
    videoDoubanId,
    currentSource,
    currentId,
    onDownload,
  } = props;

  return (
    <div className='grid grid-cols-1 gap-5 md:grid-cols-[auto_1fr] md:gap-6'>
      {/* 封面图片区 */}
      {detail?.poster && (
        <div className='mx-auto flex-shrink-0 md:mx-0'>
          <div className='aspect-[2/3] w-28 overflow-hidden rounded-xl bg-gray-200 shadow-md sm:w-36 md:w-44 lg:w-52 dark:bg-gray-700'>
            <img
              src={processImageUrl(detail.poster)}
              alt={videoTitle || '影片封面'}
              className='w-full h-full object-cover'
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.style.display = 'none';
              }}
            />
          </div>
        </div>
      )}
      {/* 文字区 */}
      <div className='flex w-full min-w-0 flex-col gap-3'>
        {/* 标题 + 操作按钮 */}
        <div className='flex flex-col gap-3 md:flex-row md:items-start md:justify-between'>
          <h1 className='flex min-w-0 flex-wrap items-center justify-center gap-x-2 text-xl font-bold tracking-wide sm:text-2xl md:justify-start'>
            <span className='min-w-0 truncate'>{videoTitle || '影片标题'}</span>
            {totalEpisodes > 1 && (
              <span className='text-base font-normal text-gray-500 sm:text-lg dark:text-gray-400'>
                {detail?.episodes_titles?.[currentEpisodeIndex] ||
                  `第 ${currentEpisodeIndex + 1} 集`}
              </span>
            )}
          </h1>
          <div className='flex flex-shrink-0 items-center justify-center gap-3 md:justify-end'>
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite();
                }}
                className={`flex h-8 w-8 items-center justify-center rounded-full shadow-md transition-all duration-300 ease-out hover:scale-[1.1] ${
                  favorited
                    ? 'bg-red-500 text-white hover:bg-red-600'
                    : 'bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                }`}
                title={favorited ? '取消收藏' : '加入收藏'}
                aria-label={favorited ? '取消收藏' : '加入收藏'}
              >
                <Heart
                  className={`h-4 w-4 ${
                    favorited
                      ? 'fill-white stroke-white'
                      : 'fill-transparent stroke-current stroke-[1.5]'
                  }`}
                />
              </button>
              {videoUrl && (
                <button
                  type='button'
                  onClick={() => onDownload()}
                  className='flex h-8 w-8 items-center justify-center rounded-full bg-blue-500 text-white shadow-md transition-all duration-300 ease-out hover:scale-[1.1] hover:bg-blue-600'
                  title='下载视频'
                  aria-label='下载视频'
                >
                  <Download className='h-4 w-4' />
                </button>
              )}
              {videoDoubanId !== 0 && (
                <a
                  href={`https://movie.douban.com/subject/${videoDoubanId.toString()}`}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='flex h-8 w-8 items-center justify-center rounded-full bg-green-500 text-white shadow-md transition-all duration-300 ease-out hover:scale-[1.1] hover:bg-green-600'
                  title='打开豆瓣页面'
                  aria-label='打开豆瓣页面'
                >
                  <svg
                    width='16'
                    height='16'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    aria-hidden='true'
                  >
                    <path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'></path>
                    <path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'></path>
                  </svg>
                </a>
              )}
              {currentSource && currentId && (
                <FollowingIconButton
                  following={following}
                  size={16}
                  padding={8}
                  theme='detail'
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFollowing();
                  }}
                />
              )}
          </div>
        </div>

        {/* 关键信息行 */}
        <div className='flex flex-wrap items-center justify-center gap-2 text-sm md:justify-start'>
          {detail?.class && (
            <span className='rounded-md bg-green-500/10 px-2 py-0.5 font-medium text-green-600 dark:text-green-400'>
              {detail.class}
            </span>
          )}
          {(detail?.year || videoYear) && (
            <span className='rounded-md bg-black/5 px-2 py-0.5 text-gray-600 dark:bg-white/10 dark:text-gray-300'>
              {detail?.year || videoYear}
            </span>
          )}
          {detail?.source_name && (
            <span className='rounded-md bg-black/5 px-2 py-0.5 text-gray-600 dark:bg-white/10 dark:text-gray-300'>
              {detail.source_name}
            </span>
          )}
          {detail?.type_name && (
            <span className='rounded-md bg-black/5 px-2 py-0.5 text-gray-600 dark:bg-white/10 dark:text-gray-300'>
              {detail.type_name}
            </span>
          )}
        </div>

        {/* 剧情简介 */}
        {detail?.desc && (
          <div
            className='scrollbar-hide max-h-48 overflow-y-auto pr-1 text-sm leading-relaxed text-gray-600 md:max-h-none dark:text-gray-300'
            style={{ whiteSpace: 'pre-line' }}
          >
            {detail.desc}
          </div>
        )}
      </div>
    </div>
  );
}
