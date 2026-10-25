import { getConfig } from '@/lib/config';

interface BangumiSubjectApiResponse {
  id?: number;
  name?: string;
  name_cn?: string;
  date?: string;
  summary?: string;
  rating?: {
    score?: number;
  };
}

export interface BangumiSubjectDetailData {
  id: string;
  title: string;
  year: string;
  rate: string;
  summary: string;
}

/**
 * 获取 Bangumi 条目详情（服务端）。
 * 支持站点配置的 Bangumi 代理，并在代理失败时回退官方 API。
 */
export async function fetchBangumiSubjectDetail(
  id: string
): Promise<BangumiSubjectDetailData> {
  const config = await getConfig();
  const bangumiProxy =
    config.SiteConfig.BangumiProxy ||
    process.env.NEXT_PUBLIC_BANGUMI_PROXY ||
    '';

  const baseUrl = bangumiProxy
    ? bangumiProxy.replace(/\/+$/, '')
    : 'https://api.bgm.tv';

  const urls = bangumiProxy
    ? [`${baseUrl}/v0/subjects/${id}`, `https://api.bgm.tv/v0/subjects/${id}`]
    : [`https://api.bgm.tv/v0/subjects/${id}`];

  let data: BangumiSubjectApiResponse | null = null;
  let lastError: unknown;

  for (const url of urls) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = (await response.json()) as BangumiSubjectApiResponse;
      // 代理可能返回 HTML / null 等异常内容，此时继续尝试下一个源
      if (!json || typeof json !== 'object') {
        throw new Error('Bangumi 返回数据格式异常');
      }
      data = json;
      break;
    } catch (error) {
      lastError = error;
      continue;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (!data) {
    throw lastError instanceof Error
      ? lastError
      : new Error('获取 Bangumi 详情失败');
  }

  return {
    id: String(data.id ?? id),
    title: data.name_cn || data.name || '',
    year: data.date ? data.date.split('-')[0] : '',
    rate: data.rating?.score ? data.rating.score.toFixed(1) : '',
    summary: data.summary || '',
  };
}
