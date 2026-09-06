/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import { useEffect, useState } from 'react';

import {
  deleteFavorite,
  deleteFollowing,
  generateStorageKey,
  isFavorited,
  isFollowing,
  saveFavorite,
  saveFollowing,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { SearchResult } from '@/lib/types';

/** 最小化的引用类型，避免依赖 React 类型细节 */
interface RefLike<T> {
  current: T;
}

interface VideoActionsDeps {
  /** 当前播放源的标识（用于状态订阅），空串表示尚未确定 */
  source: string;
  /** 当前视频 id（用于状态订阅） */
  id: string;
  sourceRef: RefLike<string>;
  idRef: RefLike<string>;
  titleRef: RefLike<string>;
  detailRef: RefLike<SearchResult | null>;
  episodeIndexRef: RefLike<number>;
  /** 搜索标题，写入收藏/追更记录用于后续跳转 */
  searchTitle: string;
}

/**
 * 管理当前视频的收藏（favorite）与追更（following）状态，
 * 包括初始加载、跨端数据更新订阅以及切换逻辑。
 */
export function useVideoActions(deps: VideoActionsDeps) {
  const {
    source,
    id,
    sourceRef,
    idRef,
    titleRef,
    detailRef,
    episodeIndexRef,
    searchTitle,
  } = deps;

  const [favorited, setFavorited] = useState(false);
  const [following, setFollowing] = useState(false);

  // 每当 source 或 id 变化时检查收藏状态
  useEffect(() => {
    if (!source || !id) return;
    (async () => {
      try {
        const fav = await isFavorited(source, id);
        setFavorited(fav);
      } catch (err) {
        console.error('检查收藏状态失败:', err);
      }
    })();
  }, [source, id]);

  // 监听收藏数据更新事件
  useEffect(() => {
    if (!source || !id) return;

    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (favorites: Record<string, any>) => {
        const key = generateStorageKey(source, id);
        const isFav = !!favorites[key];
        setFavorited(isFav);
      }
    );

    return unsubscribe;
  }, [source, id]);

  // 切换收藏
  const handleToggleFavorite = async () => {
    if (
      !titleRef.current ||
      !detailRef.current ||
      !sourceRef.current ||
      !idRef.current
    )
      return;

    try {
      if (favorited) {
        // 如果已收藏，删除收藏
        await deleteFavorite(sourceRef.current, idRef.current);
        setFavorited(false);
      } else {
        // 如果未收藏，添加收藏
        await saveFavorite(sourceRef.current, idRef.current, {
          title: titleRef.current,
          source_name: detailRef.current?.source_name || '',
          year: detailRef.current?.year,
          cover: detailRef.current?.poster || '',
          total_episodes: detailRef.current?.episodes.length || 1,
          save_time: Date.now(),
          search_title: searchTitle,
        });
        setFavorited(true);
      }
    } catch (err) {
      console.error('切换收藏失败:', err);
    }
  };

  // 追更状态加载与订阅
  useEffect(() => {
    if (!source || !id) return;

    const refreshFollowingState = async () => {
      const isFollow = await isFollowing(source, id);
      setFollowing(isFollow);
    };

    refreshFollowingState();

    const unsubscribe = subscribeToDataUpdates(
      'followingsUpdated',
      (followings: Record<string, any>) => {
        const key = generateStorageKey(source, id);
        setFollowing(!!followings[key]);
      }
    );

    return unsubscribe;
  }, [source, id]);

  const handleToggleFollowing = async () => {
    if (
      !titleRef.current ||
      !detailRef.current ||
      !sourceRef.current ||
      !idRef.current
    )
      return;

    try {
      if (following) {
        await deleteFollowing(sourceRef.current, idRef.current);
        setFollowing(false);
      } else {
        await saveFollowing(sourceRef.current, idRef.current, {
          title: titleRef.current,
          source_name: detailRef.current?.source_name || '',
          year: detailRef.current?.year,
          cover: detailRef.current?.poster || '',
          total_episodes: detailRef.current?.episodes.length || 1,
          watched_episodes: episodeIndexRef.current + 1,
          save_time: Date.now(),
          search_title: searchTitle,
          source: sourceRef.current,
          id: idRef.current,
        });
        setFollowing(true);
      }
    } catch (err) {
      console.error('切换追更失败:', err);
    }
  };

  return { favorited, following, handleToggleFavorite, handleToggleFollowing };
}
