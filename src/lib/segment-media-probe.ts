/**
 * 分片媒体参数探测：只读分片前 32KB，解析出画面的宽高。
 *
 * 为什么需要它：采集站（非凡/电影天堂一类的 VIP 线路）把广告「拼接」进正片时，
 * 播放列表里看不到任何广告痕迹——
 *
 *  - 没有 `#EXT-X-CUE-OUT` / `CUE-IN` 这类 SCTE-35 标记；
 *  - 分片地址全是同一台 CDN 上的随机哈希（`703ae0bd….ts?hash=…`），
 *    没有 `/ad/`、`preroll` 之类关键词；
 *  - 广告块与正文块时长同量级（实测 14.2s / 4.9s vs 正文 18–80s），
 *    按「被长内容夹住的短块」也判不出来。
 *
 * 唯一稳定的特征是**编码参数**：广告通常由另一套转码流程产出，分辨率 / 帧率
 * 与正文不同（实测正文 1920x800@25fps，广告 1920x1080@30fps）。播放列表里
 * 没有这些信息，只能读分片本体。
 *
 * 实现要点：
 *  - 只发 Range 请求取头部若干字节。实测 TS 里 SPS 位于分片第 **602–1376**
 *    字节（6 个样本，含正文与广告），所以首轮只读 4KB；万一没解析到 SPS
 *    再补读 32KB 兜底。44 个块一轮下来约 176KB，不到一个 1080p 分片的 1/10。
 *  - 结果按分片 URL 缓存，播放器与预取器解析同一份播放列表时只会真正探测一次；
 *    播放器侧还会先查 Cache Storage（见 `play-utils` 的探测函数），已缓存的
 *    分片零请求。
 *  - 任何失败（网络、CORS、非 2xx、解析不出 SPS）都返回 null，调用方据此
 *    「不做判定」，永远退化为原有逻辑，不会因为探测失败而误删正文。
 */

/** 首轮探测读取的字节数（实测 SPS 在 602–1376 字节处） */
export const MEDIA_PROFILE_HEAD_BYTES = 4 * 1024;

/** 首轮没解析到 SPS 时的兜底读取长度 */
const FALLBACK_HEAD_BYTES = 32 * 1024;

/** 单次探测的超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * 「soft 失败」第一次重试前的等待（毫秒）。
 *
 * soft = 5xx / 超时 / 读到空响应：源站可能只是抖了一下，重试一次往往就好了。
 * 401/403/404/410 与 CORS/网络错误属于 hard，重试只会多刷一条控制台报错，
 * 所以不重试。
 */
const PROBE_RETRY_DELAY_MS = 300;

/**
 * soft 失败的负缓存时长（毫秒）。
 *
 * hard 失败是定论（这个源就是不给读），本会话不再尝试；
 * soft 失败只记住 30s，等下一次播放列表解析（切集 / 拖回 / 预取）时再试。
 * 否则一次瞬时 502 会让这个分片在整场会话里永远读不到参数。
 */
const SOFT_FAILURE_TTL_MS = 30 * 1000;

/** 探测结果缓存条数上限（播放器 + 预取器共用） */
const PROFILE_CACHE_LIMIT = 4096;

/**
 * 分片的编码参数指纹。
 *
 * 只比宽高是不够的：实测同一条线路里广告与正文都是 1920x1080，差别只在
 * **帧率**（正文 25fps、广告 30fps，来自 SPS VUI 里的 timing_info）。
 * 因此把 `fps` 也纳入指纹，但它是可选的——SPS 里没有 VUI 时留空，
 * 比较时退化为只看宽高（`sameMediaProfile()`）。
 */
export interface MediaProfile {
  width: number;
  height: number;
  /** 帧率（来自 SPS VUI timing_info）；缺失表示该 SPS 未写帧率信息 */
  fps?: number;
}

/** profile_idc 落在这些取值上时 SPS 里带 chroma_format_idc 等扩展字段 */
const HIGH_PROFILE_IDCS = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
]);

interface ProfileCacheEntry {
  profile: MediaProfile | null;
  /** 过期时间戳；0 表示不过期（成功结果与 hard 失败） */
  expiresAt: number;
}

