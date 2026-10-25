'use client';

import { memoizeAsync } from './async-cache';
import { getBangumiSubjectIntro } from './bangumi.client';
import { getDoubanIntro } from './douban.client';
import { getVideoDesc } from './video-detail.client';

export interface IntroTarget {
  /** Bangumi 条目 ID（每日放送） */
  bangumiId?: number;
  /** 豆瓣条目 ID */
  doubanId?: number;
  /** 播放源 key（播放记录 / 收藏 / 搜索） */
  source?: string;
  /** 播放源条目 ID */
  id?: string;
  /** 播放源标题，用于按标题搜索简介 */
  title: string;
}

async function loadIntro(target: IntroTarget): Promise<string> {
  const { bangumiId, doubanId, source, id, title } = target;

  if (bangumiId) {
    return getBangumiSubjectIntro(String(bangumiId));
  }

  if (doubanId) {
    try {
      const intro = await getDoubanIntro(String(doubanId));
      if (intro) {
        return intro;
      }
    } catch (error) {
      // 没有播放源可回退时把错误抛给调用方，避免把失败缓存成空简介
      if (!source || !id) {
        throw error;
      }
    }
  }

  if (source && id) {
    return getVideoDesc(source, id, title);
  }

  return '';
}

function introKey(target: IntroTarget): string {
  if (target.bangumiId) return `bangumi:${target.bangumiId}`;
  if (target.doubanId) return `douban:${target.doubanId}`;
  return `vod:${target.source}:${target.id}`;
}

/**
 * 统一获取卡片简介。
 * - 每日放送 → Bangumi
 * - 有豆瓣 ID → 豆瓣（失败或无简介时回退播放源）
 * - 其他 → 播放源搜索结果
 */
export const getIntro = memoizeAsync(introKey, loadIntro);
