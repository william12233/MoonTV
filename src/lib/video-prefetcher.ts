/**
 * 前向片段预取器。
 *
 * 设计要点（这是"视频暂停也继续缓存"的全部秘密）：
 *   预取循环体内**不读取任何播放状态**——不判断 `paused`、不判断
 *   `document.hidden`、不听播放器事件。循环体只有 `await fetch` 与
 *   `cache.put`，因此视频暂停、页面切到后台标签页时，队列仍会继续推进。
 *
 *   `setThrottled()` 是"临时让出带宽"（播放卡顿时调用），与"暂停视频就停缓存"
 *   是两件事，不要混用。
 */

import { parseM3U8 } from './m3u8-downloader';
import {
  clampPrefetchConcurrency,
  observePrefetchSegment,
  prefetchDownloadLimiter,
  prefetchWriteLimiter,
  registerPrefetchConcurrency,
} from './prefetch-scheduler';
import { byteRangeHeader, readByteRangeResponse } from './video-byte-range';
import {
  type CacheSettings,
  buildSegmentCacheKey,
  enforceQuota,
  ensurePersistentStorage,
  getCachedSegmentRecords,
  getCacheKeyVariants,
  hasCachedSegment,
  loadCacheSettings,
  metaStore,
  putCachedSegmentResilient,
} from './video-cache';

export type PrefetchState =
  | 'idle'
  | 'parsing'
  | 'running'
  | 'done'
  | 'error'
  | 'disabled';

export interface PrefetchStats {
  state: PrefetchState;
  /** 已就绪的片段数 */
  cached: number;
  /** 完整播放列表的片段总数，不随跳转改变 */
  total: number;
  /** 当前播放列表实际缓存字节数 */
  bytes: number;
  /** 实际已缓存片段的总时长（秒），不包含缓存间隙 */
  coverTo: number;
  /** 重试与代理兜底都失败、已跳过的分片数（不影响其余分片继续缓存） */
  failed: number;
  message?: string;
}

export interface PrefetchOptions {
  m3u8Url: string;
  /** 当前播放位置（秒） */
  currentTime: number;
  /** 开启跳过时的片头、片尾时长（秒，均为非负数） */
  skipIntroSeconds?: number;
  skipOutroSeconds?: number;
  /** 当前影片名称，用于缓存面板展示 */
  title?: string;
  /** 影视源名称，用于缓存面板展示 */
  source?: string;
  /** 剧集标识，用于分集统计与淘汰 */
  episodeKey: string;
  /** 覆盖 settings.horizonSeconds */
  horizonSeconds?: number;
  /** 回看保护时长（秒），默认 30 */
  lookBehindSeconds?: number;
  /**
   * 覆盖缓存模式的并发数。
   *
   * 只有低/中/高（2/4/8）三档由用户选择；预热这类低优先级队列可以传更小的
   * 值，但不会超过最高档——并发太高会抢播放的带宽。
   */
  concurrency?: number;
  /** 覆盖 settings.useProxy：直连失败时是否允许代理兜底 */
  useProxy?: boolean;
  /**
   * 期望缓存的画面高度（如 1080）。
   *
   * 主播放列表有多个码率档位时，预取器默认取最高带宽；用户手动把画质切到
   * 480p 后，hls.js 请求的是 480p 的分片，与已缓存的 1080p 分片 URL 不同，
   * 命中率会掉到 0。把用户选择的档位透传下来即可保持一致。
   */
  preferredHeight?: number | null;
  onProgress?: (stats: PrefetchStats) => void;
}

const IDLE_STATS: PrefetchStats = {
  state: 'idle',
  cached: 0,
  total: 0,
  bytes: 0,
  coverTo: 0,
  failed: 0,
};

/** 时长信息缺失且设置了时间上限时，最多预取多少个片段；无限模式不受此限 */
const FALLBACK_MAX_SEGMENTS = 200;

/**
 * 连续多少个分片失败视为"本阶段失败密集"。
 *
 * 采集站常见个别分片坏掉（时间戳漂移、单片 404、鉴权瞬时失效），
 * 只要大多数分片成功就不该让整集缓存作废，所以先跳过继续跑；
 * 一旦密集到说明当前下载路由不可用，行为分两种：
 *
 * - 直连阶段 → 整体切到代理阶段，并把已失败的分片用代理补下；
 * - 代理阶段（或不允许代理）→ 终止整轮。
 */