const profileCache = new Map<string, ProfileCacheEntry>();
const inflightProbes = new Map<string, Promise<MediaProfile | null>>();

/** 清空探测缓存（测试用） */
export function resetMediaProfileCache(): void {
  profileCache.clear();
  inflightProbes.clear();
  originFailures.clear();
  unreadableOrigins.clear();
}

/** 画面尺寸 + 帧率的字符串键，用于投票与日志输出 */
export function mediaProfileKey(profile: MediaProfile): string {
  const size = `${profile.width}x${profile.height}`;
  return profile.fps ? `${size}@${profile.fps}fps` : size;
}

/**
 * 两个分片是否属于"同一套编码"。
 *
 * 宽高必须一致；帧率只在**两边都读得到**时才参与比较（25 vs 30 判不同，
 * 29.97 vs 30 判相同）。任何一边缺帧率就退化为只看宽高，避免误判。
 */
export function sameMediaProfile(a: MediaProfile, b: MediaProfile): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (!a.fps || !b.fps) return true;
  return Math.abs(a.fps - b.fps) < 1.5;
}

/**
 * SPS 的按位读取器（H.264 语法元素是 ue/se 这类变长码）。
 *
 * 位宽最大只用到 32，因此用浮点累乘而不是 `<<`，避免 32 位进位溢出。
 */
class BitReader {
  private readonly bytes: Uint8Array;
  private bitPos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  readBit(): number {
    const byteIndex = this.bitPos >> 3;
    if (byteIndex >= this.bytes.length) throw new RangeError('SPS 越界');
    const bit = (this.bytes[byteIndex] >> (7 - (this.bitPos & 7))) & 1;
    this.bitPos += 1;
    return bit;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = value * 2 + this.readBit();
    return value;
  }

  readUe(): number {
    let zeros = 0;
    while (this.readBit() === 0) {
      zeros += 1;
      if (zeros > 31) throw new RangeError('SPS ue(v) 非法');
    }
    return 2 ** zeros - 1 + this.readBits(zeros);
  }

  readSe(): number {
    const code = this.readUe();
    const magnitude = Math.ceil(code / 2);
    return code % 2 === 1 ? magnitude : -magnitude;
  }
}

/** 跳过 scaling list（High profile 才可能出现） */
function skipScalingList(reader: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i += 1) {
    if (next !== 0) next = (last + reader.readSe() + 256) % 256;
    if (next !== 0) last = next;
  }
}

/** 去掉 H.264 的防竞争字节（00 00 03 → 00 00） */
function stripEmulationPrevention(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let written = 0;
  let zeros = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    out[written] = byte;
    written += 1;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, written);
}

/**
 * 解析一个 H.264 SPS NAL，返回画面宽高。
 *
 * @param nal 可带 NAL 头（0x67），也可直接是 SPS 的 RBSP 负载
 */
