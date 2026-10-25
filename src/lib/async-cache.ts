/**
 * 为异步加载函数增加「近似 LRU 缓存 + 并发去重」。
 *
 * - 成功结果才会缓存；失败会被剔除，下一次调用可以重试。
 * - 同一 key 在请求返回前复用同一个 Promise。
 */
export function memoizeAsync<TArgs extends unknown[], TResult>(
  keyFn: (...args: TArgs) => string,
  load: (...args: TArgs) => Promise<TResult>,
  limit = 200
): (...args: TArgs) => Promise<TResult> {
  const cache = new Map<string, TResult>();
  const inflight = new Map<string, Promise<TResult>>();

  const store = (key: string, value: TResult) => {
    if (cache.size >= limit) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    cache.set(key, value);
  };

  return (...args: TArgs) => {
    const key = keyFn(...args);
    const cached = cache.get(key);
    if (cached !== undefined) {
      // 命中后刷新顺序，实现近似 LRU 的淘汰顺序
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(cached);
    }

    const pending = inflight.get(key);
    if (pending) {
      return pending;
    }

    const request = load(...args).then((value) => {
      store(key, value);
      return value;
    });

    inflight.set(key, request);
    void request
      .catch(() => {
        // 失败结果由调用方处理，此处仅避免未处理的 Promise 拒绝
      })
      .finally(() => {
        inflight.delete(key);
      });

    return request;
  };
}
