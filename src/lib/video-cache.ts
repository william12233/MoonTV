/**
 * 视频片段本地缓存层。
 *
 * 职责边界：Cache Storage 读写 + IndexedDB 元数据 + LRU 淘汰 + 设置持久化。
 * 不做任何与播放器状态相关的判断，因此可以在视频暂停、页面切到后台时继续工作。
 *
 * 关于「为什么不用 Service Worker」：
 *   1. 代码里本来就在替换 hls.js 的 loader（做去广告），叠加 cache-first 零注册成本；
 *   2. next-pwa 的 dest 是 public，会在生产构建时覆盖手写的 public/sw.js，scope 会冲突；
 *   3. 跨域片段经 SW 拦截拿到的是 opaque response，cache.put 存不了内容。
 */

import {
  type MediaProfile,
  MEDIA_PROFILE_HEAD_BYTES,
  parseMediaProfileHead,
  probeSegmentProfile,
  readResponseHeadBytes,
  rememberSegmentProfile,
} from './segment-media-probe';
import { type SegmentByteRange } from './video-byte-range';

/** 片段响应体的 Cache Storage 桶名 */
export const VIDEO_CACHE_NAME = 'moontv-video-v1';

const META_DB = 'moontv-video-meta';
const META_VERSION = 1;
const META_STORE = 'segments';

export const CACHE_SETTINGS_KEY = 'video_cache_settings';

export interface SegmentMeta {
  /** Cache Storage 中的 key（同源代理 URL 或源站绝对 URL） */
  key: string;
  /** 剧集标识 `${source}:${id}:${episodeIndex}`，用于按集淘汰 */
  episodeKey: string;
  /** 影片标题，用于缓存面板展示 */
  title?: string;
  /** 影视源说明文字，用于缓存面板展示 */
  source?: string;
  /** 片段序号（1 基，便于排查） */
  index: number;
  /** 片段在视频中的实际起止时间（秒），旧缓存可能没有 */
  startTime?: number;
  endTime?: number;
  /** 字节数 */
  bytes: number;
  /** 预取时的实际耗时(ms)，用于给 hls.js 合成 LoaderStats，避免 ABR 高估带宽 */
  costMs: number;
  /** 最后访问时间戳，LRU 依据 */
  lastAccess: number;
}

/**
 * 前向缓存"不设上限"的哨兵值。
 *
 * 传 0 表示一直往后铺，直到播放列表最后一个分片；播放推进时只做增量续跑，
 * 暂停、页面切到后台都不会让队列停下来。真正的兜底交给字节上限
 * （`maxBytesPerEpisode` / `maxTotalBytes`）与 LRU 淘汰，而不是时间。
 */
export const UNLIMITED_HORIZON_SECONDS = 0;

/** 缓存并发档位：只提供低/中/高三档，不开放任意数值 */
export type CacheConcurrencyMode = 'low' | 'medium' | 'high';

/**
 * 档位与分片并发数的对应关系（设置界面与调度器共用同一份定义）。
 *
 * 取值依据（采集站 HLS 的实际分布：分片 0.5–5 MB，偶尔到 8–12 MB；
 * 1080p 常见码率 2.5–6 Mbps，分片 4–10 s）：
 *
 * - 预取只需追上播放码率（1080p ≈ 0.6 MB/s），2 路就能覆盖实时预取，
 *   所以低档取 2，给弱网/省流留一档不抢带宽的选择；
 * - 中档 4 路是日常默认：按单分片 3 MB、单请求 ~0.6 s 计，
 *   4 路 ≈ 20 MB/s，一部 40 分钟、2.25 GB 的 1080p 约 2 分钟补齐视野，
 *   同时不会让播放器的 hls 请求排在大量预取后面；
 * - 高档 8 路用于批量预热：8 路足以跑满 50–100 Mbps 的家用带宽，
 *   再往上只是把 0.5–5 MB 的小分片堆成排队，收益递减而尾延迟变差。
 */
export const CACHE_CONCURRENCY_PRESETS: Record<CacheConcurrencyMode, number> = {
  low: 2,
  medium: 4,
  high: 8,
};

