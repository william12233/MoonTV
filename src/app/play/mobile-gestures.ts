import type Artplayer from 'artplayer';

/**
 * 移动端播放器手势反馈与双击快进/快退。
 *
 * 横向滑动与进度条拖动由 `deferred-progress-seek.ts` 统一接管，这里只提供：
 * - 手势过程中的 HUD（时间 / 音量 / 亮度）与亮度遮罩；
 * - 双击画面左右两侧快退 / 快进；
 * - 供拖动模块调用的音量、亮度回调。
 */

export type VerticalGestureSide = 'left' | 'right';

export type DoubleTapSide = 'backward' | 'forward';

/** 双击前后跳转的秒数 */
export const DOUBLE_TAP_SEEK_SECONDS = 10;

/** 双击左右两侧的判定宽度占比（中间区域保持播放/暂停） */
export const DOUBLE_TAP_SIDE_RATIO = 0.35;

/** 垂直滑动多少屏高对应 100% 音量 / 亮度变化 */
export const VERTICAL_FULL_RANGE_RATIO = 0.72;

/** 亮度下限，避免滑到全黑后无法操作 */
export const MIN_BRIGHTNESS = 0.15;

/** 亮度遮罩的最大不透明度 */
const MAX_DIM_OPACITY = 0.9;

/** 长按进入倍速播放的倍率 */
export const LONG_PRESS_RATE = 2;

/** 长按判定时长（毫秒） */
export const LONG_PRESS_DELAY_MS = 500;

const BRIGHTNESS_STORAGE_KEY = 'moontv:player-brightness';
const HUD_HIDE_DELAY_MS = 500;

/** 全屏下垂直滑动：左半屏亮度、右半屏音量 */
export interface VerticalSwipeHandlers {
  /** 返回 false 表示本次手势不接管 */
  start: (side: VerticalGestureSide) => boolean;
  /** delta > 0 表示向上滑（增大） */
  move: (delta: number) => void;
  end: (cancelled: boolean) => void;
}

/** 长按倍速播放 */
export interface LongPressHandlers {
  /** 返回 false 表示本次不进入倍速（例如暂停状态） */
  start: () => boolean;
  end: () => void;
}

export interface MobileGestureFeedback {
  vertical: VerticalSwipeHandlers;
  longPress: LongPressHandlers;
  destroy: () => void;
}

/** 限制到 0-1 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 以手势起点 x 判断落在左半屏还是右半屏 */
export function resolveVerticalSide(
  clientX: number,
  rect: { left: number; width: number }
): VerticalGestureSide {
  if (!(rect.width > 0)) return 'right';
  return clientX - rect.left < rect.width / 2 ? 'left' : 'right';
}

/**
 * 根据垂直位移换算新值。
 *
 * `delta` 是「向上为正、按播放器高度归一化」的位移。
 */
export function applySwipeDelta(startValue: number, delta: number): number {
  return clamp01(startValue + delta / VERTICAL_FULL_RANGE_RATIO);
}

/** 双击落在哪一侧；中间区域返回 null，交回播放器默认的播放/暂停 */
export function resolveDoubleTapSide(
  clientX: number,
  rect: { left: number; width: number }
): DoubleTapSide | null {
  if (!(rect.width > 0)) return null;
  const ratio = (clientX - rect.left) / rect.width;
  if (ratio <= DOUBLE_TAP_SIDE_RATIO) return 'backward';
  if (ratio >= 1 - DOUBLE_TAP_SIDE_RATIO) return 'forward';
  return null;
}

/** 双击后的目标时间；时长不可用时返回 null */
export function doubleTapSeekTarget(
  currentTime: number,
  duration: number,
  side: DoubleTapSide
): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const delta =
    side === 'forward' ? DOUBLE_TAP_SEEK_SECONDS : -DOUBLE_TAP_SEEK_SECONDS;
  const base = Number.isFinite(currentTime) ? currentTime : 0;
  return Math.min(duration, Math.max(0, base + delta));
}

/** 快进/快退提示用的紧凑时间格式 */
export function formatGestureClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

interface HudElements {
  root: HTMLElement;
  label: HTMLElement;
  track: HTMLElement;
  bar: HTMLElement;
}