const MAX_CONSECUTIVE_SEGMENT_FAILURES = 3;

/** 失败占比超过该值且样本足够时，同样视为"本阶段失败密集" */
const SEGMENT_FAILURE_RATIO_LIMIT = 0.5;

/** 判断失败占比前至少处理过的分片数，避免刚开始的偶发失败就误杀 */
const MIN_SEGMENT_FAILURE_SAMPLE = 6;

/** 进度回调最小间隔，避免高频写 React state */
const EMIT_INTERVAL_MS = 250;
const STATS_REFRESH_INTERVAL_MS = 15_000;

/** 淘汰检查间隔 */
const EVICT_INTERVAL_MS = 15_000;

const SEGMENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function retrySegmentDownload<T>(
  download: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await download();
    } catch (error) {
      if (signal.aborted || attempt >= SEGMENT_RETRY_DELAYS_MS.length) {
        throw error;
      }
      // 重试等待与分片请求使用同一信号，切集时不会留下延迟下载。
      await waitForRetry(SEGMENT_RETRY_DELAYS_MS[attempt], signal);
    }
  }
}

/**
 * 把 `horizonSeconds` 换算成"目标缓存到的时间点"。
 *
 * `<= 0`（`UNLIMITED_HORIZON_SECONDS`）表示不设上限，返回 `+Infinity`：
 * 队列会一直铺到播放列表最后一个分片，之后播放推进只做增量续跑。
 */
function horizonEndTime(currentTime: number, horizonSeconds: number): number {
  return horizonSeconds > 0
    ? currentTime + horizonSeconds
    : Number.POSITIVE_INFINITY;
}

/** 供回归测试使用（纯函数，无副作用） */
export const __testing__ = { horizonEndTime };

/**
 * 网络环境守卫：省流量模式 / 弱网 / 离线时不做任何预取。
 * 这些条件下预取只会白白消耗用户流量。
 */
export function shouldPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof caches === 'undefined') return false;

  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  if (nav.onLine === false) return false;

  const connection = nav.connection;
  if (connection?.saveData) return false;
  if (
    typeof connection?.effectiveType === 'string' &&
    /(^|-)(2g|slow-2g)$/.test(connection.effectiveType)
  ) {
    return false;
  }

  return true;
}

function toCumulative(durations: number[]): number[] {
  const out = new Array<number>(durations.length);
  let acc = 0;
  for (let i = 0; i < durations.length; i += 1) {
    acc += durations[i] || 0;
    out[i] = acc;
  }
  return out;
}

function indexAtTime(cumulative: number[], time: number): number {
  for (let i = 0; i < cumulative.length; i += 1) {
    if (cumulative[i] > time) return i;
  }
  return Math.max(0, cumulative.length - 1);
}

export class VideoPrefetcher {
  private controller: AbortController | null = null;
  private pendingRuns = new Set<Promise<void>>();
  private parsedPlaylist: {
    task: Awaited<ReturnType<typeof parseM3U8>>;
    cumulative: number[];
  } | null = null;
  private episodeKey: string | null = null;
  /** 本轮队列使用的码率档位（画面高度），null 表示"最高带宽" */
  private preferredHeight: number | null = null;
  private skipWindowKey = '';
  private sourceKey = '';
  /** 当前已排入队列的覆盖区间 [windowFrom, windowTo]（秒） */
  private windowFrom = 0;
  private windowTo = 0;
  /** 队列已覆盖到播放列表末尾：此时无论请求多大视野都无事可做 */
  private reachedEnd = false;
  private accessDenied = false;
  private throttled = false;
  private activeRequests = new Set<AbortController>();
  private resumeWaiters: Array<() => void> = [];
  private stats: PrefetchStats = { ...IDLE_STATS };
  private lastEmittedStats: PrefetchStats | null = null;
  private lastEmitAt = 0;

