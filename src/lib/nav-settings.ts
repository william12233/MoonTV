/**
 * 导航栏本地设置。
 *
 * 目前仅有「自动隐藏导航栏」一项：开启后导航栏默认收起，
 * 指针移到对应屏幕边缘（桌面为顶部、移动端为底部）时再自动弹出，
 * 效果类似操作系统任务栏的自动隐藏。
 */

/** localStorage 中保存自动隐藏开关的键名 */
export const NAV_AUTO_HIDE_STORAGE_KEY = 'autoHideNav';

/** 设置变更时派发的自定义事件名（同一标签页内即时生效） */
export const NAV_SETTINGS_UPDATED_EVENT = 'navSettingsUpdated';

export interface NavSettings {
  /** 是否启用导航栏自动隐藏 */
  autoHideNav: boolean;
}

const DEFAULT_NAV_SETTINGS: NavSettings = {
  autoHideNav: false,
};

/** 读取导航栏设置（SSR 或存储不可用时返回默认值） */
export function loadNavSettings(): NavSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_NAV_SETTINGS };

  try {
    return {
      autoHideNav:
        window.localStorage.getItem(NAV_AUTO_HIDE_STORAGE_KEY) === 'true',
    };
  } catch {
    return { ...DEFAULT_NAV_SETTINGS };
  }
}

/**
 * 保存导航栏设置，并通知同一标签页内的导航栏组件立即响应。
 * @param patch 需要更新的字段
 * @returns 合并后的完整设置
 */
export function saveNavSettings(patch: Partial<NavSettings>): NavSettings {
  const next = { ...loadNavSettings(), ...patch };

  if (typeof window === 'undefined') return next;

  try {
    window.localStorage.setItem(
      NAV_AUTO_HIDE_STORAGE_KEY,
      String(next.autoHideNav)
    );
  } catch {
    // 隐私模式等场景写入失败时，本次会话内仍然保持内存状态生效
  }

  window.dispatchEvent(new Event(NAV_SETTINGS_UPDATED_EVENT));
  return next;
}