interface GestureHud {
  show: (
    kind: 'seek' | 'volume' | 'brightness',
    label: string,
    percent?: number | null,
    autoHideMs?: number
  ) => void;
  hide: (delayMs?: number) => void;
  destroy: () => void;
}

function ensureHud(art: Artplayer): HudElements | null {
  const player = art.template?.$player;
  if (!(player instanceof HTMLElement)) return null;

  const existing = player.querySelector<HTMLElement>('.moontv-gesture-hud');
  if (existing) {
    const label = existing.querySelector<HTMLElement>(
      '.moontv-gesture-hud-text'
    );
    const track = existing.querySelector<HTMLElement>(
      '.moontv-gesture-hud-track'
    );
    const bar = existing.querySelector<HTMLElement>('.moontv-gesture-hud-bar');
    if (label && track && bar) {
      return { root: existing, label, track, bar };
    }
    existing.remove();
  }

  const root = document.createElement('div');
  root.className = 'moontv-gesture-hud';
  root.setAttribute('aria-hidden', 'true');

  const label = document.createElement('div');
  label.className = 'moontv-gesture-hud-text';

  const track = document.createElement('div');
  track.className = 'moontv-gesture-hud-track';
  const bar = document.createElement('div');
  bar.className = 'moontv-gesture-hud-bar';
  track.appendChild(bar);

  root.append(label, track);
  player.appendChild(root);
  return { root, label, track, bar };
}

function createGestureHud(art: Artplayer): GestureHud {
  const elements = ensureHud(art);
  let hideTimer: number | null = null;

  const clearTimer = () => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const hide = (delayMs = 0) => {
    if (!elements) return;
    clearTimer();
    if (delayMs > 0) {
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        elements.root.classList.remove('is-visible');
      }, delayMs);
      return;
    }
    elements.root.classList.remove('is-visible');
  };

  const show: GestureHud['show'] = (
    kind,
    label,
    percent = null,
    autoHideMs = 0
  ) => {
    if (!elements) return;
    clearTimer();
    elements.root.dataset.kind = kind;
    elements.label.textContent = label;
    const hasPercent = typeof percent === 'number' && Number.isFinite(percent);
    elements.track.style.display = hasPercent ? '' : 'none';
    if (hasPercent) {
      elements.bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }
    elements.root.classList.add('is-visible');
    if (autoHideMs > 0) hide(autoHideMs);
  };

  return {
    show,
    hide,
    destroy: () => {
      clearTimer();
      elements?.root.remove();
    },
  };
}

function readStoredBrightness(): number {
  try {
    const raw = window.sessionStorage.getItem(BRIGHTNESS_STORAGE_KEY);
    if (raw === null) return 1;
    const value = Number(raw);
    if (!Number.isFinite(value)) return 1;
    return Math.min(1, Math.max(MIN_BRIGHTNESS, value));
  } catch {
    return 1;
  }
}

function persistBrightness(value: number): void {
  try {
    window.sessionStorage.setItem(BRIGHTNESS_STORAGE_KEY, value.toFixed(2));
  } catch {
    // 隐私模式等场景忽略即可
  }
}

function ensureDimLayer(art: Artplayer): HTMLElement | null {
  const player = art.template?.$player;
  if (!(player instanceof HTMLElement)) return null;

  const existing = player.querySelector<HTMLElement>('.moontv-gesture-dim');
  if (existing) return existing;

  const layer = document.createElement('div');
  layer.className = 'moontv-gesture-dim';
  player.appendChild(layer);
  return layer;
}

function applyBrightness(layer: HTMLElement | null, value: number): void {
  if (!layer) return;
  const opacity = (1 - clamp01(value)) * MAX_DIM_OPACITY;
  layer.style.opacity = opacity.toFixed(3);
}

/** 判断当前是否移动端播放器，避免桌面端双击全屏被手势逻辑抢走 */
export function isMobilePlayer(art: Artplayer): boolean {
  try {
    if (art.template?.$player?.classList?.contains('art-mobile')) return true;
    const utils = (
      art.constructor as unknown as { utils?: { isMobile?: boolean } }
    )?.utils;
    return utils?.isMobile === true;
  } catch {
    return false;
  }
}

/**
 * 绑定移动端手势反馈。
 *
 * 返回的 `vertical` / `longPress` 交给 `bindDeferredProgressSeek`，由同一套
 * touch 状态机驱动，避免两个模块各自 preventDefault 互相打架。
 */
