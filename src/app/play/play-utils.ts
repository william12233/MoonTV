/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

/**
 * 播放页纯函数工具集合。
 *
 * 将不依赖 React 状态/生命周期、可独立测试的纯逻辑从巨型播放页中剥离，
 * 便于后续单元测试与复用。
 */

import {
  stripAdSegmentsByMediaProfile,
  stripAdSegmentsFromM3U8,
} from '@/lib/ad-filter';
import {
  type SegmentByteRange,
  normalizeByteRange,
} from '@/lib/video-byte-range';
import {
  buildSegmentCacheKey,
  DEFAULT_CACHE_SETTINGS,
  loadCacheSettings,
  probeSegmentProfileCacheFirst,
  readCachedSegment,
  recordSegmentProbe,
  touchMeta,
} from '@/lib/video-cache';

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
 * 按需剔除播放列表中的广告分片（仅结构特征，同步）。
 *
 * 旧实现只删除 `#EXT-X-DISCONTINUITY` 行：既不删广告分片，又丢掉 PTS
 * 断点信息，时间轴因此出现空洞（拖动报 `bufferSeekOverHole`、画面回推、
 * 音画错位、最终撞 MSE 配额）。现在改为真正删除广告分片条目
 * （见 `@/lib/ad-filter`），所有不连续标记与 KEY/MAP 都保留。
 *
 * @param removeAds 是否启用（设置面板里的「去广告」）；默认关闭
 */
export function filterAdsFromM3U8(
  m3u8Content: string,
  removeAds = false
): string {
  if (!m3u8Content || !removeAds) return m3u8Content;
  return stripAdSegmentsFromM3U8(m3u8Content);
}

/**
 * 按需剔除播放列表中的广告分片（结构特征 + 分片媒体参数，异步）。
 *
 * 采集站的 VIP 线路会把广告重新编码后拼进正片：没有 CUE 标记、分片地址
 * 是同 CDN 的随机哈希、块时长与正文同量级，纯结构规则一条都命不中。
 * 这类广告由 `stripAdSegmentsByMediaProfile()` 读取分片头部的 SPS，
 * 按「与正文画面尺寸不一致」来判定（详见 `@/lib/ad-filter`）。
 *
 * 探测只读每个块首分片的前 4KB，且**先从 Cache Storage 里取**（预取过的分片
 * 零网络请求），结果按 URL 缓存、播放器与预取器共用同一条链路
 * （`probeSegmentProfileCacheFirst`）。任何失败都会退回同步版本，因此这里
 * 永远不会把播放列表改坏。
 *
 * @param baseUrl 播放列表地址，用于解析相对分片地址
 * @param removeAds 是否启用（设置面板里的「去广告」）；默认关闭
 */
export async function filterAdsFromM3U8Async(
  m3u8Content: string,
  baseUrl?: string,
  removeAds = false
): Promise<string> {
  if (!m3u8Content || !removeAds) return m3u8Content;
  try {
    return await stripAdSegmentsByMediaProfile(m3u8Content, {
      baseUrl,
      probe: probeSegmentProfileCacheFirst,
    });
  } catch {
    return stripAdSegmentsFromM3U8(m3u8Content);
  }
}

/** 弹幕密度挡位；默认挡位为 `normal`（标准） */
export type DanmakuDensity = 'sparse' | 'normal' | 'dense';

/** 弹幕密度挡位文案 */
export const DANMAKU_DENSITY_LABELS: Record<DanmakuDensity, string> = {
  sparse: '疏松',
  normal: '标准',
  dense: '密集',
};

