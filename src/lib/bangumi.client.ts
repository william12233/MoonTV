'use client';

import { memoizeAsync } from './async-cache';

export interface BangumiCalendarData {
  weekday: {
    en: string;
  };
  items: {
    id: number;
    name: string;
    name_cn: string;
    rating: {
      score: number;
    };
    air_date: string;
    images: {
      large: string;
      common: string;
      medium: string;
      small: string;
      grid: string;
    };
  }[];
}

/**
 * 校验 /api/bangumi/calendar 返回的单条数据。
 * 上游（Bangumi 代理）返回结构不可信，脏数据会在渲染层触发
 * `Cannot read properties of undefined` 之类的崩溃，因此在入口处过滤。
 */
function isBangumiCalendarEntry(value: unknown): value is BangumiCalendarData {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { weekday?: unknown; items?: unknown };
  if (!entry.weekday || typeof entry.weekday !== 'object') return false;
  const weekday = entry.weekday as { en?: unknown };
  return typeof weekday.en === 'string' && Array.isArray(entry.items);
}

export async function GetBangumiCalendarData(): Promise<BangumiCalendarData[]> {
  try {
    const response = await fetch('/api/bangumi/calendar', {
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return [];
    return data.filter(isBangumiCalendarEntry);
  } catch (error) {
    // 日历属于非关键数据，失败时降级为空数组，仅记录日志便于排查
    // eslint-disable-next-line no-console
    console.error('Bangumi 日历请求失败:', error);
    return [];
  }
}

async function requestSubjectIntro(id: string): Promise<string> {
  const response = await fetch(
    `/api/detail?provider=bangumi&id=${encodeURIComponent(id)}&fields=desc`,
    {
      headers: {
        Accept: 'application/json',
      },
    }
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as { desc?: unknown };
  return typeof data.desc === 'string' ? data.desc : '';
}

/**
 * 获取 Bangumi 条目简介。
 * 通过服务端 /api/detail?provider=bangumi 获取，复用站点配置的 Bangumi 代理。
 */
export const getBangumiSubjectIntro = memoizeAsync(
  (id: string) => id,
  requestSubjectIntro
);
