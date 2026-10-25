/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { clampSearchConcurrency, mapWithConcurrency } from '@/lib/concurrency';
import {
  ApiSite,
  getAvailableApiSites,
  getCacheTime,
  getConfig,
} from '@/lib/config';
import { searchFromApiStream } from '@/lib/downstream';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  // 检查是否为本地存储模式
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  const isLocalStorage = storageType === 'localstorage';

  let authInfo = null;
  if (!isLocalStorage) {
    // 非本地存储模式才需要认证
    authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const streamParam = searchParams.get('stream');
  const enableStream = streamParam ? streamParam !== '0' : false; // 无该参数关闭流式
  const timeoutParam = searchParams.get('timeout');
  const timeout = timeoutParam ? parseInt(timeoutParam, 10) * 1000 : undefined; // 转换为毫秒

  // 单次搜索同时查询的上游源数量，由前端搜索设置传入。
  // 服务端再做一次收敛，避免被构造请求放大到不受控的并发。
  const searchConcurrency = clampSearchConcurrency(
    searchParams.get('concurrency')
  );

  if (!query) {
    // 空查询无需读取配置，也无需创建流，明确不缓存
    return new Response(JSON.stringify({ results: [] }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    });
  }

  const config = await getConfig();

  // 获取用户可用的搜索源
  let apiSites = await getAvailableApiSites(authInfo?.username);

  // 如果指定了搜索源，只使用选中的搜索源
  const selectedSourcesParam = searchParams.get('sources');
  if (selectedSourcesParam) {
    const selectedSources = selectedSourcesParam.split(',');
    apiSites = apiSites.filter((site) => selectedSources.includes(site.key));
  }

  // -------------------------
  // 非流式：并发
  // -------------------------
  if (!enableStream) {
    const searchSite = async (site: ApiSite) => {
      const siteResults: any[] = [];
      let hasResults = false;
      try {
        const generator = searchFromApiStream(
          site,
          query,
          true,
          timeout,
          request.signal
        );
        for await (const pageResults of generator) {
          let filteredResults = pageResults;
          if (filteredResults.length !== 0) {
            hasResults = true;
          }
          if (!config.SiteConfig.DisableYellowFilter) {
            filteredResults = pageResults.filter((result) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word) => typeName.includes(word));
            });
          }
          if (hasResults && filteredResults.length === 0) {
            throw new Error('结果被过滤');
          }
          siteResults.push(...filteredResults);
        }
        if (!hasResults) {
          throw new Error('无搜索结果');
        }
        return { siteResults, failed: null };
      } catch (err: any) {
        let errorMessage = err.message || '未知的错误';

        // 根据错误类型提供更具体的错误信息
        if (err.message === '请求超时') {
          errorMessage = '请求超时';
        } else if (err.message === '请求失败') {
          errorMessage = '请求失败';
        } else if (err.message?.includes('网络错误')) {
          errorMessage = '网络错误';
        }

        return {
          siteResults: [],
          failed: { name: site.name, key: site.key, error: errorMessage },
        };
      }
    };

    const results = await mapWithConcurrency(
      apiSites,
      searchConcurrency,
      searchSite
    );
    const aggregatedResults = results.flatMap((r) => r.siteResults);
    const failedSources = results.filter((r) => r.failed).map((r) => r.failed);

    if (aggregatedResults.length === 0) {
      const body = { results: [], failedSources };
      return new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        },
      });
    } else {
      const cacheTime = await getCacheTime();
      const body = { results: aggregatedResults, failedSources };
      return new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `private, max-age=${cacheTime}`,
        },
      });
    }
  }

  // -------------------------
  // 流式：并发
  // -------------------------
  // 只有流式响应才需要创建 TransformStream 与 writer
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  // 安全写入与断连处理
  let shouldStop = false;
  const abortSignal = (request as any).signal as AbortSignal | undefined;
  abortSignal?.addEventListener('abort', () => {
    shouldStop = true;
    void writer.abort().catch(() => undefined);
  });

  const safeWrite = async (obj: unknown) => {
    if (shouldStop || abortSignal?.aborted) return false;
    try {
      await writer.write(encoder.encode(JSON.stringify(obj) + '\n'));
      return true;
    } catch {
      shouldStop = true;
      return false;
    }
  };

  (async () => {
    const failedSources: { name: string; key: string; error: string }[] = [];

    const searchSite = async (site: ApiSite) => {
      try {
        const generator = searchFromApiStream(
          site,
          query,
          true,
          timeout,
          request.signal
        );
        let hasResults = false;

        for await (const pageResults of generator) {
          let filteredResults = pageResults;
          if (filteredResults.length !== 0) {
            hasResults = true;
          }
          if (!config.SiteConfig.DisableYellowFilter) {
            filteredResults = pageResults.filter((result) => {
              const typeName = result.type_name || '';
              return !yellowWords.some((word) => typeName.includes(word));
            });
          }

          if (hasResults && filteredResults.length === 0) {
            failedSources.push({
              name: site.name,
              key: site.key,
              error: '结果被过滤',
            });
            await safeWrite({ failedSources });
            return;
          }

          if (
            !(await safeWrite({ site: site.key, pageResults: filteredResults }))
          ) {
            return;
          }
        }

        if (!hasResults) {
          failedSources.push({
            name: site.name,
            key: site.key,
            error: '无搜索结果',
          });
          await safeWrite({ failedSources });
        }
      } catch (err: any) {
        console.warn(`搜索失败 ${site.name}:`, err.message);
        let errorMessage = err.message || '未知的错误';

        // 根据错误类型提供更具体的错误信息
        if (err.message === '请求超时') {
          errorMessage = '请求超时';
        } else if (err.message === '请求失败') {
          errorMessage = '请求失败';
        } else if (err.message.includes('网络错误')) {
          errorMessage = '网络错误';
        }

        failedSources.push({
          name: site.name,
          key: site.key,
          error: errorMessage,
        });
        await safeWrite({ failedSources });
      }
    };

    // 等所有 site 跑完（受并发上限约束）
    await mapWithConcurrency(apiSites, searchConcurrency, searchSite);

    if (failedSources.length > 0) {
      await safeWrite({ failedSources });
    }

    try {
      await writer.close();
    } catch {
      // ignore
    }
  })();

  const cacheTime = await getCacheTime();
  return new Response(readable, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `private, max-age=${cacheTime}`,
    },
  });
}
