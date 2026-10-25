/** 搜索结果源级并发的默认值（用户设置缺失时使用）。 */
export const DEFAULT_SEARCH_CONCURRENCY = 6;

/** 搜索结果源级并发的上限，避免单个请求开出过多上游连接。 */
export const MAX_SEARCH_CONCURRENCY = 20;

/**
 * 把任意输入收敛到合法的并发区间 [1, MAX_SEARCH_CONCURRENCY]。
 * 空值、非数字、0 与负数视为未设置，回退默认值。
 */
export function clampSearchConcurrency(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SEARCH_CONCURRENCY;
  }

  return Math.max(1, Math.min(MAX_SEARCH_CONCURRENCY, Math.floor(parsed)));
}

/**
 * 从 localStorage 读取用户设置的搜索并发数。
 * 服务端或读取异常时回退默认值。
 */
export function getSearchConcurrency(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_SEARCH_CONCURRENCY;
  }

  try {
    return clampSearchConcurrency(localStorage.getItem('searchConcurrency'));
  } catch {
    return DEFAULT_SEARCH_CONCURRENCY;
  }
}

/**
 * 以受限并发执行异步任务，返回值顺序与输入顺序一致。
 *
 * 任一任务抛错时整体 reject；如果希望“单项失败不影响其他项”，
 * 请在任务内部自行捕获异常并返回兜底值。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  // 非法/过小的上限退化为串行，上限也不会超过任务总数。
  const concurrency = Math.max(
    1,
    Math.min(Math.floor(limit) || 1, items.length)
  );
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
