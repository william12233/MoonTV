import { NextRequest, NextResponse } from 'next/server';

import { parseM3U8 } from '@/lib/m3u8-downloader';
import { fetchMediaUrl, validateMediaUrl } from '@/lib/url-guard';

export const runtime = 'edge';

/**
 * 解析M3U8文件接口
 * POST /api/m3u8/parse
 */
export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: '缺少 m3u8 URL' }, { status: 400 });
    }

    // SSRF 防护：该接口会把 url 直接回源，必须校验协议与目标主机
    const guard = validateMediaUrl(url);
    if (!guard.ok) {
      return NextResponse.json(
        { error: '地址不被允许', message: guard.reason },
        { status: 403 }
      );
    }

    const task = await parseM3U8(url, 0, {
      signal: request.signal,
      validateUrls: true,
    });

    return NextResponse.json({
      success: true,
      data: {
        title: task.title,
        type: task.type,
        totalSegments: task.tsUrlList.length,
        duration: task.durationSecond,
        hasAes: !!task.aesConf.key,
        segments: task.tsUrlList.map((url, index) => ({
          index: index + 1,
          url,
        })),
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('解析M3U8失败:', error);
    return NextResponse.json(
      {
        error: '解析M3U8文件失败',
        message: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 }
    );
  }
}

/**
 * 代理下载TS片段（避免CORS问题）
 * GET /api/m3u8/proxy?url=xxx
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    if (!url) {
      return NextResponse.json({ error: '缺少 URL 参数' }, { status: 400 });
    }

    // SSRF 防护：该接口会把 url 直接回源，必须校验协议与目标主机
    const guard = validateMediaUrl(url);
    if (!guard.ok) {
      return NextResponse.json(
        { error: '地址不被允许', message: guard.reason },
        { status: 403 }
      );
    }

    const range = request.headers.get('Range');
    if (range) {
      // Forward a single explicit range without buffering the entire source file.
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = Number(match?.[1]);
      const end = Number(match?.[2]);
      if (
        !match ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end < start
      ) {
        return NextResponse.json(
          { error: '无效的 Range 请求' },
          { status: 400 }
        );
      }
      const response = await fetchMediaUrl(url, {
        headers: { Range: range, 'Accept-Encoding': 'identity' },
        signal: request.signal,
        cache: 'no-store',
      });
      const headers = new Headers({
        'Content-Type':
          response.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'no-store',
        Vary: 'Range',
      });
      for (const name of ['Content-Range', 'Content-Length', 'Accept-Ranges']) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new NextResponse(response.body, {
        status: response.status,
        headers,
      });
    }

    const response = await fetchMediaUrl(url, { signal: request.signal });

    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': response.ok ? 'public, max-age=31536000' : 'no-store',
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('代理下载失败:', error);
    return NextResponse.json(
      {
        error: '下载失败',
        message: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 }
    );
  }
}