/**
 * 各挡位的密度参数。
 *
 * 密度以「每轨每秒放行条数」为基准，实际速率随当前可用轨道数动态变化：
 *
 *   interval = perInterval / (ratePerLane × 当前轨道数)
 *
 * - sparse：每轨 0.2 条/秒（约每轨 5 秒 1 条）；
 * - normal：每轨 0.5 条/秒；
 * - dense：每轨 1 条/秒。
 *
 * 这样手机横屏（轨道少）和桌面全屏（轨道多）的观感一致，也不会在高屏上
 * 浪费轨道。以 15 轨为例：疏松约 3 条/秒、标准约 7.5 条/秒、密集约
 * 15 条/秒，与此前固定参数基本一致。
 *
 * 旧实现是容量 28 的令牌桶：密集时段的前 28 条会被瞬间全部放行，之后长时间
 * 没有弹幕（额度被同一时刻吃光）。这些同时放行的弹幕又会挤在第一条轨道右侧
 * 排队，导致时间和轨道分布都不均匀。改为时间槽采样后，放行量被均匀摊到整条
 * 时间轴上，配合轨道分配即可铺满所有开放轨道。
 */
export const DANMAKU_DENSITY_PRESETS: Record<
  DanmakuDensity,
  { ratePerLane: number; perInterval: number }
> = {
  sparse: { ratePerLane: 0.2, perInterval: 2 },
  normal: { ratePerLane: 0.5, perInterval: 2 },
  dense: { ratePerLane: 1, perInterval: 3 },
};

let activeDanmakuDensity: DanmakuDensity = 'normal';

/** 设置弹幕密度挡位；未设置 / 非法值回落到标准。 */
export function setDanmakuDensity(density: unknown): DanmakuDensity {
  activeDanmakuDensity =
    density === 'sparse' || density === 'dense' ? density : 'normal';
  return activeDanmakuDensity;
}

/** 读取当前弹幕密度挡位。 */
export function getDanmakuDensity(): DanmakuDensity {
  return activeDanmakuDensity;
}

/**
 * 基础过滤：只校验对象与文本长度，不限制单集总量。
 *
 * 运行期只处理当前时间窗口内的弹幕与 ready 队列，队列长度本身不产生额外
 * 渲染开销；密度节流与 ready 预算分别控制上屏速率和每帧 DOM 测量量，因此
 * 不需要在 load 阶段截断队列。
 */
export function createDanmakuFilter() {
  return (danmu: any) => {
    if (!danmu || typeof danmu !== 'object') return false;

    if (typeof danmu.text === 'string' && danmu.text.length > 100) {
      return false;
    }

    return true;
  };
}

/**
 * 密度节流器：按当前挡位限制弹幕上屏速率。
 *
 * 返回 true 表示当前时间槽还有配额，调用方可以让一条弹幕上屏；返回 false
 * 时调用方应把轨道结果置为 undefined，让官方把弹幕放回 ready 队列，下一帧
 * 再试。
 *
 * 为什么不直接在 `beforeVisible` 里丢弃：官方只会处理时间窗口（当前时间
 * ±0.1 秒）内的 wait 弹幕，同一时刻成簇的弹幕一旦在这里被拒就会永久丢失，
 * 实测每秒只能上屏几条。放回 ready 队列后，积压弹幕会按挡位速率陆续上屏，
 * 既不丢弹幕也不会瞬间爆量。
 *
 * 采样按真实时钟（上屏时刻）而不是弹幕自身时间，因此切换挡位后立即生效，
 * 且切回疏松时积压弹幕也只会按新速率慢慢放出。
 */
export function createDanmakuDensityThrottle(
  now: () => number = () => Date.now() / 1000
) {
  let currentSlot = -1;
  let usedInSlot = 0;
  let lastDensity = activeDanmakuDensity;
  let lastInterval = -1;

  return (laneCount = 1): boolean => {
    if (lastDensity !== activeDanmakuDensity) {
      lastDensity = activeDanmakuDensity;
      currentSlot = -1;
      usedInSlot = 0;
    }

    const preset = DANMAKU_DENSITY_PRESETS[activeDanmakuDensity];
    const lanes = Math.max(1, Math.floor(Number(laneCount) || 1));
    // 轨道数变化（全屏、字号调整）时重新计算时间槽长度
    const interval = preset.perInterval / (lanes * preset.ratePerLane);
    if (interval !== lastInterval) {
      lastInterval = interval;
      currentSlot = -1;
      usedInSlot = 0;
    }

    const slot = Math.floor(now() / interval);
    if (slot !== currentSlot) {
      currentSlot = slot;
      usedInSlot = 0;
    }

    if (usedInSlot >= preset.perInterval) return false;

    usedInSlot += 1;
    return true;
  };
}