export interface CacheSettings {
  /** 总开关 */
  enabled: boolean;
  /** 切换集数或换片时清理缓存，保留当前集与下一集预热 */
  autoClearOnEpisodeChange: boolean;
  /** 分片下载并发数，由 concurrencyMode 决定（2 / 4 / 8），只读派生值 */
  concurrency: number;
  /** 并发档位 */
  concurrencyMode: CacheConcurrencyMode;
  /**
   * 前向缓存目标时长（秒）。
   *
   * `UNLIMITED_HORIZON_SECONDS`（0）= 不设时间上限，缓存到片尾。
   */
  horizonSeconds: number;
  /** 单集最大占用（字节） */
  maxBytesPerEpisode: number;
  /** 全部缓存最大占用（字节） */
  maxTotalBytes: number;
  /** 直连失败时是否允许同源代理兜底；同时决定缓存键格式以兼容旧缓存 */
  useProxy: boolean;
}

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  enabled: false,
  autoClearOnEpisodeChange: false,
  concurrency: CACHE_CONCURRENCY_PRESETS.low,
  concurrencyMode: 'low',
  // 默认不设时间上限：暂停后一直往后缓存，直到片尾或触发字节上限淘汰
  horizonSeconds: UNLIMITED_HORIZON_SECONDS,
  maxBytesPerEpisode: 800 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024 * 1024,
  useProxy: true,
};

function clampNumber(
  value: unknown,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
/* ------------------------------------------------------------------ */

export function loadCacheSettings(): CacheSettings {
  if (typeof window === 'undefined') return DEFAULT_CACHE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(CACHE_SETTINGS_KEY);
    if (!raw) return DEFAULT_CACHE_SETTINGS;
    return normalizeCacheSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CACHE_SETTINGS;
  }
}

/** 把任意并发数收敛到最接近的预设档位 */
export function closestConcurrencyMode(value: number): CacheConcurrencyMode {
  const modes: CacheConcurrencyMode[] = ['low', 'medium', 'high'];
  let best: CacheConcurrencyMode = modes[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const mode of modes) {
    const distance = Math.abs(CACHE_CONCURRENCY_PRESETS[mode] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = mode;
    }
  }
  return best;
}

/**
 * 解析并发档位。
 *
 * 旧版本支持"自定义并发"，存量配置里可能是 `concurrencyMode: 'custom'`
 * 加一个 `customConcurrency`（也可能是更早的只存 `concurrency`）。
 * 现在只保留三档预设，这些历史值一律按最接近的档位收敛，
 * 保证升级后不会因为字段缺失回落到 1 路。
 */
function normalizeConcurrencyMode(
  raw: Record<string, unknown>
): CacheConcurrencyMode {
  const mode = raw.concurrencyMode;
  if (mode === 'low' || mode === 'medium' || mode === 'high') return mode;
  if (mode !== undefined && mode !== 'custom') {
    return DEFAULT_CACHE_SETTINGS.concurrencyMode;
  }
  const legacy = clampNumber(
    raw.customConcurrency ?? raw.concurrency,
    1,
    Number.MAX_SAFE_INTEGER
  );
  return legacy === undefined
    ? DEFAULT_CACHE_SETTINGS.concurrencyMode
    : closestConcurrencyMode(legacy);
}