  /**
   * 幂等入口。同一集且窗口仍然够用时直接返回，因此可以放心地在
   * seek / timeupdate / pause 里高频调用。
   */
  ensure(options: PrefetchOptions): void {
    if (!options.m3u8Url) return;

    const settings = loadCacheSettings();
    if (!settings.enabled) {
      this.stop();
      this.emit(
        options,
        { state: 'disabled', message: '已关闭视频缓存' },
        true
      );
      return;
    }
    if (!shouldPrefetch()) {
      this.stop();
      this.emit(
        options,
        { state: 'disabled', message: '当前网络环境已跳过缓存' },
        true
      );
      return;
    }

    const sourceKey = `${options.m3u8Url}|${
      options.useProxy ?? settings.useProxy
    }`;
    const sameEpisode =
      this.episodeKey === options.episodeKey && this.sourceKey === sourceKey;
    // 档位变了（用户手动切画质）就必须重建队列：不同档位的分片 URL 不同，
    // 旧队列缓存的分片与新请求对不上，继续跑只是白烧带宽。
    const preferredHeight = options.preferredHeight ?? null;
    const sameVariant = this.preferredHeight === preferredHeight;
    const skipIntro = Math.max(0, options.skipIntroSeconds || 0);
    const skipOutro = Math.max(0, options.skipOutroSeconds || 0);
    options = {
      ...options,
      currentTime: Math.max(options.currentTime, skipIntro),
    };
    const skipWindowKey = `${skipIntro}:${skipOutro}`;
    const sameSkipWindow = this.skipWindowKey === skipWindowKey;

    if (sameEpisode && sameVariant && sameSkipWindow && this.accessDenied) {
      this.emit(options, this.stats);
      return;
    }

    // 队列已经覆盖到播放列表末尾，且当前播放位置落在已覆盖区间内：
    // 再叫也不会多出可缓存的片段。
    // 必须先短路，否则下面"窗口够不够大"的判断在短播放列表上永不成立，
    // 会导致每次 ensure 都重启一轮队列。
    // 注意要带上"位置在覆盖区间内"这一条：末尾覆盖 + 向后拖进度条 仍然需要重建队列。
    if (
      sameEpisode &&
      sameVariant &&
      sameSkipWindow &&
      this.reachedEnd &&
      options.currentTime >= this.windowFrom - 60 &&
      options.currentTime <= this.windowTo
    ) {
      this.emit(options, this.stats);
      return;
    }

    const requestedTo = horizonEndTime(
      options.currentTime,
      options.horizonSeconds ?? settings.horizonSeconds
    );

    // 窗口仍然够用的条件：
    // 1) 前向还有 60s 以上余量（避免刚排完就重启）
    // 2) 已覆盖区间已经够到本轮要求的视野（无限模式要求铺到片尾）
    // 3) 当前播放位置没有退到已覆盖区间之前（否则会出现缓存盲区）
    // 4) 码率档位没变
    const windowStillUseful =
      sameEpisode &&
      sameVariant &&
      sameSkipWindow &&
      this.controller !== null &&
      !this.controller.signal.aborted &&
      options.currentTime + 60 < this.windowTo &&
      this.windowTo + 60 >= requestedTo &&
      options.currentTime >= this.windowFrom;

    if (windowStillUseful) {
      this.emit(options, this.stats);
      return;
    }

    this.stop(sameEpisode && sameVariant);
    const controller = new AbortController();
    this.controller = controller;
    this.episodeKey = options.episodeKey;
    this.sourceKey = sourceKey;
    this.preferredHeight = preferredHeight;
    this.skipWindowKey = skipWindowKey;

    // 先写入近似窗口边界，让窗口判断在 run() 完成解析前就生效。
    // 否则解析期间（await parseM3U8）连续的 ensure 调用会反复重启队列。
    // run() 拿到真实片段时长后会覆盖为精确值。
    this.windowFrom = Math.max(
      0,
      options.currentTime - (options.lookBehindSeconds ?? 30)
    );
    this.windowTo = requestedTo;

    const run = this.run(options, settings, controller.signal).catch(() => {
      if (controller.signal.aborted) return;
      this.controller = null;
      this.emit(options, { state: 'error', message: '缓存存储读取失败' }, true);
    });
    this.pendingRuns.add(run);
    void run.finally(() => this.pendingRuns.delete(run));
  }

  /** 中止并等待在途写入完成，避免清空后旧任务重新写回缓存。 */
  async stopAndWait(): Promise<void> {
    this.stop();
    await Promise.allSettled(Array.from(this.pendingRuns));
  }

  /** 完整停止并重置（切集、换源、卸载时调用） */
  stop(preserveStats = false): void {
    this.controller?.abort();
    this.controller = null;
    if (!preserveStats) {
      this.episodeKey = null;
      this.parsedPlaylist = null;
    }
    this.windowFrom = 0;
    this.windowTo = 0;
    this.reachedEnd = false;
    this.accessDenied = false;
    this.throttled = false;

    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((resolve) => resolve());

    if (!preserveStats) this.stats = { ...IDLE_STATS };
  }

