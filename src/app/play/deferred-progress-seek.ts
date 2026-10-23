import type Artplayer from 'artplayer';

import type {
  LongPressHandlers,
  VerticalSwipeHandlers,
} from './mobile-gestures';

export const PROGRESS_PREVIEW_MOVE = 'moontv-progress-preview-move';
export const PROGRESS_PREVIEW_END = 'moontv-progress-preview-end';

export interface ProgressPreviewMove {
  ratio: number;
  input: 'mouse' | 'touch';
}

export interface DeferredProgressSeekOptions {
  /** 全屏下垂直滑动：左半屏亮度、右半屏音量 */
  vertical?: VerticalSwipeHandlers;
  /** 长按倍速播放 */
  longPress?: LongPressHandlers;
  /** 长按判定时长（毫秒） */
  longPressDelayMs?: number;
}

/** 默认长按判定时长 */
const DEFAULT_LONG_PRESS_DELAY_MS = 500;

/**
 * 拖动落地之后的「用户意图保护」窗口（毫秒）。
 *
 * hls.js 在换档（ABR 自动降码率 / 手动切画质）时会 flush 前向缓冲；如果此时
 * 正好有一次 seek 在等数据，浏览器会把播放位置退回最后一个可播位置——表现
 * 就是进度条自己跳回拖动之前的位置，而且之后每次拖动都被打回。这里记住用户
 * 选定的落点，在窗口内发现位置被打回就重新申明一次。
 */
const SEEK_GUARD_WINDOW_MS = 8_000;

/** 最多重新申明多少次；超过就认输，避免与播放器无限互抢 currentTime */
const SEEK_GUARD_MAX_RETRY = 4;

/** 判定「已落到目标位置」的容差（秒） */
const SEEK_GUARD_TOLERANCE = 1;

