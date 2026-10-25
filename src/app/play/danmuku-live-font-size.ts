/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types */

/**
 * 官方插件在 config({ fontSize }) 时会 reset()，把正在飞的弹幕全部清掉重排。
 * 这里跳过 reset，已上屏弹幕保持原样；新弹幕用新字号。
 * 字号仅在停止拖动（pointerup）时应用到弹幕并写入本地；拖动过程中滑条数字仍会变。
 * 不透明度拖动时仍即时生效，写入本地延迟 160ms。
 *
 * 官方 getDanmuTop 在找不到等高空隙时，会把新弹幕塞进旧弹幕的 top。
 * 字号变大后轨道实际变高，仍用旧 top 就会压到下一行。因此拦截 postMessage，
 * 按当前弹幕高度重算轨道数，只有整条轨道空闲（或滚动弹幕同轨且不会追上）才占用。
 */

import { createDanmakuDensityThrottle } from './play-utils';
import { pushPlayerNotice } from './player-notice';

type VisibleDanmu = {
  top: number;
  height: number;
  right: number;
  speed: number;
  distance: number;
  time: number;
  mode: number;
};

type DanmuTopTarget = {
  mode: number;
  height: number;
  speed: number;
};

function isDanmukuInstance(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object') return false;
  const inst = value as Record<string, any>;
  return (
    Array.isArray(inst.queue) &&
    inst.states &&
    inst.$danmuku &&
    typeof inst.config === 'function' &&
    typeof inst.makeWait === 'function' &&
    typeof inst.filter === 'function'
  );
}

function verticalOverlap(
  top: number,
  height: number,
  item: VisibleDanmu
): boolean {
  return item.top < top + height && item.top + item.height > top;
}

/** 与官方一致：滚动弹幕同轨时，判断后发的会不会追上前面的 */
function canShareScrollLane(
  target: DanmuTopTarget,
  item: VisibleDanmu,
  clientWidth: number
): boolean {
  // 前一条还没完全进入画面时，后发从同一右边缘起步会直接压上去
  if (clientWidth < item.distance) return false;
  if (target.speed < item.speed) return true;
  const speedDiff = target.speed - item.speed;
  if (speedDiff <= 0) return true;
  return item.right / speedDiff > item.time;
}

type LaneState = 'free' | 'shareable' | 'blocked';

/**
 * 判断候选轨道与已上屏弹幕的关系。
 *
 * - free：整条轨道没有同类型弹幕，优先使用；
 * - shareable：仅滚动弹幕同轨且不会追尾（或关闭了防重叠），可作为次选；
 * - blocked：已有弹幕占用且不能共享。
 */
function getLaneState(
  top: number,
  target: DanmuTopTarget,
  visibles: VisibleDanmu[],
  clientWidth: number,
  antiOverlap: boolean
): LaneState {
  let shareable = false;

  for (let i = 0; i < visibles.length; i += 1) {
    const item = visibles[i];
    if (item.mode !== target.mode) continue;
    if (!verticalOverlap(top, target.height, item)) continue;

    // 不同起点的弹幕落在新轨道高度内：一定纵向重叠，不能占用
    const sameRow = Math.abs(item.top - top) < 1;
    if (!sameRow) return 'blocked';

    if (target.mode !== 0) return 'blocked';
    if (antiOverlap && !canShareScrollLane(target, item, clientWidth)) {
      return 'blocked';
    }

    shareable = true;
  }

  return shareable ? 'shareable' : 'free';
}

/**
 * 从候选轨道中随机选择。
 *
 * 官方逻辑总是选最上方的可用轨道，弹幕稀疏时全部堆在顶部。随机落位可以让
 * 通过限流的弹幕均匀铺满所有开放轨道；候选轨道之间互不重叠，因此不会出现
 * 两条弹幕压在同一轨道上。
 */
function pickLane(tops: number[]): number {
  if (tops.length === 1) return tops[0];
  return tops[Math.floor(Math.random() * tops.length)];
}

/**
 * 计算新弹幕应当落位的轨道顶部坐标。
 *
 * 优先选择完全没有弹幕的轨道（候选轨道中随机落位），只有在所有轨道都已被
 * 占用时才复用可共享的滚动轨道，避免弹幕密集时全部堆在第一条轨道右侧排队。
 */
