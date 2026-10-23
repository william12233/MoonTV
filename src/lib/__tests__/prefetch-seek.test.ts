import { parseM3U8 } from '../m3u8-downloader';
import {
  DEFAULT_CACHE_SETTINGS,
  getCachedSegmentRecords,
  hasCachedSegment,
  loadCacheSettings,
  mergeCachedTimeRanges,
  metaStore,
  putCachedSegmentResilient,
  SegmentMeta,
} from '../video-cache';
import { PrefetchStats, VideoPrefetcher } from '../video-prefetcher';

jest.mock('../m3u8-downloader', () => ({ parseM3U8: jest.fn() }));
jest.mock('../video-cache', () => ({
  ...jest.requireActual('../video-cache'),
  loadCacheSettings: jest.fn(),
  getCachedSegmentRecords: jest.fn(),
  hasCachedSegment: jest.fn(),
  ensurePersistentStorage: jest.fn(),
  enforceQuota: jest.fn(),
  putCachedSegmentResilient: jest.fn(),
  metaStore: { put: jest.fn() },
}));

async function flush(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

describe('进度跳转后的缓存调度', () => {
  let records: SegmentMeta[];
  let prefetcher: VideoPrefetcher;
  let updates: PrefetchStats[];
  const options = {
    m3u8Url: 'https://cdn.test/video.m3u8',
    episodeKey: 'source:video:0',
    currentTime: 0,
    lookBehindSeconds: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    records = [];
    updates = [];
    prefetcher = new VideoPrefetcher();
    Object.defineProperty(global, 'caches', { configurable: true, value: {} });
    (loadCacheSettings as jest.Mock).mockReturnValue({
      ...DEFAULT_CACHE_SETTINGS,
      enabled: true,
      useProxy: false,
      concurrency: 1,
    });
    (parseM3U8 as jest.Mock).mockResolvedValue({
      tsUrlList: Array.from({ length: 10 }, (_, i) => `https://cdn.test/${i}.ts`),
      segmentDurations: Array(10).fill(10),
      durationSecond: 100,
    });
    (getCachedSegmentRecords as jest.Mock).mockImplementation(async () => records.slice());
    (hasCachedSegment as jest.Mock).mockImplementation(async (key) =>
      records.some((record) => record.key === key)
    );
    (putCachedSegmentResilient as jest.Mock).mockResolvedValue('ok');
    (metaStore.put as jest.Mock).mockImplementation(async (record: SegmentMeta) => {
      records = records.filter((existing) => existing.key !== record.key);
      records.push(record);
    });
  });

  afterEach(async () => {
    await prefetcher.stopAndWait();
    Reflect.deleteProperty(global, 'caches');
  });

  it('停止旧请求，从新落点下载；保留总片段数并只累计实际缓存时长', async () => {
    let oldSignal: AbortSignal | undefined;
    global.fetch = jest.fn((url, init) => {
      if (String(url).endsWith('/1.ts')) {
        oldSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_, reject) => {
          oldSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(8),
      } as Response);
    });
    const onProgress = (stats: PrefetchStats) => updates.push(stats);
    prefetcher.ensure({ ...options, onProgress });
    await flush();
    expect(oldSignal?.aborted).toBe(false);
    prefetcher.stop(true);
    expect(oldSignal?.aborted).toBe(true);
    prefetcher.ensure({ ...options, currentTime: 65, onProgress });
    await flush();
    const urls = (global.fetch as jest.Mock).mock.calls.map(([url]) => url);
    expect(urls.slice(2)).toEqual([
      'https://cdn.test/6.ts', 'https://cdn.test/7.ts',
      'https://cdn.test/8.ts', 'https://cdn.test/9.ts',
    ]);
    expect(updates[updates.length - 1]).toMatchObject({
      state: 'done', cached: 5, total: 10, coverTo: 50,
    });
    expect(mergeCachedTimeRanges(records)).toEqual([
      { startTime: 0, endTime: 10, firstIndex: 1, lastIndex: 1 },
      { startTime: 60, endTime: 100, firstIndex: 7, lastIndex: 10 },
    ]);
  });

  it('返回已缓存的位置时跳过本地片段，不重复下载', async () => {
    records.push({
      key: 'https://cdn.test/9.ts', episodeKey: options.episodeKey,
      index: 10, bytes: 8, costMs: 1, lastAccess: 0,
    });
    global.fetch = jest.fn();
    prefetcher.ensure({ ...options, currentTime: 95 });
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prefetcher.getStats()).toMatchObject({ cached: 1, total: 10, coverTo: 10 });
    expect(records[0]).toMatchObject({ startTime: 90, endTime: 100 });
  });
});

describe('缓存时间段合并', () => {
  it('合并乱序的连续片段和重叠时间，不跨越未缓存间隙', () => {
    expect(mergeCachedTimeRanges([
      { index: 3, startTime: 20, endTime: 30 },
      { index: 1, startTime: 0, endTime: 10 },
      { index: 2, startTime: 10, endTime: 20 },
      { index: 6, startTime: 50, endTime: 60 },
      { index: 6, startTime: 50, endTime: 60 },
      { index: 7 },
    ])).toEqual([
      { startTime: 0, endTime: 30, firstIndex: 1, lastIndex: 3 },
      { startTime: 50, endTime: 60, firstIndex: 6, lastIndex: 6 },
    ]);
  });
});