export function parseSpsProfile(nal: Uint8Array): MediaProfile | null {
  if (!nal || nal.length < 5) return null;
  const payload = (nal[0] & 0x1f) === 7 ? nal.subarray(1) : nal;
  const rbsp = stripEmulationPrevention(payload);

  try {
    const reader = new BitReader(rbsp);
    const profileIdc = reader.readBits(8);
    reader.readBits(8); // constraint flags
    reader.readBits(8); // level_idc
    reader.readUe(); // seq_parameter_set_id

    let chromaFormatIdc = 1;
    let separateColourPlane = 0;
    if (HIGH_PROFILE_IDCS.has(profileIdc)) {
      chromaFormatIdc = reader.readUe();
      if (chromaFormatIdc === 3) separateColourPlane = reader.readBit();
      reader.readUe(); // bit_depth_luma_minus8
      reader.readUe(); // bit_depth_chroma_minus8
      reader.readBit(); // qpprime_y_zero_transform_bypass_flag
      if (reader.readBit() === 1) {
        // seq_scaling_matrix_present_flag
        const lists = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < lists; i += 1) {
          if (reader.readBit() === 1) skipScalingList(reader, i < 6 ? 16 : 64);
        }
      }
    }

    reader.readUe(); // log2_max_frame_num_minus4
    const pocType = reader.readUe();
    if (pocType === 0) {
      reader.readUe(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      reader.readBit(); // delta_pic_order_always_zero_flag
      reader.readSe(); // offset_for_non_ref_pic
      reader.readSe(); // offset_for_top_to_bottom_field
      const cycle = reader.readUe();
      for (let i = 0; i < cycle; i += 1) reader.readSe();
    }

    reader.readUe(); // max_num_ref_frames
    reader.readBit(); // gaps_in_frame_num_value_allowed_flag
    const widthInMbs = reader.readUe() + 1;
    const heightInMapUnits = reader.readUe() + 1;
    const frameMbsOnly = reader.readBit();
    if (frameMbsOnly === 0) reader.readBit(); // mb_adaptive_frame_field_flag
    reader.readBit(); // direct_8x8_inference_flag

    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (reader.readBit() === 1) {
      cropLeft = reader.readUe();
      cropRight = reader.readUe();
      cropTop = reader.readUe();
      cropBottom = reader.readUe();
    }

    /**
     * VUI 里可能带 timing_info：`fps = time_scale / (2 * num_units_in_tick)`。
     *
     * 同一分辨率下广告与正文往往只差帧率（实测 25fps vs 30fps），这是把
     * 它们区分开的唯一编码级信号。SPS 没写 VUI 时 fps 留空。
     */
    let fps: number | undefined;
    if (reader.readBit() === 1) {
      // vui_parameters_present_flag
      if (reader.readBit() === 1) {
        // aspect_ratio_info_present_flag
        if (reader.readBits(8) === 255) {
          reader.readBits(16); // sar_width
          reader.readBits(16); // sar_height
        }
      }
      if (reader.readBit() === 1) reader.readBit(); // overscan_info
      if (reader.readBit() === 1) {
        // video_signal_type_present_flag
        reader.readBits(3); // video_format
        reader.readBit(); // video_full_range_flag
        if (reader.readBit() === 1) {
          // colour_description_present_flag
          reader.readBits(8); // colour_primaries
          reader.readBits(8); // transfer_characteristics
          reader.readBits(8); // matrix_coefficients
        }
      }
      if (reader.readBit() === 1) {
        // chroma_loc_info_present_flag
        reader.readUe();
        reader.readUe();
      }
      if (reader.readBit() === 1) {
        // timing_info_present_flag
        const numUnitsInTick = reader.readBits(32);
        const timeScale = reader.readBits(32);
        if (numUnitsInTick > 0 && timeScale > 0) {
          const value = timeScale / (2 * numUnitsInTick);
          if (Number.isFinite(value) && value > 0 && value < 1000) {
            // 保留两位小数：29.97 / 23.98 这类不能取整
            fps = Math.round(value * 100) / 100;
          }
        }
      }
    }

    const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
    const subWidthC = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
    const subHeightC = chromaArrayType === 1 ? 2 : 1;
    const cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
    const cropUnitY =
      chromaArrayType === 0
        ? 2 - frameMbsOnly
        : subHeightC * (2 - frameMbsOnly);

    const width = widthInMbs * 16 - (cropLeft + cropRight) * cropUnitX;
    const height =
      (2 - frameMbsOnly) * heightInMapUnits * 16 -
      (cropTop + cropBottom) * cropUnitY;
    if (!(width > 0) || !(height > 0)) return null;
    return fps ? { width, height, fps } : { width, height };
  } catch {
    return null;
  }
}

/** 从 `index` 起找下一个 Annex B 起始码位置，找不到返回 -1 */
function findStartCode(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 3 <= bytes.length; i += 1) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      return i > 0 && bytes[i - 1] === 0 ? i - 1 : i;
    }
  }
  return -1;
}

/**
 * 在 Annex B（TS 分片）字节流里找第一个 SPS 并解析尺寸。
 *
 * 不完整解 TS 复用：只要桶里还带着起始码就能定位 NAL；TS 包头本身不会
 * 制造 `00 00 01` 之外的假同步（起始码前的 0 也已校验）。
 */