export function computeDanmuTop(payload: {
  target: DanmuTopTarget;
  visibles?: VisibleDanmu[];
  antiOverlap?: boolean;
  clientWidth: number;
  clientHeight: number;
  marginBottom: number;
  marginTop: number;
}): number | undefined {
  const {
    target,
    visibles = [],
    antiOverlap = true,
    clientWidth,
    clientHeight,
    marginBottom,
    marginTop,
  } = payload;

  const height = Math.max(1, Number(target.height) || 0);
  const minTop = Math.max(0, marginTop);
  const maxBottom = Math.max(minTop, clientHeight - marginBottom);
  const usable = maxBottom - minTop;

  if (height > usable) {
    const top = target.mode === 2 ? maxBottom - height : minTop;
    return getLaneState(top, target, visibles, clientWidth, antiOverlap) ===
      'blocked'
      ? undefined
      : top;
  }

  const laneCount = Math.max(1, Math.floor(usable / height));
  const freeTops: number[] = [];
  const shareableTops: number[] = [];

  for (let i = 0; i < laneCount; i += 1) {
    const top =
      target.mode === 2 ? maxBottom - height * (i + 1) : minTop + i * height;

    if (target.mode === 2) {
      if (top < minTop) continue;
    } else if (top + height > maxBottom + 0.5) {
      continue;
    }

    const state = getLaneState(top, target, visibles, clientWidth, antiOverlap);
    if (state === 'free') {
      freeTops.push(top);
    } else if (state === 'shareable') {
      shareableTops.push(top);
    }
  }

  // 先铺满完全空闲的轨道；只有所有轨道都已在用时，才复用可共享的轨道。
  if (freeTops.length > 0) return pickLane(freeTops);
  if (shareableTops.length > 0) return pickLane(shareableTops);
  return undefined;
}

/**
 * 当前可用轨道数，与 computeDanmuTop 的 laneCount 保持一致。
 *
 * 密度节流器用它把「每轨每秒条数」换算成实际放行速率：屏幕越高、字号越小，
 * 轨道越多，允许的上屏速率也越高。
 */
function countDanmuLanes(
  payload: {
    target?: { height?: number };
    clientHeight?: number;
    marginTop?: number;
    marginBottom?: number;
  },
  laneHeight?: number
): number {
  const height = Math.max(
    1,
    Number(laneHeight) || Number(payload.target?.height) || 0
  );
  const minTop = Math.max(0, Number(payload.marginTop) || 0);
  const maxBottom = Math.max(
    minTop,
    (Number(payload.clientHeight) || 0) - (Number(payload.marginBottom) || 0)
  );

  return Math.max(1, Math.floor((maxBottom - minTop) / height));
}

/**
 * 解析哔哩哔哩 XML 弹幕（与官方 bilibili 解析器输出格式一致）。
 *
 * 官方解析器内部用 `new Promise(async ...)` 包装 fetch：请求失败时异常不会
 * 传给外层 Promise，而是变成 unhandled rejection，同时 load() 永远 pending。
 * 因此这里自己请求并解析，让失败变成可控的 Promise rejection。
 */
function parseBilibiliDanmakuXml(xml: string): any[] {
  const result: any[] = [];
  const regex = /<d[^>]*?p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml))) {
    const parts = match[1].split(',');
    if (parts.length < 8) continue;

    const rawMode = Number(parts[1]);
    const mode = rawMode === 4 ? 2 : rawMode === 5 ? 1 : 0;

    result.push({
      text: match[2]
        .trim()
        .replaceAll('&' + 'quot;', '"')
        .replaceAll('&' + 'apos;', String.fromCharCode(39))
        .replaceAll('&' + 'lt;', '<')
        .replaceAll('&' + 'gt;', '>')
        .replaceAll('&' + 'amp;', '&'),
      time: Number(parts[0]),
      mode,
      fontSize: Number(parts[2]),
      color: `#${Number(parts[3]).toString(16)}`,
      timestamp: Number(parts[4]),
      pool: Number(parts[5]),
      userID: parts[6],
      rowID: Number(parts[7]),
    });
  }

  return result;
}