  /**
   * 播放出现 stall 时让出带宽，恢复后解除。
   * 这不是"暂停视频就停缓存"。
   */
  setThrottled(value: boolean): void {
    if (value === this.throttled) return;
    this.throttled = value;
    if (value) {
      this.activeRequests.forEach((request) => request.abort());
    }
    if (!value) {
      const waiters = this.resumeWaiters;
      this.resumeWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  getStats(): PrefetchStats {
    return this.stats;
  }

  private waitWhileThrottled(signal: AbortSignal): Promise<void> {
    if (!this.throttled || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onReady = () => {
        signal.removeEventListener('abort', onReady);
        this.resumeWaiters = this.resumeWaiters.filter(
          (waiter) => waiter !== onReady
        );
        resolve();
      };
      this.resumeWaiters.push(onReady);
      signal.addEventListener('abort', onReady, { once: true });
      if (signal.aborted) onReady();
    });
  }

  private emit(
    options: PrefetchOptions,
    patch: Partial<PrefetchStats>,
    force = false
  ): void {
    this.stats = { ...this.stats, ...patch };
    const previous = this.lastEmittedStats;
    if (
      !force &&
      previous &&
      previous.state === this.stats.state &&
      previous.cached === this.stats.cached &&
      previous.total === this.stats.total &&
      previous.bytes === this.stats.bytes &&
      previous.coverTo === this.stats.coverTo &&
      previous.failed === this.stats.failed &&
      previous.message === this.stats.message
    ) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastEmitAt < EMIT_INTERVAL_MS) return;
    this.lastEmitAt = now;
    this.lastEmittedStats = this.stats;
    options.onProgress?.(this.stats);
  }

