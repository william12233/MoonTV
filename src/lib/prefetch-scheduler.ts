import { CACHE_CONCURRENCY_PRESETS } from './video-cache';

/** Abortable slots shared by current-episode prefetch and next-episode warmup. */
export class PrefetchLimiter {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (this.active < this.limit()) {
        this.active += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.wake();
        };
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener('abort', onAbort);
          this.waiters = this.waiters.filter((waiter) => waiter !== onReady);
        };
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        this.waiters.push(onReady);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /**
   * 额度被调大后主动唤醒排队任务。
   *
   * 否则只有在"某个在途任务释放"时才会重新检查上限，新开的高并发设置
   * 要等下一批下载结束才生效。`wake()` 唤醒后每个任务都会重新校验，
   * 仍然超限的会重新排队，所以多唤醒是安全的。
   */
  notifyLimitChanged(): void {
    if (this.waiters.length > 0 && this.active < this.limit()) this.wake();
  }
}

/**
 * 并发上限：直接取缓存设置里的最高档。
 *
 * 设置界面只提供低/中/高三档，调度器不再有独立的"自定义并发"概念；
 * 预热这类低优先级队列可以传更小的值（1），但不会超过最高档。
 */
export const MAX_PREFETCH_CONCURRENCY = CACHE_CONCURRENCY_PRESETS.high;

/**
 * 在途分片的总内存预算（下载中的 Buffer + 待写入队列）。
 *
 * 依据采集站的真实分布（分片 0.5–5 MB，高码 1080p/4K 到 8–12 MB）反推：
 *
 * - 桌面 96 MiB = 最高档 8 路 × 12 MiB，保证正常分片永远跑满档位；
 * - 弱设备减半 48 MiB = 8 路 × 6 MiB，覆盖移动端 1080p 的典型分片。
 *
 * 只有单分片超过 12 MiB（桌面）/ 6 MiB（弱设备）时，才会按内存收敛并发。
 */
const IN_FLIGHT_BYTES = 96 * 1024 * 1024;
const CONSTRAINED_IN_FLIGHT_BYTES = 48 * 1024 * 1024;

/** 把任意输入收敛成 [1, 最高档] 的整数；非法输入回落到低档（默认设置） */
export function clampPrefetchConcurrency(value: unknown): number {
  const rounded =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value)
      : CACHE_CONCURRENCY_PRESETS.low;
  return Math.max(1, Math.min(MAX_PREFETCH_CONCURRENCY, rounded));
}

/**
 * 二等消费者（下一集预热）的并发：取用户档位的一半，至少 1 路。
 *
 * 预热只在当前集视野铺满后启动，但播放器仍在跑——seek、ABR 换档、hls.js
 * 重取分片都要抢带宽，所以不直接用整档。共享下载额度
 * （`prefetchDownloadLimiter`）仍按档位封顶，因此这里的值只决定预热
 * 自己派发几个 worker，两轮之和不会超过档位。
 *
 * 采集站单连接通常被限速在 1–5 MB/s，`tier / 2` 让预热在 7 分钟（约 87 个
 * 分片 / 262 MB）内能在 30 s 量级铺完，同时给播放留出至少一半带宽。
 */
export function getWarmupConcurrency(tier: number): number {
  return Math.max(1, Math.floor(clampPrefetchConcurrency(tier) / 2));
}

function isConstrainedDevice(): boolean {
  const nav =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & {
          deviceMemory?: number;
          connection?: { effectiveType?: string };
        });
  return (
    (nav?.deviceMemory !== undefined && nav.deviceMemory <= 4) ||
    (nav?.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 4) ||
    nav?.connection?.effectiveType === '3g'
  );
}

/**
 * 并发额度 = `min(档位, 内存预算 ÷ 单分片估算)`。
 *
 * 内存只是兜底，不是日常参数：分片按采集站中位数 5 MB 算，
 * `96 MiB ÷ 5 MiB = 19`，远高于最高档 8，所以**档位就是实际并发**。
 * 只有 4K 长 GOP（>12 MB/片）或 byte-range 大区间才会被压低。
 *
 * 不传 `requested`（没有活跃预取轮次）时按低档计算。
 */