/** 对可能不可信的配置做字段级校验，避免脏数据导致配额失控 */
export function normalizeCacheSettings(input: unknown): CacheSettings {
  if (!input || typeof input !== 'object') return DEFAULT_CACHE_SETTINGS;
  const raw = input as Record<string, unknown>;

  const settings: CacheSettings = { ...DEFAULT_CACHE_SETTINGS };

  if (typeof raw.enabled === 'boolean') settings.enabled = raw.enabled;
  if (typeof raw.autoClearOnEpisodeChange === 'boolean') {
    settings.autoClearOnEpisodeChange = raw.autoClearOnEpisodeChange;
  }
  if (typeof raw.useProxy === 'boolean') settings.useProxy = raw.useProxy;

  // 并发只能来自三档预设，写入端的 concurrency 字段被忽略并重新派生。
  settings.concurrencyMode = normalizeConcurrencyMode(raw);
  settings.concurrency = CACHE_CONCURRENCY_PRESETS[settings.concurrencyMode];

  const horizon = clampNumber(raw.horizonSeconds, 0, 7200);
  if (horizon !== undefined) {
    // 0 是「无限」哨兵，必须原样保留；其余值低于 1 分钟没有意义，抬到 60s
    settings.horizonSeconds =
      horizon === 0
        ? UNLIMITED_HORIZON_SECONDS
        : Math.max(60, Math.round(horizon));
  }

  const perEpisode = clampNumber(
    raw.maxBytesPerEpisode,
    50 * 1024 * 1024,
    8 * 1024 ** 3
  );
  if (perEpisode !== undefined)
    settings.maxBytesPerEpisode = Math.round(perEpisode);

  const total = clampNumber(
    raw.maxTotalBytes,
    100 * 1024 * 1024,
    20 * 1024 ** 3
  );
  if (total !== undefined) settings.maxTotalBytes = Math.round(total);

  if (settings.maxBytesPerEpisode > settings.maxTotalBytes) {
    settings.maxBytesPerEpisode = settings.maxTotalBytes;
  }

  return settings;
}

export function saveCacheSettings(next: Partial<CacheSettings>): CacheSettings {
  const merged = normalizeCacheSettings({ ...loadCacheSettings(), ...next });
  try {
    window.localStorage.setItem(CACHE_SETTINGS_KEY, JSON.stringify(merged));
  } catch {
    // 隐私模式 / 存储配额满时静默失败，不影响播放
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* IndexedDB 元数据                                                    */
/* ------------------------------------------------------------------ */

let dbPromise: Promise<IDBDatabase> | null = null;

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openMetaDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(META_DB, META_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        const store = db.createObjectStore(META_STORE, { keyPath: 'key' });
        store.createIndex('by_episode', 'episodeKey');
        store.createIndex('by_access', 'lastAccess');
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });

  // 打开失败时清空缓存句柄，允许下次重试
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

function runTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return openMetaDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(META_STORE, mode);
        const request = fn(transaction.objectStore(META_STORE));
        // Request success precedes commit; a transaction may still abort.
        transaction.oncomplete = () => resolve(request.result as T);
        transaction.onabort = () =>
          reject(
            transaction.error || new Error('Metadata transaction aborted')
          );
        transaction.onerror = () => reject(transaction.error);
        request.onerror = () => reject(request.error);
      })
  );
}

export const metaStore = {
  put(record: SegmentMeta): Promise<void> {
    return runTx<void>('readwrite', (store) => store.put(record));
  },
  get(key: string): Promise<SegmentMeta | undefined> {
    return runTx<SegmentMeta | undefined>('readonly', (store) =>
      store.get(key)
    );
  },
  del(key: string): Promise<void> {
    return runTx<void>('readwrite', (store) => store.delete(key));
  },
  all(): Promise<SegmentMeta[]> {
    return runTx<SegmentMeta[]>('readonly', (store) => store.getAll());
  },
  clear(): Promise<void> {
    return runTx<void>('readwrite', (store) => store.clear());
  },
};

/** 30 秒内同一 key 只写一次 lastAccess，避免命中缓存时频繁写盘 */
const lastTouchAt = new Map<string, number>();
const TOUCH_INTERVAL_MS = 30_000;

export async function touchMeta(key: string): Promise<void> {
  const now = Date.now();
  // 先按所有变体更新内存里的 lastTouchAt，避免同一缓存内容因 key 形式不同频繁写盘
  const variants = getCacheKeyVariants(key);
  const throttled = variants.some((v) => {
    const previous = lastTouchAt.get(v);
    return previous !== undefined && now - previous < TOUCH_INTERVAL_MS;
  });
  if (throttled) return;
  for (const [entry, touchedAt] of Array.from(lastTouchAt)) {
    if (now - touchedAt >= TOUCH_INTERVAL_MS) lastTouchAt.delete(entry);
  }
  variants.forEach((v) => lastTouchAt.set(v, now));

  try {
    // 按每个变体都尝试查找并更新 lastAccess，保证 LRU 语义正确
    for (const v of variants) {
      const record = await metaStore.get(v);
      if (record) {
        record.lastAccess = now;
        await metaStore.put(record);
      }
    }
  } catch {
    // 元数据写入失败不影响播放
  }
}