export function parseAnnexBDimensions(bytes: Uint8Array): MediaProfile | null {
  for (let i = 2; i + 4 <= bytes.length; i += 1) {
    if (bytes[i] !== 0x01 || bytes[i - 1] !== 0 || bytes[i - 2] !== 0) {
      continue;
    }
    const headerAt = i + 1;
    if ((bytes[headerAt] & 0x1f) !== 7) continue;
    const next = findStartCode(bytes, headerAt + 1);
    const end = next === -1 ? bytes.length : next;
    const profile = parseSpsProfile(bytes.subarray(headerAt, end));
    if (profile) return profile;
  }
  return null;
}

/**
 * 从 fMP4 的 `avcC`（AVCDecoderConfigurationRecord）里解析尺寸。
 *
 * 结构：`avcC` 之后 4 个字节是配置版本/profile/compat/level，第 5 个字节低
 * 5 位是 SPS 数量，随后每个 SPS 以 2 字节长度前缀开头。
 */
export function parseAvcCDimensions(bytes: Uint8Array): MediaProfile | null {
  for (let i = 0; i + 12 <= bytes.length; i += 1) {
    if (
      bytes[i] !== 0x61 ||
      bytes[i + 1] !== 0x76 ||
      bytes[i + 2] !== 0x63 ||
      bytes[i + 3] !== 0x43
    ) {
      continue;
    }
    const spsCount = bytes[i + 9] & 0x1f;
    let offset = i + 10;
    for (let n = 0; n < spsCount; n += 1) {
      if (offset + 2 > bytes.length) return null;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      offset += 2;
      if (length <= 0 || offset + length > bytes.length) return null;
      const profile = parseSpsProfile(bytes.subarray(offset, offset + length));
      if (profile) return profile;
      offset += length;
    }
    return null;
  }
  return null;
}

/** 从分片头部的字节里解析画面尺寸（先按 fMP4 找 avcC，再按 Annex B 找 SPS） */
export function parseMediaProfileHead(bytes: Uint8Array): MediaProfile | null {
  if (!bytes || bytes.length === 0) return null;
  return parseAvcCDimensions(bytes) ?? parseAnnexBDimensions(bytes);
}

/**
 * 读取响应体的前 `limit` 字节，超出部分直接取消。
 *
 * 两个调用方都靠它避免把整个分片（1–2MB）读进内存：网络探测时服务器可能
 * 忽略 Range 直接回 200 全量，Cache Storage 里则本来就是整片字节。
 */
export async function readResponseHeadBytes(
  response: Response,
  limit: number
): Promise<Uint8Array | null> {
  const body = (response as unknown as { body?: ReadableStream<Uint8Array> })
    .body;
  const reader =
    body && typeof body.getReader === 'function' ? body.getReader() : null;

  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.subarray(0, limit);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    chunks.push(value);
    total += value.length;
  }
  // 服务器忽略了 Range 时也必须及时收手
  void reader.cancel().catch(() => undefined);

  const out = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

export interface MediaProfileProbeOptions {
  /** 便于测试注入；默认用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 单次探测的超时，默认 4s */
  timeoutMs?: number;
  /** 首轮读取的字节数，默认 4KB（解析不到 SPS 会自动补读 32KB） */
  headBytes?: number;
  /** soft 失败重试前的等待，默认 300ms；传 0 表示立刻重试 */
  retryDelayMs?: number;
}

/** 连续多少次"硬失败"后，认定该源在本会话不可探测 */
const ORIGIN_FAILURE_THRESHOLD = 2;

/**
 * 按 origin 记录"探测硬失败"（CORS / 网络错误 / 401·403·404·410）。
 *
 * 采集站常见整站防盗链：分片直连 403 且不带 ACAO，探测必然全灭。要是每份
 * 播放列表都白打几十个请求，控制台会被 CORS 报错刷屏、首帧也被拖慢。
 * 所以同一个 origin 连续失败到阈值后就本次会话不再尝试——退化为结构特征
 * 判定（不删广告，但也不会误删）。
 */
const originFailures = new Map<string, number>();
const unreadableOrigins = new Set<string>();

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 该分片所在源在本会话是否已被判定"不可探测"（测试/调试用） */
export function isSegmentProbeBlocked(url: string): boolean {
  const origin = originOf(url);
  return origin !== null && unreadableOrigins.has(origin);
}