export function bindMobileGestures(art: Artplayer): MobileGestureFeedback {
  const hud = createGestureHud(art);
  const dimLayer = ensureDimLayer(art);

  let activeVertical: VerticalGestureSide | null = null;
  let volumeStart = 0;
  let brightnessStart = 1;
  let brightness = readStoredBrightness();
  applyBrightness(dimLayer, brightness);

  const vertical: VerticalSwipeHandlers = {
    start(side) {
      activeVertical = side;
      if (side === 'left') {
        brightnessStart = brightness;
        hud.show(
          'brightness',
          `亮度 ${Math.round(brightness * 100)}%`,
          brightness * 100
        );
        return true;
      }
      volumeStart = clamp01(Number(art.volume) || 0);
      hud.show(
        'volume',
        `音量 ${Math.round(volumeStart * 100)}%`,
        volumeStart * 100
      );
      return true;
    },
    move(delta) {
      if (activeVertical === 'left') {
        brightness = Math.max(
          MIN_BRIGHTNESS,
          applySwipeDelta(brightnessStart, delta)
        );
        applyBrightness(dimLayer, brightness);
        hud.show(
          'brightness',
          `亮度 ${Math.round(brightness * 100)}%`,
          brightness * 100
        );
        return;
      }
      if (activeVertical === 'right') {
        const next = applySwipeDelta(volumeStart, delta);
        try {
          const media = art.video;
          if (media) {
            media.muted = false;
            // 直接写 video，避免 art.volume 每次触发原生音量 notice
            media.volume = next;
          }
        } catch {
          // 播放器可能正在销毁
        }
        hud.show('volume', `音量 ${Math.round(next * 100)}%`, next * 100);
      }
    },
    end() {
      if (activeVertical === 'left') persistBrightness(brightness);
      if (activeVertical === 'right') {
        try {
          art.storage?.set?.('volume', art.video?.volume ?? 0);
        } catch {
          // 忽略存储失败
        }
      }
      activeVertical = null;
      hud.hide(HUD_HIDE_DELAY_MS);
    },
  };

  let longPressActive = false;
  let longPressPreviousRate = 1;
  const longPress: LongPressHandlers = {
    start() {
      if (longPressActive) return true;
      if (art.isLock || !art.playing) return false;
      const previous = Number(art.playbackRate) || 1;
      if (previous >= LONG_PRESS_RATE) return false;
      try {
        art.playbackRate = LONG_PRESS_RATE;
      } catch {
        return false;
      }
      longPressPreviousRate = previous;
      longPressActive = true;
      // 设置 playbackRate 会触发 Artplayer 原生的「倍速: 2.0x」提示
      return true;
    },
    end() {
      if (!longPressActive) return;
      longPressActive = false;
      try {
        art.playbackRate = longPressPreviousRate;
      } catch {
        // 播放器可能正在销毁
      }
    },
  };

  const onDoubleTap = (event: Event) => {
    if (art.isLock) return;
    if (!isMobilePlayer(art)) return;
    const clientX = (event as MouseEvent).clientX;
    if (!Number.isFinite(clientX)) return;
    const player = art.template?.$player;
    if (!(player instanceof HTMLElement)) return;

    const rect = player.getBoundingClientRect();
    const side = resolveDoubleTapSide(clientX, rect);
    if (!side) return;

    const duration = art.duration;
    const target = doubleTapSeekTarget(art.currentTime, duration, side);
    if (target === null) return;

    try {
      const media = art.video;
      if (media) {
        // 直接写 currentTime，避免再弹一次原生的 seek 提示
        media.currentTime = target;
      } else {
        art.seek = target;
      }
    } catch {
      return;
    }
    const forward = side === 'forward';
    // 快进/快退提示同样显示在顶部，保持和音量/亮度提示一致的简洁样式
    hud.show(
      'seek',
      `${
        forward ? '快进' : '快退'
      } ${DOUBLE_TAP_SEEK_SECONDS} 秒 · ${formatGestureClock(target)}`,
      null,
      900
    );
  };

  art.on('dblclick', onDoubleTap);

  const destroy = () => {
    longPress.end();
    art.off('dblclick', onDoubleTap);
    hud.destroy();
    dimLayer?.remove();
  };
  art.on('destroy', destroy);

  return { vertical, longPress, destroy };
}
