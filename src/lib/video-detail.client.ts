'use client';

import { memoizeAsync } from './async-cache';

/**
 * 播放源简介获取（浏览器端）。
 * 简介来自播放源搜索结果中的 `vod_content`，与播放页保持一致。
 */
async function requestVideoDesc(
  source: string,
  id: string,
  title: string
): Promise<string> {
  const controller = new AbortController();
  // 搜索单源可能较慢，留出比详情接口更长的等待时间
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const params = new URLSearchParams({ source, id, fields: 'desc' });
    if (title) {
      params.set('title', title);
    }

    const response = await fetch(`/api/detail?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as { desc?: unknown };
    return typeof data.desc === 'string' ? data.desc : '';
  } finally {
    clearTimeout(timeoutId);
  }
}

export const getVideoDesc = memoizeAsync(
  (source: string, id: string, title = '') => `${source}::${id}::${title}`,
  requestVideoDesc
);