  private async run(
    options: PrefetchOptions,
    settings: CacheSettings,
    signal: AbortSignal
  ): Promise<void> {
    // 等待已中止队列的在途写入，避免旧任务与新队列交叉更新统计。
    await Promise.allSettled(Array.from(this.pendingRuns));
    if (signal.aborted) return;
    const useProxy = options.useProxy ?? settings.useProxy;
    // 用户在缓存设置里选的档位并发（2/4/8）就是实际并发：以前这里叠了一层
    // `getPrefetchLimit(4MiB)` + 固定 6 路封顶，档位形同虚设。
    // 内存兜底改由共享下载额度（prefetchDownloadLimiter）负责。
    const concurrency = clampPrefetchConcurrency(
      options.concurrency ?? settings.concurrency
    );
    const lookBehind = Math.max(0, options.lookBehindSeconds ?? 30);

    const horizonSeconds = options.horizonSeconds ?? settings.horizonSeconds;
    /** 时间上限关闭时队列铺到片尾，此时唯一的兜底是字节上限 + LRU 淘汰 */
    const unlimitedHorizon = !(horizonSeconds > 0);
    const horizonTime = horizonEndTime(options.currentTime, horizonSeconds);

    let playlist = this.parsedPlaylist;
    if (!playlist) {
      this.emit(options, { state: 'parsing', message: undefined }, true);
      let task: Awaited<ReturnType<typeof parseM3U8>>;
      try {
        // 档位透传给解析器：主播放列表有多个码率时只取与当前播放一致的那一档
        task = await parseM3U8(options.m3u8Url, 0, {
          height: options.preferredHeight ?? null,
          signal,
        });
      } catch {
        if (signal.aborted) return;
        this.controller = null;
        this.emit(
          options,
          { state: 'error', message: '播放列表解析失败' },
          true
        );
        return;
      }
      if (signal.aborted) return;
      if (task.tsUrlList.length === 0) {
        this.controller = null;
        this.emit(options, { state: 'error', message: '播放列表为空' }, true);
        return;
      }
      playlist = { task, cumulative: toCumulative(task.segmentDurations) };
      // 拖动只保留已完成的点播列表；切集、换源和换画质会通过 stop() 清除。
      if (task.isLive === false) this.parsedPlaylist = playlist;
    } else {
      this.emit(options, { state: 'running', message: undefined }, true);
    }

    const { task, cumulative } = playlist;
    const durationsUsable =
      task.durationSecond > 0 && cumulative[cumulative.length - 1] > 0;

    let queue: number[];

    if (durationsUsable) {
      const startIndex = indexAtTime(cumulative, options.currentTime);
      const fromIndex = indexAtTime(
        cumulative,
        Math.max(0, options.currentTime - lookBehind)
      );

      let endIndex = task.tsUrlList.length - 1;
      for (let i = startIndex; i < cumulative.length; i += 1) {
        if (cumulative[i] > horizonTime) {
          endIndex = i;
          break;
        }
      }

      this.windowFrom = Math.max(0, options.currentTime - lookBehind);
      this.windowTo = cumulative[endIndex] ?? cumulative[cumulative.length - 1];
      // 已排到播放列表最后一个片段，说明不存在"更远但还没缓存"的内容了
      this.reachedEnd = endIndex >= task.tsUrlList.length - 1;

      // 队列顺序：先前向（急），再回看（缓）
      queue = [];
      for (let i = startIndex; i <= endIndex; i += 1) queue.push(i);
      for (let i = startIndex - 1; i >= fromIndex; i -= 1) queue.push(i);
    } else {
      // 时长信息缺失：退化为"从头往后预取"。设了时间上限时截断到固定数量，
      // 无限模式则铺满整个列表（没有时长信息无法按时间判断终点）。
      const limit = unlimitedHorizon
        ? task.tsUrlList.length
        : Math.min(task.tsUrlList.length, FALLBACK_MAX_SEGMENTS);
      queue = [];
      for (let i = 0; i < limit; i += 1) queue.push(i);
      this.windowFrom = 0;
      this.windowTo = Number.MAX_SAFE_INTEGER;
      this.reachedEnd = limit >= task.tsUrlList.length;
    }

    if (durationsUsable) {
      const playableStart = Math.max(0, options.skipIntroSeconds || 0);
      const playableEnd = Math.max(
        0,
        cumulative[cumulative.length - 1] -
          Math.max(0, options.skipOutroSeconds || 0)
      );
      // 保留跨越边界的分片，以免正文开头/结尾缺少解码数据。
      queue = queue.filter((index) => {
        const start = index === 0 ? 0 : cumulative[index - 1];
        return (
          playableEnd > playableStart &&
          cumulative[index] > playableStart &&
          start < playableEnd
        );
      });
    }

    void ensurePersistentStorage();

    const segmentKeys = task.tsUrlList.map((url, index) =>
      buildSegmentCacheKey(url, useProxy, task.segmentByteRanges?.[index])
    );
    const keyVariants = segmentKeys.map(getCacheKeyVariants);
    const relevantKeys = new Set(keyVariants.flat());
    const cachedSizes: Array<number | undefined> = Array(segmentKeys.length);
    const versions = Array(segmentKeys.length).fill(0);
    let cached = 0;
    let bytes = 0;
    let coverTo = 0;
    /**
     * 下载路由阶段。
     *
     * - `direct`：先直连，单片失败后再用代理兜一次；
     * - `proxy`：直连失败密集后整体切过来，只走代理——不再为每个分片
     *   白试 4 次已知不可用的直连，同时给代理一次独立评估的机会。
     */
    let routeStage: 'direct' | 'proxy' = 'direct';
    /** 本阶段连续失败的分片数，任一分片成功即清零 */
    let consecutiveFailures = 0;
    /** 本阶段成功 / 失败的分片数（切阶段时归零，避免新旧阶段的失败互相污染） */
    let stageSucceeded = 0;
    let stageFailed = 0;
    /**
     * 两条路由都失败、尚未补下的分片。
     *
     * 切到代理阶段时会把它们重新排进队列补下；补下成功后移除。
     * 因此它同时就是 `stats.failed`（真实缺口，而不是"曾经失败过"）。
     */
    const failedIndices = new Set<number>();
    const updateSegmentStats = (index: number, size: number | undefined) => {
      const previous = cachedSizes[index];
      if (previous === size) return;
      if (previous !== undefined) {
        cached -= 1;
        bytes -= previous;
        coverTo -= task.segmentDurations[index] || 0;
      }
      cachedSizes[index] = size;
      if (size !== undefined) {
        cached += 1;
        bytes += size;
        coverTo += task.segmentDurations[index] || 0;
      }
    };
    const emitSegmentStats = (force = false) =>
      this.emit(
        options,
        {
          cached,
          bytes,
          coverTo,
          failed: failedIndices.size,
          total: task.tsUrlList.length,
        },
        force
      );
    let lastStatsAt = 0;
    let statsRefresh: Promise<void> | null = null;
    const refreshStats = async (force = false): Promise<void> => {
      if (statsRefresh) {
        await statsRefresh;
        if (!force) return;
      }
      if (
        signal.aborted ||
        (!force && Date.now() - lastStatsAt < STATS_REFRESH_INTERVAL_MS)
      )
        return;
      lastStatsAt = Date.now();
      statsRefresh = (async () => {
        const snapshotVersions = versions.slice();
        const records = await getCachedSegmentRecords();
        if (signal.aborted) return;
        const byKey = new Map<string, (typeof records)[number]>();
        for (let i = 0; i < records.length; i += 1) {
          for (const key of getCacheKeyVariants(records[i].key)) {
            if (relevantKeys.has(key)) byKey.set(key, records[i]);
          }
          if (i > 0 && i % 256 === 0) {
            await waitForRetry(0, signal);
          }
        }
        for (let i = 0; i < segmentKeys.length; i += 1) {
          const record = keyVariants[i]
            .map((key) => byKey.get(key))
            .find(Boolean);
          // Do not overwrite a segment committed while the snapshot was loading.
          if (versions[i] === snapshotVersions[i]) {
            updateSegmentStats(i, record?.bytes);
          }
          if (i > 0 && i % 256 === 0) {
            await waitForRetry(0, signal);
          }
          if (!record) continue;
          // 用当前播放列表补齐旧缓存的时间信息，无需重新下载。
          const startTime = i === 0 ? 0 : cumulative[i - 1];
          const endTime = cumulative[i];
          if (
            durationsUsable &&
            (record.startTime !== startTime || record.endTime !== endTime)
          ) {
            await metaStore.put({ ...record, startTime, endTime });
            if (signal.aborted) return;
          }
        }
        emitSegmentStats(force);
      })();
      try {
        await statsRefresh;
      } finally {
        statsRefresh = null;
      }
    };

    await refreshStats(true);
    if (signal.aborted) return;
    this.emit(options, { state: 'running', message: undefined }, true);

    let cursor = 0;
    let lastEvictAt = Date.now();
    /** 存储配额耗尽：淘汰也腾不出空间，继续拉分片只会白烧流量 */
    let storageFull = false;
    let accessError: string | undefined;
    const proxyOrigins = new Set<string>();
    const requests = new AbortController();
    const cancelRequests = () => requests.abort();
    signal.addEventListener('abort', cancelRequests, { once: true });
    if (signal.aborted) requests.abort();
    const denyAccess = (message: string) => {
      if (accessError || signal.aborted) return;
      accessError = message;
      this.accessDenied = true;
      requests.abort();
      this.setThrottled(false);
    };

    /**
     * 记录一个"本阶段所有路由都失败"的分片，并判断下一步动作。
     *
     * - `continue`：个别坏片，跳过继续；
     * - `switch`：直连阶段失败密集 → 整体切到代理（並补下已失败的分片）；
     * - `abort`：当前阶段（代理阶段，或不允许代理）失败密集 → 源不可用。
     */
    const noteStageFailure = (
      segmentIndex: number
    ): 'continue' | 'switch' | 'abort' => {
      stageFailed += 1;
      consecutiveFailures += 1;
      failedIndices.add(segmentIndex);
      emitSegmentStats();
      const handled = stageFailed + stageSucceeded;
      const dense =
        consecutiveFailures >= MAX_CONSECUTIVE_SEGMENT_FAILURES ||
        (handled >= MIN_SEGMENT_FAILURE_SAMPLE &&
          stageFailed / handled > SEGMENT_FAILURE_RATIO_LIMIT);
      if (!dense) return 'continue';
      return routeStage === 'direct' && useProxy ? 'switch' : 'abort';
    };

    const worker = async (): Promise<void> => {
      while (!signal.aborted && !storageFull && !accessError) {
        await this.waitWhileThrottled(requests.signal);
        if (signal.aborted || accessError) return;

        const slot = cursor;
        cursor += 1;
        if (slot >= queue.length) return;

        const segmentIndex = queue[slot];
        const range = task.segmentByteRanges?.[segmentIndex];
        const directUrl = buildSegmentCacheKey(
          task.tsUrlList[segmentIndex],
          false
        );
        const origin = new URL(directUrl).origin;
        const cacheKey = buildSegmentCacheKey(
          task.tsUrlList[segmentIndex],
          useProxy,
          range
        );

        let releaseDownload: (() => void) | undefined;
        try {
          const alreadyCached = await hasCachedSegment(cacheKey);
          if (signal.aborted || accessError) return;
          if (alreadyCached) {
            await refreshStats();
            continue;
          }

          releaseDownload = await prefetchDownloadLimiter.acquire(
            requests.signal
          );
          const startedAt = Date.now();
          const loadSegment = (url: string) =>
            retrySegmentDownload(async () => {
              for (;;) {
                await this.waitWhileThrottled(requests.signal);
                if (requests.signal.aborted) {
                  throw new DOMException('Aborted', 'AbortError');
                }
                if (this.throttled) continue;
                const request = new AbortController();
                const cancel = () => request.abort();
                requests.signal.addEventListener('abort', cancel, {
                  once: true,
                });
                this.activeRequests.add(request);
                try {
                  const response = await fetch(url, {
                    signal: request.signal,
                    credentials: 'omit',
                    cache: 'no-store',
                    headers: range
                      ? { Range: byteRangeHeader(range) }
                      : undefined,
                  });
                  if (!response.ok) {
                    await response.body?.cancel();
                    throw new Error(`HTTP ${response.status}`);
                  }
                  const expectedBytes = range
                    ? range.end - range.start
                    : Number(response.headers.get('Content-Length'));
                  if (Number.isFinite(expectedBytes) && expectedBytes > 0) {
                    observePrefetchSegment(expectedBytes);
                  }
                  const buffer = await readByteRangeResponse(response, range);
                  observePrefetchSegment(buffer.byteLength);
                  return { response, buffer };
                } catch (error) {
                  const interrupted =
                    request.signal.aborted && !requests.signal.aborted;
                  if (!interrupted) throw error;
                } finally {
                  this.activeRequests.delete(request);
                  requests.signal.removeEventListener('abort', cancel);
                }
                // Bandwidth yielding is not a download failure or a retry attempt.
              }
            }, requests.signal);
          const proxyUrl = buildSegmentCacheKey(
            task.tsUrlList[segmentIndex],
            true
          );
          /**
           * 按当前阶段选路：
           *  - 代理阶段：只走代理，给代理一次独立的成败评估；
           *  - 该源此前代理成功过：代理优先，失败后回直连兜一次；
           *  - 其它：直连优先，失败后用代理兜一次（并记住这个源）。
           */
          const loadWithFallback = async () => {
            if (routeStage === 'proxy') {
              const viaProxy = await loadSegment(proxyUrl);
              proxyOrigins.add(origin);
              return viaProxy;
            }
            if (useProxy && proxyOrigins.has(origin)) {
              try {
                return await loadSegment(proxyUrl);
              } catch (error) {
                if (requests.signal.aborted) throw error;
                // 代理这次不行了：忘掉标记，回直连兜一次，避免整源被拖死
                proxyOrigins.delete(origin);
                return loadSegment(directUrl);
              }
            }
            try {
              return await loadSegment(directUrl);
            } catch (error) {
              if (requests.signal.aborted || !useProxy) throw error;
            }
            const viaProxy = await loadSegment(proxyUrl);
            proxyOrigins.add(origin);
            return viaProxy;
          };

          let segment: Awaited<ReturnType<typeof loadSegment>>;
          try {
            segment = await loadWithFallback();
          } catch (error) {
            if (requests.signal.aborted) return;
            const reason =
              error instanceof Error ? error.message : '网络请求失败';
            const decision = noteStageFailure(segmentIndex);
            if (decision === 'switch') {
              // 直连失败密集：整体切到代理阶段，并把已失败的分片重新排队补下。
              routeStage = 'proxy';
              consecutiveFailures = 0;
              stageSucceeded = 0;
              stageFailed = 0;
              queue.push(...Array.from(failedIndices));
              emitSegmentStats();
              continue;
            }
            if (decision === 'abort') {
              denyAccess(
                `${
                  routeStage === 'proxy' ? '代理' : '直连'
                }缓存连续失败（最近一次：${reason}），${
                  failedIndices.size
                } 个分片未缓存，请更换播放源`
              );
              return;
            }
            continue;
          }

          // 拿到响应即视为该分片所属源可用，用于失败占比判断。
          stageSucceeded += 1;
          consecutiveFailures = 0;
          failedIndices.delete(segmentIndex);

          const { response, buffer } = segment;
          const costMs = Math.max(1, Date.now() - startedAt);

          if (signal.aborted || accessError) return;
          const releaseWrite = await prefetchWriteLimiter.acquire(
            requests.signal
          );
          try {
            const putResult = await putCachedSegmentResilient(
              cacheKey,
              buffer,
              response.headers.get('Content-Type'),
              settings
            );
            // 已经落盘的片段仍需登记元数据；新队列会等待本轮写入结束。
            if (signal.aborted && putResult !== 'ok') return;
            if (putResult === 'quota') {
              storageFull = true;
              requests.abort();
              this.setThrottled(false);
              return;
            }
            if (putResult !== 'ok') continue;

            await metaStore.put({
              key: cacheKey,
              episodeKey: options.episodeKey,
              title: options.title || '未知影片',
              source: options.source || '未知来源',
              index: segmentIndex + 1,
              startTime: durationsUsable
                ? segmentIndex === 0
                  ? 0
                  : cumulative[segmentIndex - 1]
                : undefined,
              endTime: durationsUsable ? cumulative[segmentIndex] : undefined,
              bytes: buffer.byteLength,
              costMs,
              lastAccess: Date.now(),
            });
          } finally {
            releaseWrite();
          }

          if (signal.aborted || accessError) return;
          versions[segmentIndex] += 1;
          updateSegmentStats(segmentIndex, buffer.byteLength);
          emitSegmentStats();
          await refreshStats();
        } catch {
          // 单个片段失败（含 abort）不影响整轮，继续下一个
          if (signal.aborted || accessError) return;
        } finally {
          releaseDownload?.();
        }

        if (Date.now() - lastEvictAt > EVICT_INTERVAL_MS) {
          lastEvictAt = Date.now();
          await enforceQuota(settings);
          if (signal.aborted) return;
          await refreshStats(true);
        }
        // Break up fast cache writes instead of chaining an entire playlist in microtasks.
        if (cursor % 16 === 0) await waitForRetry(0, signal);
      }
    };

    // 把本轮并发登记进共享下载额度，否则调度器的默认额度会再次把高并发压回去。
    const releaseConcurrency = registerPrefetchConcurrency(concurrency);
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, worker)
      );
    } finally {
      signal.removeEventListener('abort', cancelRequests);
      releaseConcurrency();
    }
    if (signal.aborted) return;

    await enforceQuota(settings);
    if (signal.aborted) return;
    await refreshStats(true);
    if (signal.aborted) return;
    if (accessError) {
      this.emit(options, { state: 'error', message: accessError }, true);
      return;
    }
    if (storageFull) {
      // 用 `error` 而不是 `done`：得让 tooltip 原样显示这条 message，
      // 否则用户只会看到计数器停在某一格，不知道是磁盘写不进去了。
      this.emit(
        options,
        {
          state: 'error',
          message: `存储空间已满，缓存 ${this.stats.cached} 个片段后停止`,
        },
        true
      );
      return;
    }
    this.emit(
      options,
      {
        state: 'done',
        message:
          failedIndices.size > 0
            ? `已缓存 ${this.stats.cached} 个片段，${failedIndices.size} 个分片下载失败已跳过`
            : `已缓存 ${this.stats.cached} 个片段`,
      },
      true
    );
  }
}

/** 全站单例：跨组件 / 跨路由复用同一份队列，避免重复预取同一片段 */
let singleton: VideoPrefetcher | null = null;

export function getVideoPrefetcher(): VideoPrefetcher {
  if (!singleton) singleton = new VideoPrefetcher();
  return singleton;
}

/**
 * 「下一集预热」专用实例（落地路线第 3 步）。
 *
 * **必须**与 `getVideoPrefetcher()` 分开：一个实例只有一条队列和一个
 * `AbortController`，复用会把当前正在播的那一集的队列打断。
 *
 * 两个实例写的是同一个 Cache Storage 与 IndexedDB——缓存键由分片 URL 决定，
 * 所以预热好的分片在真正切到下一集时会被 hls.js 直接命中。
 */
let nextEpisodeSingleton: VideoPrefetcher | null = null;

export function getNextEpisodePrefetcher(): VideoPrefetcher {
  if (!nextEpisodeSingleton) nextEpisodeSingleton = new VideoPrefetcher();
  return nextEpisodeSingleton;
}