function noteProbeOutcome(url: string, hardFailure: boolean): void {
  const origin = originOf(url);
  if (!origin) return;
  if (!hardFailure) {
    originFailures.delete(origin);
    return;
  }
  const failures = (originFailures.get(origin) ?? 0) + 1;
  originFailures.set(origin, failures);
  if (failures >= ORIGIN_FAILURE_THRESHOLD) unreadableOrigins.add(origin);
}

type HeadResult =
  | { kind: 'ok'; head: Uint8Array }
  | { kind: 'hard' } // CORS / 网络 / 鉴权：重试与换分片都没用
  | { kind: 'soft' }; // 5xx / 超时：可能只是瞬时问题

/** 发一次 Range 请求，返回前 `limit` 字节 */
async function fetchHeadBytes(
  url: string,
  limit: number,
  options: MediaProfileProbeOptions
): Promise<HeadResult> {
  const fetchImpl =
    options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { kind: 'hard' };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller =
    typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: { Range: `bytes=0-${limit - 1}` },
      signal: controller?.signal,
    });
    if (!response) return { kind: 'hard' };
    if (!response.ok) {
      const status = (response as unknown as { status?: number }).status;
      const hard =
        status === 401 || status === 403 || status === 404 || status === 410;
      return { kind: hard ? 'hard' : 'soft' };
    }
    const head = await readResponseHeadBytes(response, limit);
    return head ? { kind: 'ok', head } : { kind: 'soft' };
  } catch {
    // 超时是我们自己 abort 的：源站可能只是慢，归入可重试
    if (controller?.signal.aborted) return { kind: 'soft' };
    // CORS / DNS / 连接被拒都会走到这里，重试无用
    return { kind: 'hard' };
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读分片头，soft 失败（5xx / 超时 / 空响应）重试一次。
 *
 * 只重试一次：探测是播放列表解析的前置步骤，不能让一个坏源把首帧拖住；
 * 而 hard 失败（401/403/404/410、CORS）重试注定还是同样的结果，直接放弃。
 */
async function fetchHeadBytesWithRetry(
  url: string,
  limit: number,
  options: MediaProfileProbeOptions
): Promise<HeadResult> {
  const first = await fetchHeadBytes(url, limit, options);
  if (first.kind !== 'soft') return first;
  const delayMs = options.retryDelayMs ?? PROBE_RETRY_DELAY_MS;
  if (delayMs > 0) await delay(delayMs);
  return fetchHeadBytes(url, limit, options);
}

interface ProbeOutcome {
  profile: MediaProfile | null;
  /** 失败是否只是瞬时的（soft）：true 时只做短期负缓存，稍后可以再试 */
  retryable: boolean;
}

async function requestProfile(
  url: string,
  options: MediaProfileProbeOptions
): Promise<ProbeOutcome> {
  const headBytes = options.headBytes ?? MEDIA_PROFILE_HEAD_BYTES;
  const first = await fetchHeadBytesWithRetry(url, headBytes, options);
  if (first.kind !== 'ok') {
    const hard = first.kind === 'hard';
    noteProbeOutcome(url, hard);
    return { profile: null, retryable: !hard };
  }
  noteProbeOutcome(url, false);
  const profile = parseMediaProfileHead(first.head);
  if (profile) return { profile, retryable: false };
  // 少数源把 SPS 放得靠后：补读一次再试，仍失败就当不可读
  if (headBytes >= FALLBACK_HEAD_BYTES)
    return { profile: null, retryable: false };
  const fallback = await fetchHeadBytesWithRetry(
    url,
    FALLBACK_HEAD_BYTES,
    options
  );
  if (fallback.kind !== 'ok') {
    const hard = fallback.kind === 'hard';
    // 补读这一步也要记账，否则这个源会一直被当成"可探测"而白打请求
    noteProbeOutcome(url, hard);
    return { profile: null, retryable: !hard };
  }
  // 读到了字节却解析不出 SPS：再读也没用
  return { profile: parseMediaProfileHead(fallback.head), retryable: false };
}

/** 写缓存；`retryable` 为 true 时只记一个短 TTL，等下一次解析再试 */
function writeCache(
  url: string,
  profile: MediaProfile | null,
  retryable: boolean
): void {
  if (profileCache.size >= PROFILE_CACHE_LIMIT) profileCache.clear();
  profileCache.set(url, {
    profile,
    expiresAt:
      profile === null && retryable ? Date.now() + SOFT_FAILURE_TTL_MS : 0,
  });
}

/** 读缓存；命中且未过期才算命中 */
function readCache(url: string): {
  hit: boolean;
  profile: MediaProfile | null;
} {
  const entry = profileCache.get(url);
  if (!entry) return { hit: false, profile: null };
  if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
    profileCache.delete(url);
    return { hit: false, profile: null };
  }
  return { hit: true, profile: entry.profile };
}