/** Keep playback running while scrubbing; commit the selected time on release. */
export function bindDeferredProgressSeek(
  art: Artplayer,
  options: DeferredProgressSeekOptions = {}
): () => void {
  const progress = art.template.$progress;
  const player = art.template.$player;
  const video = art.template.$video;
  const doc = progress.ownerDocument;
  const win = doc.defaultView;
  const Art = art.constructor as typeof Artplayer;
  let drag: 'mouse' | 'touch' | 'gesture' | null = null;
  let touchId: number | null = null;
  let ratio = 0;
  let restoringBar = false;
  let systemGesture = false;
  let suppressVideoClickUntil = 0;
  /** 最近一次用户拖动选定的落点与保护截止时间 */
  let committedSeek: {
    target: number;
    deadline: number;
    retries: number;
  } | null = null;
  /** 落地时时长还不可用：记住进度比例，等时长恢复后补做 */
  let pendingRatio: number | null = null;
  let pendingDeadline = 0;
  let gesture: {
    id: number;
    x: number;
    y: number;
    left: number;
    time: number;
    duration: number;
    size: number;
    width: number;
    height: number;
    rotated: boolean;
    verticalAllowed: boolean;
    side: 'left' | 'right' | null;
    direction: 'pending' | 'seek' | 'vertical' | 'ignore';
  } | null = null;
  let longPressTimer: number | null = null;
  let longPressActive = false;

  const updateBar = (event?: Event) => {
    art.emit('setBar', 'played', ratio, event);
    if (drag) {
      progress.dispatchEvent(
        new CustomEvent<ProgressPreviewMove>(PROGRESS_PREVIEW_MOVE, {
          detail: { ratio, input: drag === 'mouse' ? 'mouse' : 'touch' },
        })
      );
    }
  };

  const updatePosition = (clientX: number, clientY: number, event?: Event) => {
    const rect = progress.getBoundingClientRect();
    const size = art.isRotate ? rect.height : rect.width;
    if (size <= 0) return;
    const offset = art.isRotate ? clientY - rect.top : clientX - rect.left;
    ratio = Math.min(1, Math.max(0, offset / size));
    updateBar(event);
  };

  /** 把当前 ratio 落地成真实 seek；时长不可用时返回 false（不改变播放位置） */
  const commitSeek = (): boolean => {
    const duration = art.duration;
    if (!Number.isFinite(duration) || duration <= 0) return false;
    const target = Math.min(1, Math.max(0, ratio)) * duration;
    try {
      art.seek = target;
    } catch {
      return false;
    }
    committedSeek = {
      target,
      deadline: Date.now() + SEEK_GUARD_WINDOW_MS,
      retries: 0,
    };
    pendingRatio = null;
    return true;
  };

  /**
   * 校验上次拖动是否真的落地。
   *
   * 只要播放位置仍明显落后于用户选定的落点，就说明这次 seek 被 hls.js 的
   * 缓冲 flush（换档/自动降档）或浏览器自身的回退吃掉了，重新申明一次。
   * 只会「向前纠正」，因此不会干扰用户主动向后拖动。
   */
  const verifyCommittedSeek = () => {
    const pending = committedSeek;
    if (!pending) return;
    if (Date.now() > pending.deadline) {
      committedSeek = null;
      return;
    }
    // 拖动 / seek / 重新缓冲仍在进行：等它自己出结果
    if (drag || video.seeking || video.readyState === 0) return;
    // 已经落在目标位置（或更后面）：本次拖动生效
    if (video.currentTime >= pending.target - SEEK_GUARD_TOLERANCE) {
      committedSeek = null;
      return;
    }
    if (pending.retries >= SEEK_GUARD_MAX_RETRY) {
      committedSeek = null;
      return;
    }
    pending.retries += 1;
    try {
      video.currentTime = pending.target;
    } catch {
      committedSeek = null;
    }
  };

  /** 时长恢复可用后，补做那次因 duration 失效而没落地的拖动 */
  const applyPendingSeek = () => {
    if (pendingRatio === null) return;
    if (Date.now() > pendingDeadline) {
      pendingRatio = null;
      return;
    }
    ratio = pendingRatio;
    commitSeek();
  };

  const clearLongPressTimer = () => {
    if (longPressTimer === null) return;
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  };

  /** 结束长按倍速；没有处于倍速时无副作用 */
  const endLongPress = () => {
    clearLongPressTimer();
    if (!longPressActive) return;
    longPressActive = false;
    options.longPress?.end();
  };

  /** 手指保持不动达到阈值后进入倍速 */
  const scheduleLongPress = () => {
    clearLongPressTimer();
    if (!options.longPress) return;
    longPressTimer = window.setTimeout(() => {
      longPressTimer = null;
      // 已开始拖动 / 已锁定 / 手势已结束时不再进入倍速
      if (!gesture || drag || art.isLock) return;
      longPressActive = options.longPress?.start() ?? false;
    }, options.longPressDelayMs ?? DEFAULT_LONG_PRESS_DELAY_MS);
  };

  const finish = (commit: boolean, keepControls = true) => {
    const wasLongPress = longPressActive;
    endLongPress();
    // 长按结束后浏览器仍可能补发 click，不能让它再切换播放/暂停
    if (wasLongPress) suppressVideoClickUntil = Date.now() + 500;
    const ended = gesture;
    gesture = null;
    if (!drag) return;
    const gestureDrag = drag === 'gesture';
    if (gestureDrag) suppressVideoClickUntil = Date.now() + 500;
    drag = null;
    touchId = null;

    const verticalGesture = gestureDrag && ended?.direction === 'vertical';
    // 竖滑只调音量/亮度，不主动唤出底部控制栏（进度条）
    if (!verticalGesture && keepControls && !art.isLock) {
      // The show setter also restarts Artplayer's normal auto-hide countdown.
      art.controls.show = true;
    }
    if (verticalGesture) {
      // 垂直手势只调节音量 / 亮度，不能沿用进度比例去 seek
      options.vertical?.end(!commit);
    } else if (commit && !commitSeek()) {
      // 时长暂时不可用（hls.js flush 缓冲时 MediaSource 时长可能短暂失效）：
      // 记住目标进度等时长恢复后补做，而不是把进度条打回拖动前的位置
      pendingRatio = ratio;
      pendingDeadline = Date.now() + SEEK_GUARD_WINDOW_MS;
      art.emit('setBar', 'played', art.played);
    } else if (!commit) {
      art.emit('setBar', 'played', art.played);
    }

    progress.dispatchEvent(new CustomEvent(PROGRESS_PREVIEW_END));
  };

  const onGestureStart = (event: TouchEvent) => {
    suppressVideoClickUntil = 0;
    if (gesture && event.touches.length !== 1) {
      onCancel(event);
      return;
    }
    if (
      !art.option.gesture ||
      art.isLock ||
      drag ||
      event.touches.length !== 1
    ) {
      return;
    }
    const duration = art.duration;
    const rect = player.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const size = art.isRotate ? height : width;
    const hasDuration = Number.isFinite(duration) && duration > 0;
    // 画面内竖滑在非全屏时可能是想滚动页面，只有全屏才接管音量 / 亮度
    const verticalAllowed =
      !!options.vertical &&
      !art.isRotate &&
      (art.fullscreen === true || art.fullscreenWeb === true);
    // 长按倍速不依赖时长，直播 / 非全屏也可以使用
    const longPressAllowed = !!options.longPress;
    if ((!hasDuration && !verticalAllowed && !longPressAllowed) || size <= 0)
      return;
    if (width <= 0 || height <= 0) return;
    const touch = event.touches[0];
    gesture = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      left: rect.left,
      // 直播没有可 seek 的时长，垂直手势仍然可用
      time: hasDuration ? art.currentTime : 0,
      duration,
      size,
      width,
      height,
      rotated: art.isRotate,
      verticalAllowed,
      side: null,
      direction: 'pending',
    };
    scheduleLongPress();
  };
  const updateGesture = (touch: Touch, event: Event) => {
    if (!gesture || gesture.direction === 'ignore') return;
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    const offset = gesture.rotated ? dy : dx;
    const crossOffset = gesture.rotated ? dx : dy;
    if (gesture.direction === 'pending') {
      if (Math.max(Math.abs(offset), Math.abs(crossOffset)) < 10) return;
      if (longPressActive) {
        // 已经进入长按倍速：手指移动不影响倍速，松手时才恢复
        return;
      }
      // 尚未触发长按时的滑动不进入倍速，取消待执行的判定
      clearLongPressTimer();
      // Lock the axis once. 轴向不明确时继续等待，避免竖滑调音量时
      // 被手指的横向抖动误判成拖动进度、让进度条跳一下。
      const primary = Math.abs(offset);
      const cross = Math.abs(crossOffset);
      const seekDominant = primary > cross * 1.5;
      const verticalDominant = cross > primary * 1.5;
      if (!seekDominant && !verticalDominant) return;

      if (seekDominant) {
        if (!Number.isFinite(gesture.duration) || gesture.duration <= 0) {
          gesture.direction = 'ignore';
          return;
        }
        gesture.direction = 'seek';
        drag = 'gesture';
        art.controls.show = true;
      } else if (gesture.verticalAllowed) {
        gesture.direction = 'vertical';
        gesture.side =
          touch.clientX - gesture.left < gesture.width / 2 ? 'left' : 'right';
        drag = 'gesture';
        const accepted = options.vertical?.start(gesture.side) ?? false;
        if (!accepted) {
          gesture.direction = 'ignore';
          gesture.side = null;
          drag = null;
        }
        return;
      } else if (primary >= cross) {
        // 非全屏没有音量/亮度手势时，保留原本的横向 seek 行为
        if (!Number.isFinite(gesture.duration) || gesture.duration <= 0) {
          gesture.direction = 'ignore';
          return;
        }
        gesture.direction = 'seek';
        drag = 'gesture';
        art.controls.show = true;
      } else {
        gesture.direction = 'ignore';
        return;
      }
    }
    if (gesture.direction === 'vertical') {
      // 向上为正：手指向上滑增大音量 / 亮度
      const delta = -(touch.clientY - gesture.y) / gesture.height;
      options.vertical?.move(delta);
      return;
    }
    ratio = Math.min(
      1,
      Math.max(
        0,
        gesture.time / gesture.duration +
          (offset / gesture.size) * Art.TOUCH_MOVE_RATIO
      )
    );
    updateBar(event);
  };
  const onVideoClick = (event: MouseEvent) => {
    if (Date.now() >= suppressVideoClickUntil) return;
    suppressVideoClickUntil = 0;
    // A synthetic click after swiping must not toggle playback.
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || art.isLock || drag) return;
    // Capture before Artplayer starts its continuous-seek drag handler.
    event.stopImmediatePropagation();
    event.preventDefault();
    drag = 'mouse';
    art.controls.show = true;
    updatePosition(event.clientX, event.clientY, event);
  };
  const onMouseMove = (event: MouseEvent) => {
    if (drag !== 'mouse') return;
    event.stopImmediatePropagation();
    updatePosition(event.clientX, event.clientY, event);
  };
  const onMouseUp = (event: MouseEvent) => {
    if (drag !== 'mouse' || event.button !== 0) return;
    event.stopImmediatePropagation();
    updatePosition(event.clientX, event.clientY, event);
    finish(true);
  };
  const onPlayerContextMenu = (event: Event) => {
    // 长按手势进行中（或刚结束）禁止浏览器/播放器弹出右键菜单：
    // Android Chrome 会在这里弹出「复制视频帧 / 画中画」等原生长按菜单。
    if (!gesture && !longPressActive && Date.now() >= suppressVideoClickUntil) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onPlayerTouchStart = (event: TouchEvent) => {
    if (!art.fullscreen && !art.fullscreenWeb && !art.isRotate) return;
    const viewportTop = win?.visualViewport?.offsetTop || 0;
    // Use screen coordinates, not the rotated player's progress axis.
    if (
      !systemGesture &&
      !Array.from(event.touches).some(
        (touch) => touch.clientY <= viewportTop + 40
      )
    ) {
      return;
    }
    systemGesture = true;
    finish(false);
    // Clear Artplayer's previous gesture, including interrupted touch sequences.
    art.emit('document:touchend', event);
    // Do not preventDefault: the OS must still receive notification gestures.
    event.stopImmediatePropagation();
  };
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1 || art.isLock || drag) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const touch = event.touches[0];
    touchId = touch.identifier;
    drag = 'touch';
    art.controls.show = true;
    updatePosition(touch.clientX, touch.clientY, event);
  };
  const onTouchMove = (event: TouchEvent) => {
    if (systemGesture) {
      event.stopImmediatePropagation();
      return;
    }
    if (gesture) {
      // Stop the built-in continuous seek, but still cancel long-press speedup.
      event.stopImmediatePropagation();
      art.emit('document:touchmove', event);
      if (
        event.touches.length !== 1 ||
        art.isLock ||
        art.isRotate !== gesture.rotated
      ) {
        onCancel(event);
        return;
      }
      const touch = Array.from(event.touches).find(
        (item) => item.identifier === gesture?.id
      );
      if (touch) updateGesture(touch, event);
      if (drag === 'gesture' || longPressActive) event.preventDefault();
      return;
    }
    if (drag !== 'touch') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (event.touches.length !== 1) {
      finish(false);
      return;
    }
    const touch = Array.from(event.touches).find(
      (item) => item.identifier === touchId
    );
    if (touch) updatePosition(touch.clientX, touch.clientY, event);
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (systemGesture) {
      if (event.touches.length === 0) systemGesture = false;
      return;
    }
    if (gesture) {
      const touch = Array.from(event.changedTouches).find(
        (item) => item.identifier === gesture?.id
      );
      if (!touch) return;
      if (drag === 'gesture') {
        event.stopImmediatePropagation();
        updateGesture(touch, event);
        finish(!art.isLock && art.isRotate === gesture.rotated);
        art.emit('document:touchend', event);
      } else {
        // 长按倍速期间没有发生拖动，松手时恢复原速并吞掉随后的 click
        finish(false);
      }
      return;
    }
    if (drag !== 'touch') return;
    const touch = Array.from(event.changedTouches).find(
      (item) => item.identifier === touchId
    );
    if (!touch) return;
    event.stopImmediatePropagation();
    updatePosition(touch.clientX, touch.clientY, event);
    finish(true);
  };
  const onCancel = (event?: Event) => {
    systemGesture = false;
    finish(false);
    art.emit('document:touchend', event || new Event('touchcancel'));
  };
  const onVisibilityChange = () => {
    if (doc.hidden) onCancel();
  };
  const onClick = (event: MouseEvent) => {
    // A release already committed the seek; do not seek again on its click.
    event.stopImmediatePropagation();
    if (event.detail === 0 && !art.isLock) {
      updatePosition(event.clientX, event.clientY, event);
      art.seek = ratio * art.duration;
    }
  };
  const onSetBar = (type: string) => {
    if (type !== 'played' || !drag || restoringBar) return;
    // 竖滑只调音量/亮度、长按只改倍速，不能让播放进度条跟随旧比例跳变
    if (drag === 'gesture' && gesture?.direction !== 'seek') return;
    // RAF/timeupdate still advance normally, but the thumb follows the drag.
    restoringBar = true;
    art.emit('setBar', 'played', ratio);
    restoringBar = false;
  };
  const onControl = (visible: boolean) => {
    // Auto-hide is driven by video:timeupdate even when a finger holds still.
    if (!visible && drag && !art.isLock) art.controls.show = true;
  };

  player.addEventListener('contextmenu', onPlayerContextMenu, true);
  player.addEventListener('touchstart', onPlayerTouchStart, {
    capture: true,
    passive: true,
  });
  video.addEventListener('touchstart', onGestureStart, {
    capture: true,
    passive: true,
  });
  video.addEventListener('click', onVideoClick, true);
  video.addEventListener('seeked', verifyCommittedSeek);
  video.addEventListener('timeupdate', verifyCommittedSeek);
  video.addEventListener('durationchange', applyPendingSeek);
  video.addEventListener('loadedmetadata', applyPendingSeek);
  progress.addEventListener('mousedown', onMouseDown, true);
  progress.addEventListener('touchstart', onTouchStart, {
    capture: true,
    passive: false,
  });
  progress.addEventListener('click', onClick, true);
  doc.addEventListener('mousemove', onMouseMove, true);
  doc.addEventListener('mouseup', onMouseUp, true);
  doc.addEventListener('touchmove', onTouchMove, {
    capture: true,
    passive: false,
  });
  doc.addEventListener('touchend', onTouchEnd, true);
  doc.addEventListener('touchcancel', onCancel, true);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  win?.addEventListener('blur', onCancel);
  art.on('setBar', onSetBar);
  art.on('control', onControl);

  const cleanup = () => {
    endLongPress();
    finish(false, false);
    committedSeek = null;
    pendingRatio = null;
    player.removeEventListener('contextmenu', onPlayerContextMenu, true);
    player.removeEventListener('touchstart', onPlayerTouchStart, true);
    video.removeEventListener('touchstart', onGestureStart, true);
    video.removeEventListener('click', onVideoClick, true);
    video.removeEventListener('seeked', verifyCommittedSeek);
    video.removeEventListener('timeupdate', verifyCommittedSeek);
    video.removeEventListener('durationchange', applyPendingSeek);
    video.removeEventListener('loadedmetadata', applyPendingSeek);
    progress.removeEventListener('mousedown', onMouseDown, true);
    progress.removeEventListener('touchstart', onTouchStart, true);
    progress.removeEventListener('click', onClick, true);
    doc.removeEventListener('mousemove', onMouseMove, true);
    doc.removeEventListener('mouseup', onMouseUp, true);
    doc.removeEventListener('touchmove', onTouchMove, true);
    doc.removeEventListener('touchend', onTouchEnd, true);
    doc.removeEventListener('touchcancel', onCancel, true);
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    win?.removeEventListener('blur', onCancel);
    art.off('setBar', onSetBar);
    art.off('control', onControl);
    art.off('destroy', cleanup);
  };
  art.on('destroy', cleanup);
  return cleanup;
}
