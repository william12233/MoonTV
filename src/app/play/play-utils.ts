/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

/**
 * 播放页纯函数工具集合。
 *
 * 将不依赖 React 状态/生命周期、可独立测试的纯逻辑从巨型播放页中剥离，
 * 便于后续单元测试与复用。
 */

/** 切集后延迟恢复弹幕可见性的毫秒数 */
export const DANMAKU_VISIBLE_RESTORE_DELAY_MS = 1500;

/** 跳过片头片尾配置结构 */
export interface SkipConfig {
  enable: boolean;
  intro_time: number;
  outro_time: number;
}

/**
 * 将秒数格式化为 00:00 或 00:00:00。
 */
export function formatTime(seconds: number): string {
  if (seconds === 0) return '00:00';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.round(seconds % 60);

  if (hours === 0) {
    // 不到一小时，格式为 00:00
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
      .toString()
      .padStart(2, '0')}`;
  } else {
    // 超过一小时，格式为 00:00:00
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
}

/**
 * 去广告：过滤 M3U8 内容中的 #EXT-X-DISCONTINUITY 标记。
 */
export function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content) return '';

  // 按行分割M3U8内容
  const lines = m3u8Content.split('\n');
  const filteredLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 只过滤#EXT-X-DISCONTINUITY标识
    if (!line.includes('#EXT-X-DISCONTINUITY')) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

/**
 * 计算播放源综合评分（分辨率 40% + 下载速度 40% + 网络延迟 20%）。
 */
export function calculateSourceScore(
  testResult: {
    quality: string;
    loadSpeed: string;
    pingTime: number;
  },
  maxSpeed: number,
  minPing: number,
  maxPing: number
): number {
  let score = 0;

  // 分辨率评分 (40% 权重)
  const qualityScore = (() => {
    switch (testResult.quality) {
      case '4K':
        return 100;
      case '2K':
        return 85;
      case '1080p':
        return 75;
      case '720p':
        return 60;
      case '480p':
        return 40;
      case 'SD':
        return 20;
      default:
        return 0;
    }
  })();
  score += qualityScore * 0.4;

  // 下载速度评分 (40% 权重) - 基于最大速度线性映射
  const speedScore = (() => {
    const speedStr = testResult.loadSpeed;
    if (speedStr === '未知' || speedStr === '测量中...') return 30;

    // 解析速度值
    const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
    if (!match) return 30;

    const value = parseFloat(match[1]);
    const unit = match[2];
    const speedKBps = unit === 'MB/s' ? value * 1024 : value;

    // 基于最大速度线性映射，最高100分
    const speedRatio = speedKBps / maxSpeed;
    return Math.min(100, Math.max(0, speedRatio * 100));
  })();
  score += speedScore * 0.4;

  // 网络延迟评分 (20% 权重) - 基于延迟范围线性映射
  const pingScore = (() => {
    const ping = testResult.pingTime;
    if (ping <= 0) return 0; // 无效延迟给默认分

    // 如果所有延迟都相同，给满分
    if (maxPing === minPing) return 100;

    // 线性映射：最低延迟=100分，最高延迟=0分
    const pingRatio = (maxPing - ping) / (maxPing - minPing);
    return Math.min(100, Math.max(0, pingRatio * 100));
  })();
  score += pingScore * 0.2;

  return Math.round(score * 100) / 100; // 保留两位小数
}

/**
 * 创建弹幕插件的默认配置对象。
 *
 * 每次调用返回全新对象，避免多处共享同一引用导致状态污染。
 */
export function createDanmakuDefaultConfig(): any {
  return {
    danmuku: '',
    speed: 5,
    margin: [10, '25%'],
    opacity: 1,
    color: '#FFFFFF',
    mode: 0,
    modes: [0, 1, 2],
    fontSize: 25,
    antiOverlap: true,
    synchronousPlayback: false,
    mount: undefined,
    heatmap: false,
    width: 512,
    points: [],
    filter: (danmu: any) => danmu.text.length <= 100,
    beforeVisible: () => true,
    visible: true,
    emitter: false,
    maxLength: 200,
    lockTime: 5,
    theme: 'dark',
    OPACITY: {},
    FONT_SIZE: {},
    MARGIN: {},
    SPEED: {},
    COLOR: [],
    beforeEmit(_danmu: any) {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(true);
        }, 1000);
      });
    },
  };
}

/** 弹幕设置本地存储键 */
export const DANMAKU_SETTINGS_STORAGE_KEY = 'danmaku_settings';

/**
 * 可持久化到本地的弹幕设置字段。
 *
 * 仅包含用户可调的展示类设置，不包含 danmuku 地址、mount 等运行时字段。
 */
export interface DanmakuSettings {
  /** 弹幕是否可见 */
  visible: boolean;
  /** 不透明度，范围 [0, 1] */
  opacity: number;
  /** 字号（像素） */
  fontSize: number;
  /** 弹幕速度，范围 [1, 10] */
  speed: number;
  /** 显示区域 [上边距, 下边距] */
  margin: [number | string, number | string];
  /** 发送弹幕的模式：0-滚动，1-顶部，2-底部 */
  mode: number;
  /** 可见的弹幕模式列表 */
  modes: number[];
  /** 是否防止弹幕重叠 */
  antiOverlap: boolean;
  /** 是否同步视频速度 */
  synchronousPlayback: boolean;
  /** 默认弹幕颜色 */
  color: string;
}

/** 将数值限制在 [min, max] 区间内，非法值返回 undefined */
function clampNumber(
  value: unknown,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

/** 校验弹幕上下边距（支持像素数字与百分比字符串） */
function normalizeMargin(
  value: unknown
): [number | string, number | string] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;

  const normalizeEdge = (edge: unknown): number | string | undefined => {
    if (typeof edge === 'number' && Number.isFinite(edge)) return edge;
    if (typeof edge === 'string' && /^\d+(\.\d+)?%$/.test(edge)) return edge;
    return undefined;
  };

  const top = normalizeEdge(value[0]);
  const bottom = normalizeEdge(value[1]);
  if (top === undefined || bottom === undefined) return undefined;

  return [top, bottom];
}

/**
 * 从（可能不完整或不可信的）弹幕配置对象中提取可持久化的设置字段。
 *
 * 同时用于写入前的字段提取与读取后的数据校验，避免脏数据注入播放器配置。
 */
export function pickDanmakuSettings(config: any): Partial<DanmakuSettings> {
  const result: Partial<DanmakuSettings> = {};
  if (!config || typeof config !== 'object') return result;

  if (typeof config.visible === 'boolean') result.visible = config.visible;

  const opacity = clampNumber(config.opacity, 0, 1);
  if (opacity !== undefined) result.opacity = opacity;

  const fontSize = clampNumber(config.fontSize, 12, 120);
  if (fontSize !== undefined) result.fontSize = fontSize;

  const speed = clampNumber(config.speed, 1, 10);
  if (speed !== undefined) result.speed = speed;

  const margin = normalizeMargin(config.margin);
  if (margin) result.margin = margin;

  const mode = clampNumber(config.mode, 0, 2);
  if (mode !== undefined) result.mode = Math.round(mode);

  if (Array.isArray(config.modes)) {
    const modes = config.modes.filter(
      (m: unknown): m is number =>
        typeof m === 'number' && Number.isFinite(m) && m >= 0 && m <= 2
    );
    result.modes = Array.from(new Set(modes));
  }

  if (typeof config.antiOverlap === 'boolean') {
    result.antiOverlap = config.antiOverlap;
  }

  if (typeof config.synchronousPlayback === 'boolean') {
    result.synchronousPlayback = config.synchronousPlayback;
  }

  if (typeof config.color === 'string' && config.color) {
    result.color = config.color;
  }

  return result;
}

/**
 * 读取本地保存的弹幕设置（含校验），无有效数据时返回空对象。
 */
export function loadDanmakuSettings(): Partial<DanmakuSettings> {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(DANMAKU_SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    return pickDanmakuSettings(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * 将弹幕设置写入本地存储。
 *
 * 默认与已有设置合并，便于只更新部分字段；replace 为 true 时整体覆盖。
 */
export function saveDanmakuSettings(
  settings: Partial<DanmakuSettings>,
  options: { replace?: boolean } = {}
): void {
  if (typeof window === 'undefined') return;

  try {
    const merged = options.replace
      ? settings
      : { ...loadDanmakuSettings(), ...settings };
    window.localStorage.setItem(
      DANMAKU_SETTINGS_STORAGE_KEY,
      JSON.stringify(merged)
    );
  } catch {
    // localStorage 不可用（如隐私模式）时静默失败，不影响播放
  }
}

/**
 * 创建弹幕插件初始配置：默认配置叠加本地已保存的设置，刷新后可自动恢复。
 */
export function createDanmakuInitialConfig(): any {
  return {
    ...createDanmakuDefaultConfig(),
    ...loadDanmakuSettings(),
  };
}

/**
 * 创建"去广告"自定义 HLS Loader。
 *
 * 在 manifest / level 请求成功后，对返回的 M3U8 内容执行广告过滤。
 * 仅在开启去广告功能时替换默认 Loader。
 */
export function createCustomHlsLoader(Hls: any): any {
  return class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (context: any, config: any, callbacks: any) {
        if (
          (context as any).type === 'manifest' ||
          (context as any).type === 'level'
        ) {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = function (
            response: any,
            stats: any,
            context: any
          ) {
            if (response.data && typeof response.data === 'string') {
              response.data = filterAdsFromM3U8(response.data);
            }
            return onSuccess(response, stats, context, null);
          };
        }
        load(context, config, callbacks);
      };
    }
  };
}