/**
 * 计算播放源综合评分。
 *
 * 权重：分辨率 60% + 下载速度 30% + 网络延迟 10%。
 *
 * 原则：**画质优先，但慢源降权**——高分辨率源优先；速度作为同档位内的
 * 打破平局（同样 1080p 时选更快的），并把慢到会卡的源明显压低，避免
 * 选到"分辨率高但卡成 PPT"的源。
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

  // 分辨率评分 (60% 权重) —— 画质优先
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
  score += qualityScore * 0.6;

  // 下载速度评分 (30% 权重) —— 达标加分 + 同档打破平局
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
  score += speedScore * 0.3;

  // 网络延迟评分 (10% 权重) - 基于延迟范围线性映射
  const pingScore = (() => {
    const ping = testResult.pingTime;
    if (ping <= 0) return 0; // 无效延迟给默认分

    // 如果所有延迟都相同，给满分
    if (maxPing === minPing) return 100;

    // 线性映射：最低延迟=100分，最高延迟=0分
    const pingRatio = (maxPing - ping) / (maxPing - minPing);
    return Math.min(100, Math.max(0, pingRatio * 100));
  })();
  score += pingScore * 0.1;

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
    filter: createDanmakuFilter(),
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
  /** 弹幕密度挡位（不传给 artplayer，仅用于限流器） */
  density: DanmakuDensity;
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

  if (
    config.density === 'sparse' ||
    config.density === 'normal' ||
    config.density === 'dense'
  ) {
    result.density = config.density;
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
  // density 只用于限流器，不作为 artplayer 插件的配置字段传入
  const { density, ...saved } = loadDanmakuSettings();
  setDanmakuDensity(density);
  return {
    ...createDanmakuDefaultConfig(),
    ...saved,
  };
}

/* ------------------------------------------------------------------ */
/* HLS 内存缓冲预算                                                     */
/* ------------------------------------------------------------------ */

/** 1MB，按 1024 进制，和浏览器 MSE 的统计口径一致 */
const MB = 1024 * 1024;

/**
 * 字节预算的安全系数。
 *
 * 播放列表里的 BANDWIDTH 是平均码率，实际分片（尤其是高动态画面）会短暂
 * 高于它；留 15% 余量，避免"刚好算满"时先撞 SourceBuffer 配额。
 */
const BUFFER_SAFETY = 1.15;

/** 前向缓冲的最小有效时长：再短就不足以抗抖动 */
const MIN_FORWARD_SECONDS = 30;

/** 单个 SourceBuffer 的最小字节预算，避免低码率时算出过小的值 */
const MIN_BUFFER_BYTES = 32 * MB;

/** 设备档位：0 宽裕 / 1 中等 / 2 紧张 */
type DeviceTier = 0 | 1 | 2;

/**
 * 各档设备可安全占用的 MSE 字节预算。
 *
 * 取值参考 Chrome 桌面端与移动端 SourceBuffer 的常见配额，并给视频 + 音频
 * 两个 SourceBuffer 留出余量；超出这个值更容易触发 `bufferFullError`。
 */
const DEVICE_BYTE_BUDGET: Record<DeviceTier, number> = {
  0: 192 * MB,
  1: 128 * MB,
  2: 72 * MB,
};

/** 时长目标：[前向目标, 前向硬上限, 回看时长]（秒） */
const TIME_TARGETS: Record<
  'cacheOff' | 'cacheOn',
  Record<DeviceTier, readonly [number, number, number]>
> = {
  // 未开缓存：内存缓冲就是抗抖动的资本，尽量拉长
  cacheOff: {
    0: [120, 600, 30],
    1: [90, 360, 20],
    2: [60, 180, 15],
  },
  // 已开缓存：Cache Storage 读出来几乎零延迟，内存缓冲只需保证平滑
  cacheOn: {
    0: [60, 300, 20],
    1: [45, 240, 15],
    2: [30, 120, 10],
  },
};

