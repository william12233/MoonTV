'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  loadNavSettings,
  NAV_SETTINGS_UPDATED_EVENT,
} from '@/lib/nav-settings';

/** 屏幕边缘触发显示的热区高度（px） */
const EDGE_HOT_ZONE_PX = 24;
/** 指针离开导航后延迟收起的时长（ms） */
const HIDE_DELAY_MS = 320;

export interface NavAutoHideState {
  /** 是否启用了自动隐藏 */
  enabled: boolean;
  /** 当前是否处于收起状态 */
  hidden: boolean;
  /** 需要挂到导航栏根节点上，用于判断指针/焦点是否在导航内 */
  navRef: React.MutableRefObject<HTMLElement | null>;
}

/**
 * 桌面端顶部导航栏自动隐藏（类任务栏效果）。
 *
 * 默认收起；当指针进入屏幕顶部边缘的热区、或悬停/聚焦在导航栏内部时展开，
 * 离开后延迟收起。设置项通过 localStorage 持久化，并监听同页变更事件即时生效。
 * 移动端导航栏不参与自动隐藏，始终常驻显示。
 */
export default function useNavAutoHide(): NavAutoHideState {
  const [enabled, setEnabled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const reveal = useCallback(() => {
    clearHideTimer();
    setHidden(false);
  }, [clearHideTimer]);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      // 导航内仍有焦点（例如正在输入搜索词）时不收起
      const activeElement = document.activeElement;
      if (activeElement && navRef.current?.contains(activeElement)) return;
      setHidden(true);
    }, HIDE_DELAY_MS);
  }, []);

  // 读取设置，并订阅设置变更（同标签页自定义事件 + 跨标签页 storage）
  useEffect(() => {
    const sync = () => {
      const nextEnabled = loadNavSettings().autoHideNav;
      clearHideTimer();
      setEnabled(nextEnabled);
      setHidden(nextEnabled);
    };

    sync();
    window.addEventListener(NAV_SETTINGS_UPDATED_EVENT, sync);
    window.addEventListener('storage', sync);

    return () => {
      window.removeEventListener(NAV_SETTINGS_UPDATED_EVENT, sync);
      window.removeEventListener('storage', sync);
      clearHideTimer();
    };
  }, [clearHideTimer]);

  // 启用后监听指针 / 触摸 / 焦点，决定展开还是收起
  useEffect(() => {
    if (!enabled) return;

    const isInsideNav = (target: EventTarget | null): boolean =>
      target instanceof Node && !!navRef.current?.contains(target);

    const inHotZone = (clientY: number): boolean => clientY <= EDGE_HOT_ZONE_PX;

    const handlePointerMove = (event: PointerEvent) => {
      // 触摸设备交给 touchstart 处理，避免滑动页面时反复触发
      if (event.pointerType && event.pointerType !== 'mouse') return;
      if (isInsideNav(event.target) || inHotZone(event.clientY)) {
        reveal();
      } else {
        scheduleHide();
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      if (isInsideNav(event.target) || inHotZone(touch.clientY)) {
        reveal();
      } else {
        scheduleHide();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (isInsideNav(event.target)) reveal();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (isInsideNav(event.relatedTarget)) return;
      scheduleHide();
    };

    window.addEventListener('pointermove', handlePointerMove, {
      passive: true,
    });
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('focusin', handleFocusIn);
    window.addEventListener('focusout', handleFocusOut);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
      clearHideTimer();
    };
  }, [enabled, reveal, scheduleHide, clearHideTimer]);

  return { enabled, hidden, navRef };
}
