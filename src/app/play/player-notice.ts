/**
 * 播放器右上角的堆叠式文字提示：新提示在最上方，到期逐条移除。
 * 位置与样式见 globals.css 的 `.moontv-notice-stack`。
 */

const STACK_CLASS = 'moontv-notice-stack';
const ITEM_CLASS = 'moontv-notice-item';

/** 同时最多保留的提示条数，超出时丢弃最旧的一条，避免遮挡画面 */
const MAX_VISIBLE_ITEMS = 4;

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

function clearTimer(item: NoticeItem): void {
  if (item.noticeTimer !== undefined) {
    window.clearTimeout(item.noticeTimer);
    item.noticeTimer = undefined;
  }
}

function removeItem(item: NoticeItem): void {
  clearTimer(item);
  item.remove();
}

function scheduleRemoval(item: NoticeItem, durationMs: number): void {
  clearTimer(item);
  if (!(durationMs > 0)) return;
  item.noticeTimer = window.setTimeout(() => removeItem(item), durationMs);
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

  if (key) {
    const existing = Array.from(stack.children).find(
      (child) => (child as HTMLElement).dataset.noticeKey === key
    ) as NoticeItem | undefined;
    if (existing) {
      existing.textContent = message;
      scheduleRemoval(existing, durationMs);
      return;
    }
  }

  const item = document.createElement('div') as NoticeItem;
  item.className = ITEM_CLASS;
  if (key) item.dataset.noticeKey = key;
  item.textContent = message;
  stack.appendChild(item);

  while (stack.children.length > MAX_VISIBLE_ITEMS) {
    const oldest = stack.firstElementChild as NoticeItem | null;
    if (!oldest) break;
    removeItem(oldest);
  }

  scheduleRemoval(item, durationMs);
}

/** 不传 key 清空全部；传 key 只移除同类提示 */
export function clearPlayerNotices(
  art: PlayerNoticeTarget | null | undefined,
  key?: string
): void {
  const stack = getStack(art, false);
  if (!stack) return;

  Array.from(stack.children).forEach((child) => {
    const item = child as NoticeItem;
    if (key === undefined || item.dataset.noticeKey === key) {
      removeItem(item);
    }
  });
}