/**
 * 探测单个分片的画面尺寸。
 *
 * 结果（包括 null）都会被缓存：同一份播放列表会被播放器和预取器各解析一次，
 * 没有缓存就白白多付一倍的请求。区别在失败的性质：
 *
 *  - 成功 / hard 失败（401·403·404·410、CORS）→ 本会话的定论，永久缓存；
 *  - soft 失败（5xx / 超时 / 空响应）→ 先重试一次，仍失败只记 30s，
 *    过一会儿（切集重解析、预取）还会再试，不会被一次抖动钉死。
 */
export function probeSegmentProfile(
  url: string,
  options: MediaProfileProbeOptions = {}
): Promise<MediaProfile | null> {
  if (!url) return Promise.resolve(null);
  // 该源已判定不可探测：直接放弃，不再产生注定 403 / CORS 的请求
  if (isSegmentProbeBlocked(url)) return Promise.resolve(null);
  const cached = readCache(url);
  if (cached.hit) return Promise.resolve(cached.profile);
  const pending = inflightProbes.get(url);
  if (pending) return pending;

  const task = requestProfile(url, options)
    .catch(() => ({ profile: null, retryable: true } as ProbeOutcome))
    .then((outcome) => {
      inflightProbes.delete(url);
      writeCache(url, outcome.profile, outcome.retryable);
      return outcome.profile;
    });
  inflightProbes.set(url, task);
  return task;
}

/**
 * 把外部已经拿到的结果写回缓存。
 *
 * 播放器侧会先从 Cache Storage 里读分片头（零网络）再解析；那个结果必须
 * 回写到同一份缓存里，预取器解析同一份播放列表时才能直接命中——否则两边
 * 一个用缓存、一个走网络，探测结论不一致就会让预取时间轴和播放器错位。
 */
export function rememberSegmentProfile(
  url: string,
  profile: MediaProfile
): void {
  if (!url || !profile) return;
  writeCache(url, profile, false);
}

export interface ProfileSample {
  profile: MediaProfile | null;
  /** 该样本的权重，默认 1（按块计数） */
  weight?: number;
}

export interface DominantProfile {
  profile: MediaProfile;
  weight: number;
  total: number;
}

/**
 * 取「正文」的媒体参数：出现次数最多的画面尺寸。
 *
 * @param minRatio 最高票数占总票数的下限；低于它说明这份播放列表本身就混着
 *   多种编码（或样本太少），此时不做任何判定，避免误删。
 */
export function resolveDominantProfile(
  samples: readonly ProfileSample[],
  minRatio = 0.6
): DominantProfile | null {
  const tally = new Map<string, DominantProfile>();
  let total = 0;

  for (const sample of samples) {
    if (!sample?.profile) continue;
    const weight = sample.weight ?? 1;
    if (!(weight > 0)) continue;
    total += weight;
    const key = mediaProfileKey(sample.profile);
    const entry = tally.get(key);
    if (entry) entry.weight += weight;
    else tally.set(key, { profile: sample.profile, weight, total: 0 });
  }

  let best: DominantProfile | null = null;
  tally.forEach((entry) => {
    if (!best || entry.weight > best.weight) best = entry;
  });
  if (!best || total === 0) return null;
  const winner = best as DominantProfile;
  if (winner.weight / total < minRatio) return null;
  return { profile: winner.profile, weight: winner.weight, total };
}