export interface HlsBufferPlan {
  /** 前向缓冲目标（秒） */
  maxBufferLength: number;
  /** 前向缓冲硬上限（秒） */
  maxMaxBufferLength: number;
  /** 已播放内容的保留时长（秒） */
  backBufferLength: number;
  /** MSE 单 SourceBuffer 字节预算（字节） */
  maxBufferSize: number;
  /** 目标时长装不进字节预算，已按字节预算回压时长（排查用） */
  limitedByBytes: boolean;
}

export interface HlsBufferPlanInput {
  /** 当前档位码率（bit/s）。未知时只按设备预算给出时长目标 */
  levelBitrate?: number | null;
  cacheEnabled?: boolean;
  /** navigator.deviceMemory（GB，Chrome 上限 8） */
  deviceMemory?: number;
  hardwareConcurrency?: number;
  /** 移动端 / 平板：MSE 配额通常比桌面紧张 */
  mobile?: boolean;
  saveData?: boolean;
}

function resolveDeviceTier(input: HlsBufferPlanInput): DeviceTier {
  const memory = input.deviceMemory ?? 0;
  const cores = input.hardwareConcurrency ?? 0;
  if (
    input.mobile ||
    (memory > 0 && memory <= 2) ||
    (cores > 0 && cores <= 2)
  ) {
    return 2;
  }
  if ((memory > 0 && memory <= 4) || (cores > 0 && cores <= 4)) return 1;
  return 0;
}

/**
 * 计算 hls.js 的内存缓冲计划。
 *
 * hls.js 里两个阈值是相乘关系：
 *
 *   maxBufLen = min(maxBufferLength, maxBufferSize / 码率)
 *
 * 所以固定 90MB 时，8Mbps 只装得下约 90s——**120s 的目标永远达不成**。
 * 两套阈值互相打架：hls.js 以为自己还能往前装，实际早已顶到字节上限，
 * 配额一紧就抛 `bufferFullError`，再走 flush 全缓冲的分支（画面回退）。
 *
 * 这里改成由「当前档位码率 × 目标时长」反推字节预算：
 * - 装得下：字节预算按需放大（上限为设备预算），120s 真的能达成；
 * - 装不下：字节预算封顶，同时把时长目标回压到能兑现的值，
 *   保证 `maxBufferLength` 与 `maxBufferSize` 始终自洽。
 */
export function planHlsBuffer(input: HlsBufferPlanInput = {}): HlsBufferPlan {
  const tier = resolveDeviceTier(input);
  const [targetForward, targetMax, targetBack] =
    TIME_TARGETS[input.cacheEnabled ? 'cacheOn' : 'cacheOff'][tier];

  let maxBufferLength = targetForward;
  let maxMaxBufferLength = targetMax;
  const backBufferLength = targetBack;
  if (input.saveData) {
    maxBufferLength = Math.min(maxBufferLength, 45);
    maxMaxBufferLength = Math.min(maxMaxBufferLength, 240);
  }

  const byteBudget = DEVICE_BYTE_BUDGET[tier];
  const bitrate = Number(input.levelBitrate);
  if (!Number.isFinite(bitrate) || bitrate <= 0) {
    return {
      maxBufferLength,
      maxMaxBufferLength,
      backBufferLength,
      maxBufferSize: byteBudget,
      limitedByBytes: false,
    };
  }

  const bytesPerSecond = bitrate / 8;
  const desired = Math.ceil(
    (maxBufferLength + backBufferLength) * bytesPerSecond * BUFFER_SAFETY
  );
  if (desired <= byteBudget) {
    return {
      maxBufferLength,
      maxMaxBufferLength,
      backBufferLength,
      // 不再固定 90MB，按码率与目标时长给足（8Mbps × 120s ≈ 172MB）
      maxBufferSize: Math.max(MIN_BUFFER_BYTES, desired),
      limitedByBytes: false,
    };
  }

  // 字节预算装不下目标时长：回压时长，避免留下一个永远达不成的目标
  const affordable = Math.floor(
    byteBudget / BUFFER_SAFETY / bytesPerSecond - backBufferLength
  );
  maxBufferLength = Math.max(
    MIN_FORWARD_SECONDS,
    Math.min(maxBufferLength, affordable)
  );
  maxMaxBufferLength = Math.max(
    maxBufferLength,
    Math.min(maxMaxBufferLength, maxBufferLength * 3)
  );
  return {
    maxBufferLength,
    maxMaxBufferLength,
    backBufferLength,
    maxBufferSize: byteBudget,
    limitedByBytes: true,
  };
}

