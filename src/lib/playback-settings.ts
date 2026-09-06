/**
 * 播放进度自动保存间隔（秒）相关默认值与建议范围。
 *
 * 原始实现按存储类型硬编码：Upstash 20 秒（按量计费，拉长间隔以降低写入），
 * 其余存储 5 秒。此处统一提供默认值与取值范围，供服务端配置创建、
 * layout 运行时注入、播放引擎兜底以及管理面板默认展示共用。
 */

/** 非 Upstash 存储的默认保存间隔（秒） */
export const PLAYBACK_SAVE_DEFAULT_SECONDS = 5;
/** Upstash 存储的默认保存间隔（秒） */
export const PLAYBACK_SAVE_UPSTASH_SECONDS = 20;

/** 建议范围下限（秒） */
export const PLAYBACK_SAVE_RECOMMEND_MIN = 5;
/** 建议范围上限（秒） */
export const PLAYBACK_SAVE_RECOMMEND_MAX = 60;

/** 服务端允许的最小值（秒） */
export const PLAYBACK_SAVE_ALLOWED_MIN = 1;
/** 服务端允许的最大值（秒） */
export const PLAYBACK_SAVE_ALLOWED_MAX = 3600;

/**
 * 根据存储类型返回播放进度保存间隔的默认值（秒）。
 * @param storageType 存储类型，如 'upstash' / 'redis' / 'd1' / 'localstorage'
 */
export function getDefaultPlaybackSaveInterval(
  storageType?: string | null
): number {
  return storageType === 'upstash'
    ? PLAYBACK_SAVE_UPSTASH_SECONDS
    : PLAYBACK_SAVE_DEFAULT_SECONDS;
}