/* ------------------------------------------------------------------ */
/* Cache Storage                                                       */
/* ------------------------------------------------------------------ */

export function isCacheStorageAvailable(): boolean {
  return typeof caches !== 'undefined';
}

export async function openVideoCache(): Promise<Cache | null> {
  if (!isCacheStorageAvailable()) return null;
  try {
    return await caches.open(VIDEO_CACHE_NAME);
  } catch {
    return null;
  }
}

/**
 * 把缓存键在「相对路径形式」和「绝对 URL 形式」之间互相换算，用于
 * 解决 cache.put 写入时某些浏览器自动把相对路径补成带 origin 的绝对 URL，
 * 导致读取侧用相对路径查不到的问题。
 */
export function getCacheKeyVariants(key: string): string[] {
  const variants: string[] = [key];
  try {
    if (typeof location !== 'undefined') {
      const origin = location.origin;
      // 传入 key 是相对路径（以 / 开头，不是 //，不是 http...）
      if (
        key.startsWith('/') &&
        !key.startsWith('//') &&
        !/^https?:/i.test(key)
      ) {
        const abs = `${origin}${key}`;
        if (abs !== key) variants.push(abs);
      } else {
        // 传入 key 是绝对 URL：如果 origin 一致，推回相对路径再查一次
        const u = new URL(key);
        if (u.origin === origin && u.pathname !== '') {
          const rel = `${u.pathname}${u.search}${u.hash}`;
          if (rel !== key) variants.push(rel);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return Array.from(new Set(variants));
}

export async function hasCachedSegment(key: string): Promise<boolean> {
  const cache = await openVideoCache();
  if (!cache) return false;
  try {
    for (const candidate of getCacheKeyVariants(key)) {
      if ((await cache.match(candidate)) !== undefined) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 申请持久化存储，降低磁盘紧张时被浏览器整块清理的概率 */
export async function ensurePersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist)
    return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface CacheStorageEstimate {
  usage: number;
  quota: number;
  ratio: number;
}

export async function estimateStorage(): Promise<CacheStorageEstimate | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate)
    return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, ratio: quota > 0 ? usage / quota : 0 };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 命中率探针                                                          */
/* ------------------------------------------------------------------ */

/**
 * 片段缓存命中/未命中计数。
 *
 * 用途：预取器与 loader 的缓存键必须字节一致，一旦 `applyURL` 之类的
 * URL 解析出现分歧，缓存会静默 0 命中（表现为"预取白跑、播放依旧走网络"）。
 * 命中率是最直接的观测手段，设置面板里会展示。
 */
const segmentProbe = { hits: 0, misses: 0 };

export function recordSegmentProbe(hit: boolean): void {
  if (hit) segmentProbe.hits += 1;
  else segmentProbe.misses += 1;
}

export function getSegmentProbe(): {
  hits: number;
  misses: number;
  hitRate: number;
} {
  const total = segmentProbe.hits + segmentProbe.misses;
  return {
    hits: segmentProbe.hits,
    misses: segmentProbe.misses,
    hitRate: total > 0 ? segmentProbe.hits / total : 0,
  };
}

export function resetSegmentProbe(): void {
  segmentProbe.hits = 0;
  segmentProbe.misses = 0;
}

/**
 * LRU 淘汰。
 *
 * 两轮：先按 episodeKey 内淘汰最久未访问的片段满足单集上限，
 * 再按全局最久未访问淘汰满足总上限。
 *
 * @returns 实际删除的片段数量
 */
export async function enforceQuota(
  settings: CacheSettings = loadCacheSettings()
): Promise<number> {
  const cache = await openVideoCache();
  if (!cache) return 0;

  let records: SegmentMeta[];
  try {
    records = await metaStore.all();
  } catch {
    return 0;
  }
  if (records.length === 0) return 0;

  const victims = new Set<string>();
  let total = records.reduce((sum, record) => sum + (record.bytes || 0), 0);

  // ① 单集超限
  const grouped = new Map<string, SegmentMeta[]>();
  for (const record of records) {
    const list = grouped.get(record.episodeKey);
    if (list) list.push(record);
    else grouped.set(record.episodeKey, [record]);
  }

  for (const list of Array.from(grouped.values())) {
    list.sort((a, b) => a.lastAccess - b.lastAccess);
    let size = list.reduce((sum, record) => sum + (record.bytes || 0), 0);
    for (const record of list) {
      if (size <= settings.maxBytesPerEpisode) break;
      victims.add(record.key);
      size -= record.bytes || 0;
      total -= record.bytes || 0;
    }
  }

  // ② 全局超限
  if (total > settings.maxTotalBytes) {
    const rest = records
      .filter((record) => !victims.has(record.key))
      .sort((a, b) => a.lastAccess - b.lastAccess);
    for (const record of rest) {
      if (total <= settings.maxTotalBytes) break;
      victims.add(record.key);
      total -= record.bytes || 0;
    }
  }

  if (victims.size === 0) return 0;

  let removed = 0;
  const victimKeys = Array.from(victims);
  // Bound storage work instead of opening a transaction for every victim at once.
  for (let offset = 0; offset < victimKeys.length; offset += 8) {
    await Promise.all(
      victimKeys.slice(offset, offset + 8).map(async (key) => {
        try {
          if (await cache.delete(key)) removed += 1;
        } catch {
          // ignore
        }
        try {
          await metaStore.del(key);
        } catch {
          // ignore
        }
        lastTouchAt.delete(key);
      })
    );
    if (offset + 8 < victimKeys.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  return removed;
}

export async function clearVideoCache(
  keepEpisodeKeys: readonly string[] = []
): Promise<void> {
  if (keepEpisodeKeys.length > 0) {
    const keep = new Set(keepEpisodeKeys);
    const records = await metaStore.all();
    const preservedKeys = new Set(
      records
        .filter((record) => keep.has(record.episodeKey))
        .flatMap((record) => getCacheKeyVariants(record.key))
    );
    const cache = await openVideoCache();
    if (cache) {
      const requests = await cache.keys();
      await Promise.all(
        requests
          .filter((request) => !preservedKeys.has(request.url))
          .map((request) => cache.delete(request))
      );
    }
    await Promise.all(
      records
        .filter((record) => !keep.has(record.episodeKey))
        .map(async (record) => {
          await metaStore.del(record.key);
          lastTouchAt.delete(record.key);
        })
    );
    return;
  }
  try {
    await caches.delete(VIDEO_CACHE_NAME);
  } catch {
    // ignore
  }
  try {
    await metaStore.clear();
  } catch {
    // ignore
  }
  lastTouchAt.clear();
}

/** 统计已缓存字节数与片段数（设置面板展示用） */
export async function getCacheSummary(): Promise<{
  bytes: number;
  segments: number;
  episodes: number;
}> {
  try {
    const records = await metaStore.all();
    return {
      bytes: records.reduce((sum, record) => sum + (record.bytes || 0), 0),
      segments: records.length,
      episodes: new Set(records.map((record) => record.episodeKey)).size,
    };
  } catch {
    return { bytes: 0, segments: 0, episodes: 0 };
  }
}

/** 单集缓存的聚合统计 */
export interface EpisodeCacheStat {
  /** 剧集标识 `${source}:${id}:${episodeIndex}` */
  episodeKey: string;
  /** 影片标题 */
  title?: string;
  /** 影视源展示名称 */
  source?: string;
  /** 片段数 */
  segments: number;
  /** 占用字节数 */
  bytes: number;
  /** 最近访问时间（用于排序） */
  lastAccess: number;
}

export interface CachedTimeRange {
  startTime: number;
  endTime: number;
  firstIndex: number;
  lastIndex: number;
}

/** 合并相邻或重叠的实际时间段，不把未缓存的间隙计入覆盖时长。 */
export function mergeCachedTimeRanges(
  records: Pick<SegmentMeta, 'index' | 'startTime' | 'endTime'>[]
): CachedTimeRange[] {
  const sorted = records
    .filter(
      (
        record
      ): record is { index: number; startTime: number; endTime: number } =>
        typeof record.startTime === 'number' &&
        typeof record.endTime === 'number' &&
        Number.isFinite(record.startTime) &&
        Number.isFinite(record.endTime) &&
        record.startTime >= 0 &&
        record.endTime > record.startTime
    )
    .sort((a, b) => a.startTime - b.startTime);
  const ranges: CachedTimeRange[] = [];
  for (const record of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && record.startTime <= previous.endTime + 0.001) {
      previous.endTime = Math.max(previous.endTime, record.endTime);
      previous.firstIndex = Math.min(previous.firstIndex, record.index);
      previous.lastIndex = Math.max(previous.lastIndex, record.index);
    } else {
      ranges.push({
        startTime: record.startTime,
        endTime: record.endTime,
        firstIndex: record.index,
        lastIndex: record.index,
      });
    }
  }
  return ranges;
}

/** 只返回仍存在于 Cache Storage 的元数据，排除已淘汰或被清空的片段。 */
export async function getCachedSegmentRecords(): Promise<SegmentMeta[]> {
  const cache = await openVideoCache();
  if (!cache) return [];
  const [records, requests] = await Promise.all([
    metaStore.all(),
    cache.keys(),
  ]);
  const keys = new Set<string>();
  for (let i = 0; i < requests.length; i += 1) {
    keys.add(requests[i].url);
    if (i > 0 && i % 256 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const cached: SegmentMeta[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (getCacheKeyVariants(record.key).some((key) => keys.has(key))) {
      cached.push(record);
    }
    if (i > 0 && i % 256 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return cached;
}

/** 按剧集聚合已缓存内容的统计（缓存管理面板用），按最近访问倒序 */
export async function getEpisodeCacheStats(): Promise<EpisodeCacheStat[]> {
  try {
    const records = await getCachedSegmentRecords();
    const grouped = new Map<string, EpisodeCacheStat>();
    for (const record of records) {
      const stat = grouped.get(record.episodeKey);
      if (stat) {
        stat.segments += 1;
        stat.bytes += record.bytes || 0;
        if (record.lastAccess > stat.lastAccess)
          stat.lastAccess = record.lastAccess;
        if (!stat.title && record.title) stat.title = record.title;
        if (!stat.source && record.source) stat.source = record.source;
      } else {
        const source =
          record.source ||
          record.episodeKey.split(':').slice(0, -2).join(':') ||
          '未知来源';
        const title = record.title || '未知影片';
        grouped.set(record.episodeKey, {
          episodeKey: record.episodeKey,
          title,
          source,
          segments: 1,
          bytes: record.bytes || 0,
          lastAccess: record.lastAccess,
        });
      }
    }
    return Array.from(grouped.values()).sort(
      (a, b) => b.lastAccess - a.lastAccess
    );
  } catch {
    return [];
  }
}

/** 删除指定剧集的全部缓存（片段 + 元数据） */
export async function deleteEpisodeCache(episodeKey: string): Promise<number> {
  const cache = await openVideoCache();
  if (!cache) return 0;

  let records: SegmentMeta[];
  try {
    records = await metaStore.all();
  } catch {
    return 0;
  }

  const victims = records.filter((record) => record.episodeKey === episodeKey);
  if (victims.length === 0) return 0;

  let removed = 0;
  await Promise.all(
    victims.map(async (record) => {
      try {
        if (await cache.delete(record.key)) removed += 1;
      } catch {
        // ignore
      }
      try {
        await metaStore.del(record.key);
      } catch {
        // ignore
      }
      lastTouchAt.delete(record.key);
    })
  );
  return removed;
}

/* ------------------------------------------------------------------ */
/* 缓存键                                                              */
/* ------------------------------------------------------------------ */

/**
 * 归一化片段 URL。
 *
 * 预取器（从 m3u8 文本解析）与读取侧（hls.js 的 context.url）必须得到
 * **字节完全一致**的 key，否则缓存永远 0 命中。统一走 URL 构造器，
 * 让默认端口、百分号编码、路径 `..` 的差异都被抹平。
 */
export function normalizeSegmentUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * 生成片段缓存键。
 *
 * - `useProxy = true`：使用同源的 `/api/m3u8?url=...` 格式；
 * - `useProxy = false`：使用源站绝对 URL 格式。
 * 缓存键格式独立于下载路由：预取始终优先直连，按设置允许代理兜底。
 */
export function buildSegmentCacheKey(
  segmentUrl: string,
  useProxy = true,
  range?: SegmentByteRange
): string {
  const normalized = normalizeSegmentUrl(segmentUrl);
  const key = useProxy
    ? `/api/m3u8?url=${encodeURIComponent(normalized)}`
    : normalized;
  if (!range) return key;
  // A synthetic query belongs only to Cache Storage, never to the CDN request.
  const url = new URL(key, 'https://cache.invalid');
  url.hash = '';
  url.searchParams.set('__moontv_range', `${range.start}-${range.end}`);
  return useProxy ? `${url.pathname}${url.search}` : url.href;
}

/* ------------------------------------------------------------------ */
/* 片段读写                                                            */
/* ------------------------------------------------------------------ */

/**
 * 缓存一个片段响应。仅保留渲染/解码必需的头，避免把源站的
 * CSP、鉴权相关头一起带进缓存。
 */
export async function putCachedSegment(
  key: string,
  buffer: ArrayBuffer,
  contentType?: string | null
): Promise<void> {
  const cache = await openVideoCache();
  if (!cache) throw new Error('Video cache storage unavailable');

  await cache.put(
    key,
    new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': String(buffer.byteLength),
      },
    })
  );
}

/** 判断是否为 Cache Storage 配额耗尽（各浏览器报错类型不一，按 name + message 双判） */
export function isQuotaExceededError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && err.name === 'QuotaExceededError')
    return true;
  const name = (err as { name?: unknown }).name;
  if (name === 'QuotaExceededError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /quota/i.test(message);
}

export type PutSegmentResult = 'ok' | 'quota' | 'failed';

/**
 * 带配额自救的分片写入。
 *
 * 前向缓存在"无限模式"下会把整集都铺下来，必然更容易撞到存储配额。
 * 直接 `cache.put` 抛 QuotaExceededError 的话，worker 的 try/catch 会
 * 把每个后续分片都吞掉——表现为"缓存悄悄停在某个位置不动了"，
 * 很难排查。这里先按 LRU 淘汰一批再重试一次，真腾不出空间才上报。
 */
export async function putCachedSegmentResilient(
  key: string,
  buffer: ArrayBuffer,
  contentType?: string | null,
  settings: CacheSettings = loadCacheSettings()
): Promise<PutSegmentResult> {
  try {
    await putCachedSegment(key, buffer, contentType);
    return 'ok';
  } catch (err) {
    if (!isQuotaExceededError(err)) return 'failed';

    const removed = await enforceQuota(settings);
    if (removed === 0) return 'quota';

    try {
      await putCachedSegment(key, buffer, contentType);
      return 'ok';
    } catch {
      return 'quota';
    }
  }
}

export interface CachedFragment {
  data: ArrayBuffer;
  costMs: number;
}

/** 读取缓存片段，同时取回预取时记录的真实耗时（供合成 LoaderStats 用）。
 *  返回 { fragment, matchedKey }，便于后续用同一个 matchedKey 去更新 IndexedDB 的
 *  lastAccess（因为预取写入时可能用了绝对 URL 作为 key，和读取侧传的相对路径不一致）。
 */
export async function readCachedSegment(
  key: string
): Promise<{ fragment: CachedFragment; matchedKey: string } | null> {
  const cache = await openVideoCache();
  if (!cache) return null;

  let hit: Response | undefined;
  let matchedKey = key;
  try {
    for (const candidate of getCacheKeyVariants(key)) {
      hit = await cache.match(candidate);
      if (hit) {
        matchedKey = candidate;
        break;
      }
    }
  } catch {
    return null;
  }
  if (!hit) return null;

  // 同时按「读取侧传入的 key」和「实际命中的 key」去 IndexedDB 查元数据
  try {
    const [data, recordPrimary, recordMatched] = await Promise.all([
      hit.arrayBuffer(),
      metaStore.get(key).catch(() => undefined),
      matchedKey !== key
        ? metaStore.get(matchedKey).catch(() => undefined)
        : undefined,
    ]);
    const record = recordPrimary ?? recordMatched;
    return {
      fragment: { data, costMs: record?.costMs ?? 150 },
      matchedKey,
    };
  } catch {
    return null;
  }
}

/**
 * 从 Cache Storage 里读某个分片的**头部**（只读前几 KB）。
 *
 * 注意：不能用 `readCachedSegment()`——它会把整片（1–2MB）`arrayBuffer()` 读进
 * 内存，44 个块轮一遍就是近百 MB 的瞬时分配，手机上很容易触发 GC 抖动。
 * 这里直接拿 `Response.body` 流，读够 `limit` 就 cancel。
 */
async function readCachedSegmentHead(
  segmentUrl: string,
  limit: number
): Promise<Uint8Array | null> {
  const cache = await openVideoCache();
  if (!cache) return null;
  for (const useProxy of [true, false]) {
    const key = buildSegmentCacheKey(segmentUrl, useProxy);
    for (const candidate of getCacheKeyVariants(key)) {
      let hit: Response | undefined;
      try {
        hit = await cache.match(candidate);
      } catch {
        return null;
      }
      if (!hit) continue;
      const head = await readResponseHeadBytes(hit, limit);
      if (head && head.length > 0) return head;
    }
  }
  return null;
}

/** 只查缓存（零网络）：命中则返回该分片的编码参数 */
export async function probeCachedSegmentProfile(
  segmentUrl: string
): Promise<MediaProfile | null> {
  if (!segmentUrl || !isCacheStorageAvailable()) return null;
  try {
    const head = await readCachedSegmentHead(
      segmentUrl,
      MEDIA_PROFILE_HEAD_BYTES
    );
    return head ? parseMediaProfileHead(head) : null;
  } catch {
    // 配额 / 隐私模式 / 缓存被清空：当作没缓存，交给调用方决定是否回源
    return null;
  }
}

/**
 * 去广告用的分片探测：**缓存优先，零请求**。
 *
 * 播放器与预取器都按「结构特征 + 分片媒体参数」过滤同一份播放列表，而分片
 * 大多已经被预取写进 Cache Storage（上次播放 / 本次预取 / 拖动重解析）。
 * 两边必须用**完全同一条链路**：只要一方走缓存、另一方走网络，遇到防盗链的
 * 源就会出现「播放器读到参数删了广告、预取器 403 没删」——两个时间轴差一段
 * 广告时长，缓存元数据的开始时间、进度条覆盖区间全部错位。
 *
 * 命中缓存时探测开销为 0 网络请求；只有确实没缓存的分片才回源读 4KB。
 */
export async function probeSegmentProfileCacheFirst(
  segmentUrl: string
): Promise<MediaProfile | null> {
  const cached = await probeCachedSegmentProfile(segmentUrl);
  if (cached) {
    // 回写共享缓存：另一个调用方解析同一份播放列表时直接命中
    rememberSegmentProfile(segmentUrl, cached);
    return cached;
  }
  return probeSegmentProfile(segmentUrl);
}

/** 供调试：indexedDB 是否可用 */
export function isMetaStoreAvailable(): boolean {
  return indexedDbAvailable();
}
