import { getAvailableApiSites } from '@/lib/config';
import { SearchResult } from '@/lib/types';

import { getDetailFromApi, searchFromApiStream } from './downstream';

interface FetchVideoDetailOptions {
  source: string;
  id: string;
  fallbackTitle?: string;
  timeout?: number; // 超时时间（毫秒）
}

/**
 * 根据 source 与 id 获取视频详情（支持流式搜索）。
 *
 * 获取集数的优先级：搜索 > 详情。
 *  - 优先通过流式搜索精确匹配 source+id（保证 source 一致）；
 *  - 不使用标题模糊匹配兜底，避免误取其他来源/其他视频的集数；
 *  - 仅当搜索无精确命中时，才调用详情接口兜底。
 */
export async function fetchVideoDetail({
  source,
  id,
  fallbackTitle = '',
  timeout,
}: FetchVideoDetailOptions): Promise<SearchResult> {
  const apiSites = await getAvailableApiSites();
  const apiSite = apiSites.find((site) => site.key === source);
  if (!apiSite) {
    throw new Error('无效的API来源');
  }

  // 使用流式搜索获取集数（优先级最高），仅接受 source 一致的精确匹配
  if (fallbackTitle) {
    try {
      for await (const results of searchFromApiStream(
        apiSite,
        fallbackTitle.trim(),
        true,
        timeout
      )) {
        for (const item of results) {
          // 精确匹配 source+id 且有集数，立即返回
          if (
            item.source.toString() === source.toString() &&
            item.id.toString() === id.toString() &&
            item.episodes &&
            item.episodes.length > 0
          ) {
            return item;
          }
        }
      }
    } catch (error) {
      // 流式搜索失败时忽略，继续走详情兜底
    }
  }

  // 搜索未精确命中或未提供 fallbackTitle，则调用详情接口兜底
  const detail = await getDetailFromApi(apiSite, id);
  if (!detail) {
    throw new Error('获取视频详情失败');
  }

  return detail;
}