/** 读取当前设备能力并计算缓冲计划 */
export function planCurrentHlsBuffer(
  input: HlsBufferPlanInput = {}
): HlsBufferPlan {
  if (typeof navigator === 'undefined') return planHlsBuffer(input);
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  return planHlsBuffer({
    ...input,
    deviceMemory: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    saveData: nav.connection?.saveData,
    mobile: /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(
      nav.userAgent || ''
    ),
  });
}

/** 写回 hls 实例；hls.js 每个 tick 都会读 config，运行期修改立即生效 */
export function applyHlsBufferPlan(hls: any, plan: HlsBufferPlan): void {
  const config = hls?.config;
  if (!config) return;
  config.maxBufferLength = plan.maxBufferLength;
  config.maxMaxBufferLength = plan.maxMaxBufferLength;
  config.backBufferLength = plan.backBufferLength;
  config.maxBufferSize = plan.maxBufferSize;
}

export interface HlsLoaderOptions {
  /**
   * 是否从点播播放列表中剔除广告分片（设置面板里的「去广告」）。
   *
   * 只删除广告分片条目，`#EXT-X-DISCONTINUITY` / KEY / MAP 全部保留，
   * 因此不会像旧实现那样制造时间轴空洞。直播列表与无法安全判定的
   * 播放列表会原样返回。
   */
  blockAd?: boolean;
  /** 片段缓存键是否走同源代理，必须与 VideoPrefetcher 保持一致 */
  useProxy?: boolean;
  /** 缓存诊断回调（命中/未命中），用于观测缓存键是否与预取器一致 */
  onProbe?: (hit: boolean) => void;
}

/**
 * 合成 hls.js 的 LoaderStats。
 *
 * 关键点：命中缓存时不能上报"耗时 0"。hls.js 的 ABR 用 EWMA 估算带宽，
 * 0 延迟会被当成无限带宽，导致下一批片段直接判到最高码率而卡顿。
 * 这里复用预取时记录的真实耗时，让带宽估算保持连续。
 *
 * 另一个必须满足的约束：各阶段时间必须自洽且单调。hls.js 在
 * `onFragBuffered` 里这样反推"处理耗时"用于带宽采样：
 *
 *   processingMs = parsing.end - loading.start
 *                  - min(loading.first - loading.start, bwEstimator.getEstimateTTFB())
 *
 * 如果像旧实现那样把 `parsing` / `buffering` 全填 0，这个差值就是
 * `0 - (now - span) - ...` 的负数；`EwmaBandWidthEstimator.sample()` 会把负值
 * 钳到 `minDelayMs`（50ms），等价于**每个命中缓存的分片都被当成 20–300 Mbps
 * 的下载**。ABR 随即判到最高码率，真实带宽跟不上就卡顿，触发本站的弱网降档；
 * 换档会 flush 前向缓冲，播放位置因此被打回，听起来就是"画面突然闪回、
 * 音画不同步"。所以时间线要整体铺在 [start, end] 内：下载 80%、解析 20%。
 */
function buildCachedStats(
  costMs: number,
  bytes: number
): Record<string, unknown> {
  const end = performance.now();
  const span = Math.max(1, costMs);
  const start = end - span;
  const downloadEnd = start + span * 0.8;
  return {
    aborted: false,
    loaded: bytes,
    retry: 0,
    total: bytes,
    chunkCount: 1,
    bwEstimate: (bytes / span) * 1000,
    loading: { start, first: start + span * 0.2, end: downloadEnd },
    parsing: { start: downloadEnd, first: downloadEnd, end },
    buffering: { start: end, first: end, end },
  };
}