export function getPrefetchLimit(
  segmentBytes: number,
  requested?: number
): number {
  const ceiling = clampPrefetchConcurrency(
    requested ?? CACHE_CONCURRENCY_PRESETS.low
  );
  const workingSet = isConstrainedDevice()
    ? CONSTRAINED_IN_FLIGHT_BYTES
    : IN_FLIGHT_BYTES;
  return Math.max(
    1,
    Math.min(ceiling, Math.floor(workingSet / Math.max(1, segmentBytes)))
  );
}

/** 估算的上下限，避免异常缓存条目或首片把并发算歪 */
const MIN_SEGMENT_BYTES = 1.5 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
/** 新样本权重：能跟随当前剧集，又不被单片抖动带偏 */
const SEGMENT_SAMPLE_WEIGHT = 0.4;

/** 初值取 1080p 的常见分片大小 */
let estimatedSegmentBytes = 4 * 1024 * 1024;

/**
 * 用 EWMA 跟踪当前播放列表的分片大小。
 *
 * 旧实现是 `max(4MB, bytes, prev * 0.9)`——只涨不跌：遇到一次 4K 大分片后，
 * 即使切回 1080p 源，估算仍停在十几 MB，后续剧集的并发被白白压低。
 * EWMA 会在几个分片内回到当前源的真实水平。
 */
export function observePrefetchSegment(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const sample = Math.min(
    MAX_SEGMENT_BYTES,
    Math.max(MIN_SEGMENT_BYTES, bytes)
  );
  estimatedSegmentBytes =
    estimatedSegmentBytes * (1 - SEGMENT_SAMPLE_WEIGHT) +
    sample * SEGMENT_SAMPLE_WEIGHT;
}

/**
 * 当前活跃预取轮次里最大的并发需求。
 *
 * 「当前集」与「下一集预热」共用一个下载额度，取最大值而不是各自的值：
 * 每轮自己的 worker 数量已经限制了自己的并发，额度只要不低于其中最大的
 * 一轮即可，否则用户设的高档会被预热那一轮的默认值压回去。
 */
const concurrencyDemands = new Map<number, number>();

function demandedPrefetchConcurrency(): number {
  let max = 0;
  concurrencyDemands.forEach((_count, demand) => {
    if (demand > max) max = demand;
  });
  return max;
}

export const prefetchDownloadLimiter = new PrefetchLimiter(() => {
  const demand = demandedPrefetchConcurrency();
  return demand > 0
    ? getPrefetchLimit(estimatedSegmentBytes, demand)
    : getPrefetchLimit(estimatedSegmentBytes);
});
export const prefetchWriteLimiter = new PrefetchLimiter(() => 1);

/** 登记一轮预取的并发数，返回注销函数（同步额度并唤醒排队任务） */
export function registerPrefetchConcurrency(value: unknown): () => void {
  const demand = clampPrefetchConcurrency(value);
  concurrencyDemands.set(demand, (concurrencyDemands.get(demand) ?? 0) + 1);
  prefetchDownloadLimiter.notifyLimitChanged();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (concurrencyDemands.get(demand) ?? 0) - 1;
    if (remaining > 0) concurrencyDemands.set(demand, remaining);
    else concurrencyDemands.delete(demand);
  };
}

/** Hysteresis avoids repeatedly stopping/restarting requests near the threshold. */
export function shouldThrottlePrefetch(
  video: Pick<
    HTMLVideoElement,
    | 'paused'
    | 'seeking'
    | 'currentTime'
    | 'duration'
    | 'playbackRate'
    | 'buffered'
  >,
  wasThrottled: boolean
): boolean {
  if (video.seeking) return true;
  if (video.paused) return false;
  let ahead = 0;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (
      video.buffered.start(i) <= video.currentTime &&
      video.buffered.end(i) > video.currentTime
    ) {
      ahead = video.buffered.end(i) - video.currentTime;
      break;
    }
  }
  if (
    Number.isFinite(video.duration) &&
    video.duration > 0 &&
    ahead > 0 &&
    video.currentTime + ahead >= video.duration - 0.25
  ) {
    return false;
  }
  const playbackSeconds = ahead / Math.max(0.1, video.playbackRate);
  return playbackSeconds < (wasThrottled ? 15 : 5);
}
