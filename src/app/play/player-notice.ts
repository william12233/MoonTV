/**
 * 播放器右上角的堆叠式文字提示：新提示在最上方，到期逐条移除。
 * 数量超过上限时进入待显示队列，腾出槽位后按入队顺序补位展示。
 * 位置与样式见 globals.css 的 `.moontv-notice-stack`。
 */

const STACK_CLASS = 'moontv-notice-stack';
const ITEM_CLASS = 'moontv-notice-item';

/** 同时最多展示的提示条数，避免遮挡画面 */
const MAX_VISIBLE_ITEMS = 4;

/** 待显示队列长度上限，超出时丢弃最早的排队项，避免长时间播放时无限堆积 */
const MAX_QUEUED_ITEMS = 20;

/** 默认停留时间（毫秒） */
export const PLAYER_NOTICE_DEFAULT_DURATION_MS = 4000;

/** 只需要播放器模板与内置 notice：结构化类型，兼容 Artplayer 与测试 mock */
export interface PlayerNoticeTarget {
  template?: { $player?: unknown };
  notice?: { show?: string };
}

export interface PlayerNoticeOptions {
  /** 去重键：同键只更新文字并重新计时，不新增条目 */
  key?: string;
  /** 停留毫秒数；`<= 0` 表示常驻 */
  durationMs?: number;
}

type NoticeItem = HTMLElement & { noticeTimer?: number };

/** 尚未上屏的提示 */
interface QueuedNotice {
  message: string;
  key?: string;
  durationMs: number;
}

/** 每个播放器（提示栈）一条独立队列；栈元素被销毁后由 WeakMap 自动回收 */
const pendingQueues = new WeakMap<HTMLElement, QueuedNotice[]>();

function getPlayerElement(
  art: PlayerNoticeTarget | null | undefined
): HTMLElement | null {
  const player = art?.template?.$player;
  return player instanceof HTMLElement ? player : null;
}

function getStack(
  art: PlayerNoticeTarget | null | undefined,
  create: boolean
): HTMLElement | null {
  const player = getPlayerElement(art);
  if (!player) return null;

  const existing = player.querySelector<HTMLElement>(`.${STACK_CLASS}`);
  if (existing || !create) return existing;

  const stack = document.createElement('div');
  stack.className = STACK_CLASS;
  player.appendChild(stack);
  return stack;
}

function getQueue(stack: HTMLElement): QueuedNotice[] {
  let queue = pendingQueues.get(stack);
  if (!queue) {
    queue = [];
    pendingQueues.set(stack, queue);
  }
  return queue;
}

function clearTimer(item: NoticeItem): void {
  if (item.noticeTimer !== undefined) {
    window.clearTimeout(item.noticeTimer);
    item.noticeTimer = undefined;
  }
}

/** 仅从 DOM 摘除条目，不触发补位（清空类操作使用） */
function detachItem(item: NoticeItem): void {
  clearTimer(item);
  item.remove();
}

/** 把一条提示渲染到栈末尾并开始计时 */
function renderItem(stack: HTMLElement, notice: QueuedNotice): void {
  const item = document.createElement('div') as NoticeItem;
  item.className = ITEM_CLASS;
  if (notice.key) item.dataset.noticeKey = notice.key;
  item.textContent = notice.message;
  stack.appendChild(item);
  scheduleRemoval(item, stack, notice.durationMs);
}

/** 栈内腾出空位后，按入队顺序补足到上限 */
function drainQueue(stack: HTMLElement): void {
  const queue = pendingQueues.get(stack);
  if (!queue || queue.length === 0) return;

  while (stack.children.length < MAX_VISIBLE_ITEMS && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    renderItem(stack, next);
  }
}

function removeItem(item: NoticeItem, stack: HTMLElement): void {
  detachItem(item);
  drainQueue(stack);
}

function scheduleRemoval(
  item: NoticeItem,
  stack: HTMLElement,
  durationMs: number
): void {
  clearTimer(item);
  if (!(durationMs > 0)) return;
  item.noticeTimer = window.setTimeout(
    () => removeItem(item, stack),
    durationMs
  );
}

/** 追加一条提示；模板未就绪时退回内置 notice */
export function pushPlayerNotice(
  art: PlayerNoticeTarget | null | undefined,
  text: string,
  options: PlayerNoticeOptions = {}
): void {
  const message = (text || '').trim();
  if (!message) return;

  const stack = getStack(art, true);
  if (!stack) {
    try {
      if (art?.notice) art.notice.show = message;
    } catch {
      // ArtPlayer 可能已销毁
    }
    return;
  }

  const { key, durationMs = PLAYER_NOTICE_DEFAULT_DURATION_MS } = options;
  const queue = getQueue(stack);

  if (key) {
    // 已上屏：只更新文字并续期，位置不变
    const shown = Array.from(stack.children).find(
      (child) => (child as HTMLElement).dataset.noticeKey === key
    ) as NoticeItem | undefined;
    if (shown) {
      shown.textContent = message;
      scheduleRemoval(shown, stack, durationMs);
      return;
    }

    // 已在队列中等待：同样只更新，不重复排队
    const queued = queue.find((notice) => notice.key === key);
    if (queued) {
      queued.message = message;
      queued.durationMs = durationMs;
      return;
    }
  }

  const notice: QueuedNotice = { message, key, durationMs };

  if (stack.children.length < MAX_VISIBLE_ITEMS) {
    renderItem(stack, notice);
    return;
  }

  queue.push(notice);
  while (queue.length > MAX_QUEUED_ITEMS) {
    queue.shift();
  }
}

/** 不传 key 清空全部（含排队项）；传 key 只移除同类提示 */
export function clearPlayerNotices(
  art: PlayerNoticeTarget | null | undefined,
  key?: string
): void {
  const stack = getStack(art, false);
  if (!stack) return;

  const queue = pendingQueues.get(stack);

  // 先处理队列，避免移除条目时触发补位把待清空的提示又放回栈里
  if (queue) {
    if (key === undefined) {
      queue.length = 0;
    } else {
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index].key === key) queue.splice(index, 1);
      }
    }
  }

  Array.from(stack.children).forEach((child) => {
    const item = child as NoticeItem;
    if (key === undefined || item.dataset.noticeKey === key) {
      detachItem(item);
    }
  });

  // 全部清空是"重置"语义，不补位；按键清除后空位应交还给排队提示
  if (key !== undefined) drainQueue(stack);
}