/**
 * 创建「去广告 + 缓存优先」的 HLS Loader。
 *
 * - manifest / level：按需剔除广告分片（不连续标记保持不变）
 * - fragment：先查 Cache Storage（由 VideoPrefetcher 预取填充），命中直接返回，
 *   未命中再走原 loader 回源。因此缓存未命中时行为与默认 loader 完全一致。
 */
export function createCustomHlsLoader(
  Hls: any,
  options: HlsLoaderOptions = {}
): any {
  const BaseLoader = Hls.DefaultConfig.loader;
  // 关闭时不改写播放列表，行为与默认 loader 完全一致
  const useAdFilter = options.blockAd === true;
  const onProbe = options.onProbe ?? recordSegmentProbe;

  /**
   * 构建候选缓存键列表（按可能性先后排序）。
   *  - 不再信任创建时快照的 useProxy：设置面板里切开关后，loader 和预取器
   *    用的 format 可能不统一，因此两种 format 都生成，逐个试。
   *  - 再叠加 readCachedSegment 内部的「相对路径/绝对 URL」双重兜底，
   *    基本能覆盖所有 key 不一致的情况。
   */
  function candidateCacheKeys(
    contextUrl: string,
    range?: SegmentByteRange
  ): string[] {
    const liveSettings =
      typeof window !== 'undefined'
        ? loadCacheSettings()
        : DEFAULT_CACHE_SETTINGS;
    const preferredUseProxy =
      options.useProxy !== undefined ? options.useProxy : liveSettings.useProxy;
    const urls = new Set<string>();
    // 优先按当前偏好的 useProxy 生成，其次反过来兜底
    urls.add(buildSegmentCacheKey(contextUrl, preferredUseProxy, range));
    urls.add(buildSegmentCacheKey(contextUrl, !preferredUseProxy, range));
    return Array.from(urls);
  }

  return class MoontvHlsLoader extends BaseLoader {
    constructor(config: any) {
      super(config);
      const baseLoad = this.load.bind(this);
      const baseAbort =
        typeof this.abort === 'function' ? this.abort.bind(this) : null;
      const baseDestroy =
        typeof this.destroy === 'function' ? this.destroy.bind(this) : null;

      // 基类是 any，成员无法直接推断，这里做一次显式断言。
      // `stats` 是 hls.js 内部读取带宽估算的来源，必须就地更新。
      const self = this as unknown as { stats: Record<string, unknown> };

      // 缓存查询是异步的：若期间 hls.js 取消了这次加载（seek / 切码率 /
      // 组件卸载），必须让后续的 onSuccess 与回源请求同时失效，
      // 否则会发出一个没人接收的网络请求。
      let cancelled = false;

      this.abort = function () {
        cancelled = true;
        baseAbort?.();
      };

      this.destroy = function () {
        cancelled = true;
        baseDestroy?.();
      };

      this.load = function (context: any, cfg: any, callbacks: any) {
        // hls.js 不同版本 loader 调用约定不一致，type/url 可能在 context 或 cfg 上：
        //   - type: manifest / level / fragment
        //   - url / uri: 实际请求地址
        // 这里做一次健壮的字段探测。
        const rawType =
          (context && typeof context.type === 'string'
            ? context.type
            : undefined) ??
          (cfg && typeof cfg.type === 'string' ? cfg.type : undefined);
        const rawUrl =
          (context &&
          (typeof context.url === 'string' || typeof context.uri === 'string')
            ? context.url || context.uri
            : undefined) ??
          (cfg && (typeof cfg.url === 'string' || typeof cfg.uri === 'string')
            ? cfg.url || cfg.uri
            : undefined);
        const rangeStart = context?.rangeStart ?? cfg?.rangeStart;
        const rangeEnd = context?.rangeEnd ?? cfg?.rangeEnd;
        const type: string | undefined = rawType as any;
        const url = typeof rawUrl === 'string' ? rawUrl : '';

        // ① 文本播放列表：显式开启时剔除广告分片
        if (type === 'manifest' || type === 'level') {
          if (useAdFilter) {
            const onSuccess = callbacks.onSuccess;
            callbacks.onSuccess = function (
              response: any,
              stats: any,
              ctx: any
            ) {
              const data = response?.data;
              if (typeof data !== 'string') {
                return onSuccess(response, stats, ctx, null);
              }
              // 需要读分片头才能判断「广告是不是另一套编码」，所以这里必须
              // 异步等待；filterAdsFromM3U8Async 内部已兜住所有异常，最坏
              // 情况就是退回同步的结构特征过滤。
              const baseUrl =
                typeof response?.url === 'string' && response.url
                  ? response.url
                  : url || undefined;
              void filterAdsFromM3U8Async(data, baseUrl, true).then(
                (filtered) => {
                  // 探测期间 hls.js 可能已经取消（seek / 切码率 / 卸载）
                  if (cancelled) return;
                  response.data = filtered;
                  onSuccess(response, stats, ctx, null);
                }
              );
            };
          }
          baseLoad(context, cfg, callbacks);
          return;
        }

        // ② 片段：缓存优先
        //    - 有效的 [rangeStart, rangeEnd) 使用独立缓存键，包含从 0 开始的区间。
        //      rangeEnd=0 / undefined 是 hls.js 的整文件哨兵，不应误判。
        //    - 没有明确 type 时：优先用 hls.js 的 `context.frag` 判定，
        //      URL 后缀/关键词只作为兜底启发式。
        const looksLikeFragment =
          /\.(ts|m4s|m4v|mp4|webm|aac|mp3)(\?|$)/i.test(url) ||
          /segment|fragment|clip|part|chunk|frag|plist/i.test(url);
        /** 子播放列表 / 字幕等文本请求：即使 hls.js 塞了 frag 也不能当分片查询 */
        const looksLikeTextResource = /\.(m3u8|m3u|vtt|webvtt)(\?|$)/i.test(
          url
        );
        /**
         * 分片判定。
         *
         * hls.js 1.6 的 `createLoaderContext()` 只给分片上下文塞
         * `{ frag, part, responseType: 'arraybuffer', url, headers, rangeStart, rangeEnd }`，
         * **没有 `type` 字段**（`type` 只出现在 manifest / level / track 等播放列表请求上），
         * 所以 `type === 'fragment'` 实际永远不成立，过去全靠 URL 后缀猜。
         *
         * 采集站常把 TS 切片伪装成 `.jpeg` / `.jpg` / `.png`（响应头也是 image/jpeg，
         * 内容仍是 TS），这类 URL 后缀猜不出来，于是缓存查询整段被跳过：
         * 预取照常下载写入、播放却永远回源，命中率恒为 0。
         * 因此以 `context.frag` 这个 hls.js 内部标志为主来判断。
         */
        const treatAsFragment =
          !looksLikeTextResource &&
          (type === 'fragment' ||
            Boolean(context && context.frag) ||
            (!type && looksLikeFragment));
        const range = normalizeByteRange(rangeStart, rangeEnd);
        const invalidRange = !range && (rangeStart > 0 || rangeEnd > 0);

        if (!treatAsFragment || invalidRange || typeof caches === 'undefined') {
          baseLoad(context, cfg, callbacks);
          return;
        }

        // 候选缓存键按 (useProxy=true/false) × (相对路径/绝对URL) 生成，
        // 任何一个命中就算命中，解决设置切换 / 浏览器自动补全 origin 导致的不匹配。
        const keys = candidateCacheKeys(url, range);

        (async () => {
          for (const cacheKey of keys) {
            const res = await readCachedSegment(cacheKey);
            if (!res) continue;
            if (cancelled) return;

            const { fragment, matchedKey } = res;

            onProbe(true);
            void touchMeta(matchedKey);

            // 就地更新基础类的 stats，避免 hls.js 带宽估算失真
            const stats = buildCachedStats(
              fragment.costMs,
              fragment.data.byteLength
            );
            Object.assign(self.stats, stats);

            callbacks.onSuccess(
              { url: context.url, data: fragment.data },
              self.stats,
              context
            );
            return;
          }

          // 所有候选键都没命中 → 走网络
          if (cancelled) return;
          onProbe(false);
          baseLoad(context, cfg, callbacks);
        })().catch(() => {
          if (!cancelled) baseLoad(context, cfg, callbacks);
        });
      };
    }
  };
}