function patchDanmukuConfig(danmuku: Record<string, any>) {
  if (danmuku.__moontvLiveFontSizePatched) return;
  danmuku.__moontvLiveFontSizePatched = true;

  const originalConfig = danmuku.config.bind(danmuku);
  const originalPostMessage = danmuku.postMessage.bind(danmuku);
  const originalLoad = danmuku.load.bind(danmuku);
  const proto = Object.getPrototypeOf(danmuku);
  const originalFontSizeGet = Object.getOwnPropertyDescriptor(
    proto,
    'fontSize'
  )?.get;

  danmuku.load = async function patchedLoad(...args: any[]) {
    // 显式传入弹幕数组时交给原实现（调用方自行决定是否清空旧队列）
    if (args[0] !== undefined) return originalLoad(...args);

    const url = danmuku.option?.danmuku;
    if (typeof url !== 'string' || !url.trim()) return danmuku;

    let xml: string;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`弹幕请求失败：HTTP ${response.status}`);
      }
      xml = await response.text();
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : '弹幕加载失败';

      danmuku.art?.emit('artplayerPluginDanmuku:error', error);
      // 全屏时页面级提示不可见，播放器右上角再提示一次
      pushPlayerNotice(danmuku.art, message, {
        key: 'danmaku-load-error',
        // 停留 5 秒；durationMs <= 0 才是常驻
        durationMs: 5000,
      });
      throw error;
    }

    // 复刻官方 load() 的 reset 分支：传数组给原实现时它不会自动清空
    try {
      danmuku.reset?.();
    } catch (_) {
      // ignore
    }
    danmuku.queue = [];
    danmuku.states = { wait: [], ready: [], emit: [], stop: [] };
    danmuku.$refs = [];
    if (danmuku.$danmuku) danmuku.$danmuku.textContent = '';

    return originalLoad(parseBilibiliDanmakuXml(xml));
  };

  /** 实例级密度节流器：按当前挡位限制真正上屏的速率 */
  const densityThrottle = createDanmakuDensityThrottle();

  // 每帧最多送多少条 ready 弹幕进入轨道测量。密集挡会有一批弹幕因配额不足
  // 反复回到 ready，若每帧全量处理，DOM 测量会把帧率拖到几帧每秒，反而让
  // 上屏速率掉到个位数。
  const READY_PER_FRAME = 10;
  let readyBudget = READY_PER_FRAME;
  let readyBudgetScheduled = false;

  const takeReadyBudget = () => {
    if (!readyBudgetScheduled && typeof requestAnimationFrame === 'function') {
      readyBudgetScheduled = true;
      requestAnimationFrame(() => {
        readyBudgetScheduled = false;
        readyBudget = READY_PER_FRAME;
      });
    }
    if (readyBudget <= 0) return false;
    readyBudget -= 1;
    return true;
  };

  // wait 弹幕同样做每帧上限：同一时间戳的弹幕成簇时，单帧会有几百条
  // 一起进入窗口，每条都要创建/测量 DOM。超出预算的会随时间窗口滑出，
  // 相当于按密度丢弃，属于预期行为。
  const WAIT_PER_FRAME = 60;
  let waitBudget = WAIT_PER_FRAME;
  let waitBudgetScheduled = false;

  const takeWaitBudget = () => {
    if (!waitBudgetScheduled && typeof requestAnimationFrame === 'function') {
      waitBudgetScheduled = true;
      requestAnimationFrame(() => {
        waitBudgetScheduled = false;
        waitBudget = WAIT_PER_FRAME;
      });
    }
    if (waitBudget <= 0) return false;
    waitBudget -= 1;
    return true;
  };

  const WRAPPED_FLAG = '__moontvDensityWrapped';
  const RAW_FLAG = '__moontvRawBeforeVisible';

  const wrapBeforeVisible = (original: any) => {
    if (typeof original !== 'function') return () => true;

    // 重建播放器时 option 里可能已经是旧实例包装过的函数：取最底层的原始
    // 实现重新包装，避免旧闭包继续拿旧实例的 currentTime / 预算做判断
    const raw = original[WRAPPED_FLAG] ? original[RAW_FLAG] : original;

    const wrapped = (danmu: any, ...rest: any[]) => {
      if (danmu?.$state === 'ready') {
        // 积压太久的弹幕显示出来会与画面严重脱节，直接从 ready 队列丢弃。
        // 不能用 makeWait：它会重新塞回 wait 队列，继续增加每帧遍历开销
        const current = Number(danmuku.art?.currentTime);
        const time = Number(danmu.time);
        if (
          Number.isFinite(current) &&
          Number.isFinite(time) &&
          time < current - 5
        ) {
          const ready = danmuku.states.ready;
          const index = ready.indexOf(danmu);
          if (index >= 0) ready.splice(index, 1);
          danmu.$state = 'stop';
          return false;
        }

        // ready 弹幕被拒不会丢失（仍留在 ready 队列），可以放心限流
        if (!takeReadyBudget()) return false;
      } else if (!takeWaitBudget()) {
        // wait 弹幕超出单帧预算：随 ±0.1 秒窗口滑出后不再显示
        return false;
      }
      return typeof raw === 'function' ? raw(danmu, ...rest) : true;
    };
    (wrapped as any)[WRAPPED_FLAG] = true;
    (wrapped as any)[RAW_FLAG] = raw;
    return wrapped;
  };

  if (typeof danmuku.option?.beforeVisible === 'function') {
    danmuku.option.beforeVisible = wrapBeforeVisible(
      danmuku.option.beforeVisible
    );
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFontSize: unknown;
  let draggingFontSize = false;

  const flushPersist = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (pendingFontSize !== undefined) {
      danmuku.option.fontSize = pendingFontSize;
      pendingFontSize = undefined;
    }
    draggingFontSize = false;
    danmuku.art?.emit('artplayerPluginDanmuku:config', danmuku.option);
  };

  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersist, 160);
  };

  const onPointerUp = () => {
    if (pendingFontSize === undefined) return;
    flushPersist();
  };

  // 滑条 onChange 会读 danmuku.fontSize。只返回已生效字号，避免拖动中 pending 被绘制进弹幕。
  // 数字字号不再读 player.clientHeight，以免拖动时强制布局。
  Object.defineProperty(danmuku, 'fontSize', {
    configurable: true,
    enumerable: false,
    get() {
      const raw = danmuku.option?.fontSize;
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return Math.round(Math.min(120, Math.max(12, raw)));
      }
      return originalFontSizeGet ? originalFontSizeGet.call(danmuku) : 25;
    },
  });

  danmuku.config = function patchedConfig(option: any, isInit = false) {
    if (!option || typeof option !== 'object') {
      return originalConfig(option, isInit);
    }

    if (typeof option.beforeVisible === 'function') {
      option = {
        ...option,
        beforeVisible: wrapBeforeVisible(option.beforeVisible),
      };
    }

    if (isInit) {
      return originalConfig(option, isInit);
    }

    const hasFontSize = option.fontSize != null;
    const hasOpacity = typeof option.opacity === 'number';
    if (!hasFontSize && !hasOpacity) {
      return originalConfig(option, isInit);
    }

    const { fontSize, opacity, ...rest } = option;
    const hasRest = Object.keys(rest).length > 0;
    const result = hasRest ? originalConfig(rest, isInit) : danmuku;

    if (hasOpacity) {
      danmuku.option.opacity = Math.min(1, Math.max(0, opacity));
      schedulePersist();
    }

    if (hasFontSize) {
      pendingFontSize = fontSize;
      draggingFontSize = true;
    }

    return result;
  };

  danmuku.postMessage = function patchedPostMessage(message: any = {}) {
    if (message?.type === 'getDanmuTop' && message.target) {
      // 拖动字号时把轨道计算交回 Worker，避免和指针事件抢主线程
      if (draggingFontSize) {
        return originalPostMessage(message);
      }

      const top = computeDanmuTop(message);
      const id = message.id ?? Date.now();

      // 密度节流：没有配额时返回 undefined，官方会把弹幕放回 ready 队列，
      // 下一帧继续重试，因此不会像 beforeVisible 拒绝那样被时间窗口丢掉
      // 用当前字号换算的稳定行高统计轨道，避免个别弹幕 clientHeight 抖动
      // 导致轨道数/时间槽长度反复变化，放行速率突增
      const laneHeight = Math.max(1, (Number(danmuku.fontSize) || 25) * 1.125);
      if (
        top === undefined ||
        !densityThrottle(countDanmuLanes(message, laneHeight))
      ) {
        return Promise.resolve({ id, result: undefined });
      }

      return Promise.resolve({ id, result: top });
    }
    return originalPostMessage(message);
  };

  // Setting 会在当前同步栈里注册 document:pointerup；推迟到其后，才能在滑条最后一次 onChange 之后应用字号
  queueMicrotask(() => {
    danmuku.art?.on('document:pointerup', onPointerUp);
    danmuku.art?.on('document:pointercancel', onPointerUp);
  });
}

/**
 * 包装官方弹幕插件：在 Danmuku 实例 bind 方法时立刻改写 config / postMessage，
 * 才能拦住设置面板滑条里的 fontSize / opacity。
 */
export function wrapArtplayerPluginDanmuku(factory: any) {
  if (typeof factory !== 'function') return factory;

  const wrapped = (option: any) => (art: any) => {
    // 官方构造函数会立即 load() 一次。初始 danmuku 为空字符串时会请求
    // 空地址（必然失败并产生 unhandled rejection），用空数组跳过首次请求
    const safeOption =
      option && typeof option === 'object'
        ? { ...option, danmuku: option.danmuku || [] }
        : option;

    const originalBind = Function.prototype.bind;
    Function.prototype.bind = function patchedBind(
      this: Function,
      thisArg: any,
      ...boundArgs: any[]
    ) {
      if (isDanmukuInstance(thisArg)) {
        patchDanmukuConfig(thisArg);
      }
      return originalBind.apply(this, [thisArg, ...boundArgs] as [
        any,
        ...any[]
      ]);
    };

    try {
      return factory(safeOption)(art);
    } finally {
      Function.prototype.bind = originalBind;
    }
  };

  wrapped.icons = factory.icons;
  return wrapped;
}
