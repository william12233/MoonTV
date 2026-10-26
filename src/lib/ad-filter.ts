/**
 * HLS 播放列表广告分片剔除。
 *
 * 旧实现只删除 `#EXT-X-DISCONTINUITY` 行：既不删广告分片，又丢掉 PTS 断点
 * 信息，导致时间轴空洞（拖动报 `bufferSeekOverHole`）、画面回推与音画错位。
 * 这里改为**真正删除广告分片条目**，并保留所有不连续标记与 KEY/MAP 标签。
 *
 * 判定以「块」为单位（两个 `#EXT-X-DISCONTINUITY` 之间），命中任一即视为广告：
 *  1. 块内**所有**分片都落在 SCTE-35 广告窗内
 *     （`#EXT-X-CUE-OUT` 之后、`#EXT-X-CUE-IN` 之前；标记经常落在相邻块上，
 *     所以按"分片是否处于广告窗"判断，而不是看块里有没有标记行）；
 *  2. 块内所有分片 URL 都带广告特征词（`/ad/`、`preroll`、`guanggao` 等）；
 *  3. 短块（≤ 90s）里部分分片带广告特征 URL；
 *  4. 被两侧长内容夹住的短块（无 CUE、无 URL 特征的中插广告）。
 *
 * 以上四条都是「结构特征」。采集站的 VIP 线路还会把广告**重新编码后拼接**
 * 进正片：分片地址是同 CDN 的随机哈希、没有任何 CUE 标记、块时长与正文同量级，
 * 结构上一无所获（实测 44 个块里 2 个广告块全部漏判）。这种情况由
 * `stripAdSegmentsByMediaProfile()` 用分片本体的编码参数识别：
 * 广告帧尺寸与正文不同（实测正文 1920x800，广告 1920x1080）。
 *
 * 安全性：
 *  - 仅处理含 `#EXT-X-ENDLIST` 的点播列表，直播列表原样返回；
 *  - 单块超过 5 分钟不判广告；
 *  - 剔除时长超过总时长 50%、或会把分片删光时放弃；
 *  - `#EXT-X-KEY` / `#EXT-X-MAP` 等标签永不删除；
 *  - 媒体参数探测失败 / 样本不足时不做判定（只会少删，不会误删）。
 *
 * 排查：处理过程会输出 `[ad-filter]` 日志，包含块数 / 段数 / 总时长与
 * 命中的广告块信息，可据此确认广告为什么没被识别。
 */

import { mapWithConcurrency } from './concurrency';
import {
  type MediaProfile,
  mediaProfileKey,
  probeSegmentProfile,
  resolveDominantProfile,
  sameMediaProfile,
} from './segment-media-probe';

/**
 * 已判定过的播放列表结论缓存（同一份列表会被解析多次）。
 *
 * 播放器的 `LEVEL_LOADING`、预取器的 `ensure()`、下一集预热、切集后的重新
 * 解析——同一集播放列表在一次观影里会被解析 3–4 次。每解析一次就重新探测
 * 一遍分片头，既慢又会把源站的 403 / CORS 刷到控制台上；更糟的是几次调用
 * 拿到的样本数不同，可能出现「播放器删了广告、预取器没删」这种**两个调用方
 * 时间轴不一致**（缓存元数据里的开始时间整体偏后一个广告时长）。
 *
 * 所以只要某次解析真的删掉了广告块，就把结论（过滤后的文本）记住，后续同一
 * 份列表直接复用：零探测、零请求、结论完全一致。
 *
 * 只缓存「有删除」的结论：失败/样本不足的结论不缓存，否则一旦某次因为在
 * 缓存还没写入时探测失败而被钉死成"没广告"，之后即使分片已落盘也再也纠正
 * 不过来（宁可多探测一次，也不能永久漏删）。
 */
const DECISION_TTL_MS = 10 * 60 * 1000;
const DECISION_CACHE_LIMIT = 24;
const decisions = new Map<string, { output: string; at: number }>();

/** 轻量内容指纹（FNV-1a 32 位）：播放列表 20–30KB，没必要上密码学哈希 */
function contentFingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${input.length}`;
}

function readDecision(content: string): string | null {
  const entry = decisions.get(contentFingerprint(content));
  if (!entry) return null;
  if (Date.now() - entry.at > DECISION_TTL_MS) {
    decisions.delete(contentFingerprint(content));
    return null;
  }
  return entry.output;
}

function rememberDecision(content: string, output: string): void {
  const key = contentFingerprint(content);
  decisions.delete(key);
  if (decisions.size >= DECISION_CACHE_LIMIT) {
    const oldest = decisions.keys().next();
    if (!oldest.done) decisions.delete(oldest.value);
  }
  decisions.set(key, { output, at: Date.now() });
}

/** 清空结论缓存（测试用；切源/清缓存时无需手动调用，TTL 会自然过期） */
export function resetAdFilterDecisionCache(): void {
  decisions.clear();
}

/** 强广告特征：必须出现在路径/文件名的分隔边界上，避免 `shadow` 误判 */
const AD_URL_PATTERN =
  /(^|[/_.-])(ad|ads|adv|advert|advertisement|advertising|guanggao|preroll|pre-roll|midroll|mid-roll|commercial|cueout|cue-out)([/_.-]|$)/i;

/** 单个广告块的时长上限（秒），超过更可能是正文 */
const MAX_AD_BLOCK_SECONDS = 300;

/** 短块阈值（秒）：局部命中广告特征即可判定 */
const SHORT_BLOCK_SECONDS = 90;

/**
 * 「中插短块」阈值（秒）。
 *
 * 采集站常见形态：广告块没有任何 CUE 标记、文件名也是随机哈希，但会被
 * `#EXT-X-DISCONTINUITY` 切成 15–30s 的独立块，两侧是数十分钟的正文。
 * 被长内容夹住的短块几乎只能是广告。
 */
const SANDWICHED_AD_SECONDS = 30;

/** 两侧正文至少是短块的多少倍才判定为中插广告 */
const SANDWICHED_CONTENT_RATIO = 4;

/** 最多允许剔除的时长占比，超过则视为规则误判 */
const MAX_REMOVED_RATIO = 0.5;

/**
 * 媒体参数探测的默认并发。
 *
 * 每块只读 4KB，走浏览器同源/跨域 Range 请求，12 路并行足以让 44 个块在
 * 0.3–0.5s 内探完（实测 RTT 100ms 左右）；再高只会给采集站 CDN 添乱。
 */
const PROFILE_PROBE_CONCURRENCY = 12;

/**
 * 参与媒体参数探测的块数上限。
 *
 * 每块要发一个 Range 请求，块数太多时收益不抵成本（长剧集通常 20–60 块）。
 * 超过上限直接跳过探测，退化为结构特征判定。
 */
const MAX_PROFILE_PROBE_BLOCKS = 120;

/** 判定「正文参数」所需的最低占比，低于它说明播放列表本身混着多种编码 */
const MIN_DOMINANT_RATIO = 0.6;

/** 试探阶段的块数：全部失败就认定这份播放列表的分片不可读，直接放弃 */
const PROFILE_WARMUP_BLOCKS = 3;

/**
 * 每个块最多探测几个分片。
 *
 * 只读块内**第一个**分片是不够稳的：采集站个别分片会 404 / 被清理，首分片
 * 挂掉并不代表整块读不到参数。块内分片本来就是同一套编码，换个分片再读一次
 * 既不会改变判定结论，也不会引入误判；上限 2 是为了不给死源翻倍刷请求
 * （真正整站 403 时，`segment-media-probe` 的 origin 负缓存会在第 2 次失败后
 * 直接掐断，实际请求数仍然只有 2–3 个）。
 */
const PROBE_SEGMENTS_PER_BLOCK = 2;

/**
 * 探测的总时间预算（毫秒）。
 *
 * 单个探测自带 4s 超时，但采集站 CDN 偶发挂起时，44 个块按波次排队会把
 * 播放列表解析拖到十几秒——那比广告本身还难受。这里给整轮探测一个硬上限：
 * 超预算的块直接按「未知」处理（不参与判定），已经拿到的样本照常使用。
 */
const PROFILE_PROBE_BUDGET_MS = 6000;

/** 与具体分片绑定、可随分片一起删除的标签 */
const SEGMENT_TAGS = [
  '#EXTINF:',
  '#EXT-X-BYTERANGE:',
  '#EXT-X-PROGRAM-DATE-TIME:',
  '#EXT-X-GAP',
  '#EXT-X-BITRATE:',
] as const;

type RemovalReason =
  | 'live'
  | 'filtered'
  | 'no-ad-block'
  | 'ratio-guard'
  | 'would-remove-all';

/** 命中来源，仅用于日志区分 */
type RemovalSource = 'structural' | 'profile' | 'mixed' | 'none';

interface SegmentToken {
  kind: 'segment';
  lines: string[];
  uri: string;
  duration: number;
  blockId: number;
}

interface PlainToken {
  kind: 'plain';
  lines: string[];
}

type Token = SegmentToken | PlainToken;

interface BlockStats {
  id: number;
  duration: number;
  uris: string[];
  hasCueOut: boolean;
  hasCueIn: boolean;
  /** 落在 SCTE-35 广告窗内的分片数 */
  cueSegments: number;
  segmentCount: number;
}

interface AnalyzedPlaylist {
  tokens: Token[];
  /** 按出现顺序、只含分片的块 */
  blocks: BlockStats[];
  totalDuration: number;
  totalSegments: number;
}

function isSegmentTag(line: string): boolean {
  return SEGMENT_TAGS.some((tag) => line.startsWith(tag));
}

function isAdBlock(block: BlockStats): boolean {
  if (block.segmentCount === 0 || block.duration <= 0) return false;
  if (block.duration > MAX_AD_BLOCK_SECONDS) return false;

  // 整块都在 SCTE-35 广告窗内：最可靠的信号
  if (block.cueSegments > 0 && block.cueSegments === block.segmentCount) {
    return true;
  }

  const hits = block.uris.filter((uri) => AD_URL_PATTERN.test(uri)).length;
  if (hits === 0) return false;
  // 整个块都是广告地址，或短块里出现广告地址
  return hits === block.uris.length || block.duration <= SHORT_BLOCK_SECONDS;
}

/** 秒数简写：只保留整数，避免日志出现 34.90000000000001 */
function formatSeconds(value: number): string {
  return `${Math.round(value)}s`;
}

/**
 * 日志去重。
 *
 * 播放器与进度条抽帧各有一个 Hls 实例，都会过滤同一份 level 播放列表；
 * 两条完全相同的日志除了刷屏没有价值。5 秒内相同结果只输出一次。
 */
let lastLogSignature = '';
let lastLogAt = 0;
const LOG_DEDUPE_MS = 5_000;

function shouldLog(signature: string): boolean {
  const now = Date.now();
  if (signature === lastLogSignature && now - lastLogAt < LOG_DEDUPE_MS) {
    return false;
  }
  lastLogSignature = signature;
  lastLogAt = now;
  return true;
}

/**
 * 把播放列表切成 token 与块。
 *
 * @returns 直播列表 / 主播放列表 / 空内容返回 null（调用方原样返回）
 */
function analyzePlaylist(content: string): AnalyzedPlaylist | null {
  if (!content) return null;
  // 主播放列表没有分片，交给子播放列表处理，避免刷无意义的日志
  if (content.includes('#EXT-X-STREAM-INF')) return null;
  // 直播列表不做处理，也不打日志（每次刷新播放列表都会触发，纯噪音）
  if (!content.includes('#EXT-X-ENDLIST')) return null;

  const lines = content.split('\n');
  const tokens: Token[] = [];
  const blocks = new Map<number, BlockStats>();

  let blockId = 0;
  let pending: string[] = [];
  let pendingDuration = 0;
  /** 当前分片是否处于 SCTE-35 广告窗内（CUE-OUT 之后、CUE-IN 之前） */
  let cueWindow = false;

  const ensureBlock = (id: number): BlockStats => {
    let block = blocks.get(id);
    if (!block) {
      block = {
        id,
        duration: 0,
        uris: [],
        hasCueOut: false,
        hasCueIn: false,
        cueSegments: 0,
        segmentCount: 0,
      };
      blocks.set(id, block);
    }
    return block;
  };

  const flushPending = () => {
    if (pending.length === 0) return;
    tokens.push({ kind: 'plain', lines: pending });
    pending = [];
    pendingDuration = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      pending.push(rawLine);
      continue;
    }

    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      flushPending();
      blockId += 1;
      tokens.push({ kind: 'plain', lines: [rawLine] });
      continue;
    }

    if (line.startsWith('#EXT-X-CUE-OUT')) {
      ensureBlock(blockId).hasCueOut = true;
      cueWindow = true;
      tokens.push({ kind: 'plain', lines: [rawLine] });
      continue;
    }
    if (line.startsWith('#EXT-X-CUE-IN')) {
      ensureBlock(blockId).hasCueIn = true;
      // CUE-IN 之后的分片回到正文，先关闭窗口再处理后续行
      cueWindow = false;
      tokens.push({ kind: 'plain', lines: [rawLine] });
      continue;
    }

    if (line.startsWith('#')) {
      // 只有"绑定到具体分片"的标签跟随分片，其余（KEY/MAP/版本等）一律保留
      if (isSegmentTag(line)) {
        if (line.startsWith('#EXTINF:')) {
          pendingDuration =
            Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;
        }
        pending.push(rawLine);
      } else {
        flushPending();
        tokens.push({ kind: 'plain', lines: [rawLine] });
      }
      continue;
    }

    // 分片地址
    const block = ensureBlock(blockId);
    block.duration += pendingDuration;
    block.uris.push(line);
    block.segmentCount += 1;
    if (cueWindow) block.cueSegments += 1;

    tokens.push({
      kind: 'segment',
      lines: [...pending, rawLine],
      uri: line,
      duration: pendingDuration,
      blockId,
    });
    pending = [];
    pendingDuration = 0;
  }
  flushPending();

  const ordered = Array.from(blocks.values())
    .filter((block) => block.segmentCount > 0)
    .sort((a, b) => a.id - b.id);

  let totalDuration = 0;
  let totalSegments = 0;
  ordered.forEach((block) => {
    totalDuration += block.duration;
    totalSegments += block.segmentCount;
  });

  return { tokens, blocks: ordered, totalDuration, totalSegments };
}

/** 结构特征判定：CUE 广告窗 / 广告特征 URL / 被长内容夹住的短块 */
function detectStructuralAdBlocks(blocks: BlockStats[]): Set<number> {
  const adBlocks = new Set<number>();
  blocks.forEach((block) => {
    if (isAdBlock(block)) adBlocks.add(block.id);
  });

  // 被两侧长内容夹住的短块（无 CUE / 无 URL 特征的中插广告）
  blocks.forEach((block, index) => {
    if (adBlocks.has(block.id)) return;
    if (block.duration <= 0 || block.duration > SANDWICHED_AD_SECONDS) return;
    const prev = index > 0 ? blocks[index - 1] : null;
    const next = index < blocks.length - 1 ? blocks[index + 1] : null;
    // 只处理"中插"：首块可能是片头、末块可能是片尾，不做无依据的删除
    if (!prev || !next) return;
    if (
      prev.duration >= block.duration * SANDWICHED_CONTENT_RATIO &&
      next.duration >= block.duration * SANDWICHED_CONTENT_RATIO
    ) {
      adBlocks.add(block.id);
    }
  });

  return adBlocks;
}

/**
 * 应用守卫并输出结果。
 *
 * 三个兜底：不许删光、删除占比不超过 50%、真的删了才返回新播放列表。
 */
function finalizeAdRemoval(
  content: string,
  analyzed: AnalyzedPlaylist,
  adBlocks: Set<number>,
  source: RemovalSource,
  detail?: string
): string {
  let removedDuration = 0;
  let removedSegments = 0;
  analyzed.blocks.forEach((block) => {
    if (!adBlocks.has(block.id)) return;
    removedDuration += block.duration;
    removedSegments += block.segmentCount;
  });

  let reason: RemovalReason = 'no-ad-block';
  if (adBlocks.size > 0) {
    reason = 'filtered';
    if (removedSegments === 0) reason = 'no-ad-block';
    else if (removedSegments >= analyzed.totalSegments) {
      reason = 'would-remove-all';
    } else if (
      analyzed.totalDuration > 0 &&
      removedDuration / analyzed.totalDuration > MAX_REMOVED_RATIO
    ) {
      reason = 'ratio-guard';
    }
  }

  const suffix = detail ? `（${detail}）` : '';
  const signature =
    `${reason}|${source}|${analyzed.totalSegments}|${removedSegments}|` +
    `${Math.round(analyzed.totalDuration)}|${Math.round(removedDuration)}`;
  if (shouldLog(signature)) {
    if (reason === 'filtered') {
      const how =
        source === 'profile'
          ? '媒体参数'
          : source === 'mixed'
          ? '结构特征+媒体参数'
          : '结构特征';
      // 只有真的删了东西才用 info，便于用户确认去广告生效
      // eslint-disable-next-line no-console
      console.info(
        `[ad-filter] 已移除 ${adBlocks.size} 个广告块（${how}命中${suffix}）：` +
          `${removedSegments}/${analyzed.totalSegments} 段，约 ${formatSeconds(
            removedDuration
          )}（总长 ${formatSeconds(analyzed.totalDuration)}）`
      );
    } else {
      // 未命中广告是常态：降到 debug，默认控制台不显示
      // eslint-disable-next-line no-console
      console.debug(
        `[ad-filter] 未发现可识别广告（${analyzed.blocks.length} 个块 / ` +
          `${analyzed.totalSegments} 段，总长 ${formatSeconds(
            analyzed.totalDuration
          )}）${suffix}`
      );
    }
  }

  if (reason !== 'filtered') return content;

  const kept: string[] = [];
  for (const token of analyzed.tokens) {
    if (token.kind === 'segment' && adBlocks.has(token.blockId)) continue;
    kept.push(...token.lines);
  }
  return kept.join('\n');
}

/**
 * 从点播 HLS 播放列表中移除广告分片（结构特征）。
 *
 * @returns 过滤后的播放列表；无法安全判定时原样返回
 */
export function stripAdSegmentsFromM3U8(content: string): string {
  if (!content) return content;
  // 只读不写：结构特征看不到「重新编码拼接」的广告，如果让它抢先写入结论，
  // 后面的媒体参数探测就再也没机会纠正了。
  const decided = readDecision(content);
  if (decided !== null) return decided;
  const analyzed = analyzePlaylist(content);
  if (!analyzed) return content;
  const adBlocks = detectStructuralAdBlocks(analyzed.blocks);
  return finalizeAdRemoval(content, analyzed, adBlocks, 'structural');
}

export interface ProfileAdFilterOptions {
  /**
   * 播放列表地址；用来把相对分片地址解析成绝对地址。
   * 缺省时只探测本身就是绝对地址的分片。
   */
  baseUrl?: string;
  /** 自定义探测函数（测试注入）；默认走 Range 请求读取分片头 */
  probe?: (absoluteUrl: string) => Promise<MediaProfile | null>;
  /** 探测并发，默认 12 */
  concurrency?: number;
  /** 整轮探测的总时间预算（毫秒），默认 6s；超时的块按「未知」处理 */
  budgetMs?: number;
  /** 判定正文参数的最低占比，默认 0.6 */
  minDominantRatio?: number;
  /** 参与探测的块数上限，超过则跳过探测 */
  maxProbeBlocks?: number;
}

/**
 * 给 Promise 套一个「到点就走」的时限。
 *
 * 底层请求（fetch / 缓存读取）不跟着取消也没关系，它自己的超时会收尾；
 * 播放列表解析不能为了等它把首帧拖住。
 */
function withDeadline<T>(task: Promise<T>, ms: number): Promise<T | null> {
  if (!(ms > 0)) return Promise.resolve(null);
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/** 相对地址按播放列表地址解析；解析失败返回 null（跳过该块探测） */
function absoluteSegmentUrl(uri: string, baseUrl?: string): string | null {
  if (!uri) return null;
  try {
    return baseUrl ? new URL(uri, baseUrl).href : new URL(uri).href;
  } catch {
    return null;
  }
}

/**
 * 从点播 HLS 播放列表中移除广告分片（结构特征 + 分片媒体参数）。
 *
 * 两套规则**互补取并集**，不是二选一：结构特征只用来确定"这批块是广告"，
 * 并不会因此跳过对剩余块的媒体参数探测——同一集里完全可能既有带
 * `CUE-OUT` 标记的片头贴片广告，又有重新编码后拼进来的中插广告
 * （编码参数与正文不同）。所以流程是：
 *
 *  1. 结构特征先圈出已知广告块（这些块不再参与探测）；
 *  2. 其余块按 `#EXT-X-DISCONTINUITY` 逐块读首分片头的 SPS，
 *     与「正文参数」（出现最多的宽高 + 帧率）不一致的也判为广告；
 *  3. 两次结果取并集，再统一套"不许删光 / 不超 50%"守卫。
 *
 * 广告块的一个前提：广告是**整块**拼接的（采集站实际做法），块内首分片的
 * 参数就能代表整块；首分片与正文一致的中途切换不做猜测。
 *
 * @returns 过滤后的播放列表；探测失败 / 样本不足时只保留结构特征结论
 */
export async function stripAdSegmentsByMediaProfile(
  content: string,
  options: ProfileAdFilterOptions = {}
): Promise<string> {
  if (!content) return content;
  // 已经判定过（且真的删了东西）的同一份列表：直接复用，不再探测
  const decided = readDecision(content);
  if (decided !== null) {
    if (shouldLog(`reuse|${contentFingerprint(content)}`)) {
      // eslint-disable-next-line no-console
      console.debug(
        '[ad-filter] 复用上一轮判定结论（同一份列表，不再探测分片）'
      );
    }
    return decided;
  }
  const output = await computeStrippedByMediaProfile(content, options);
  if (output !== content) rememberDecision(content, output);
  return output;
}

/** 实际判定流程：结构特征与分片媒体参数取并集（见上方函数注释） */
async function computeStrippedByMediaProfile(
  content: string,
  options: ProfileAdFilterOptions = {}
): Promise<string> {
  const analyzed = analyzePlaylist(content);
  if (!analyzed) return content;

  const structural = detectStructuralAdBlocks(analyzed.blocks);

  /** 探测没给出结论时，退回"只按结构特征删"（没有命中就原样返回） */
  const finishWithoutProbe = (detail?: string) =>
    finalizeAdRemoval(
      content,
      analyzed,
      structural,
      structural.size > 0 ? 'structural' : 'none',
      detail
    );

  const maxProbeBlocks = options.maxProbeBlocks ?? MAX_PROFILE_PROBE_BLOCKS;
  const candidates = analyzed.blocks.filter(
    (block) =>
      // 结构特征判定的广告块已经要删了，不必再为它们发请求
      !structural.has(block.id) &&
      block.segmentCount > 0 &&
      block.duration > 0 &&
      block.duration <= MAX_AD_BLOCK_SECONDS
  );
  // 剩余块太少/太多都不足以做统计判断，只保留结构特征结论
  if (candidates.length < 3 || candidates.length > maxProbeBlocks) {
    return finishWithoutProbe();
  }

  const probe =
    options.probe ??
    ((absoluteUrl: string) => probeSegmentProfile(absoluteUrl));
  const concurrency = options.concurrency ?? PROFILE_PROBE_CONCURRENCY;
  const deadline = Date.now() + (options.budgetMs ?? PROFILE_PROBE_BUDGET_MS);
  /**
   * 探测一个块的编码参数。
   *
   * 按顺序试块内前 `PROBE_SEGMENTS_PER_BLOCK` 个分片：首分片 404 / 读不到头时
   * 换下一个再试（同块同编码，判定结论不变）。每次尝试都重新检查时间预算，
   * 超预算立刻放弃，不会为了重试把播放列表解析拖住。
   */
  const probeBlock = async (block: BlockStats) => {
    const targets = block.uris
      .slice(0, PROBE_SEGMENTS_PER_BLOCK)
      .map((uri) => absoluteSegmentUrl(uri, options.baseUrl))
      .filter(
        (url): url is string => typeof url === 'string' && url.length > 0
      );
    for (const target of targets) {
      const remaining = deadline - Date.now();
      // 已经超预算：不再发起新请求，也不等它
      if (remaining <= 0) return null;
      const profile = await withDeadline(
        probe(target).catch(() => null),
        remaining
      );
      if (profile) return { block, profile };
    }
    return null;
  };

  /**
   * 先探一小批再决定要不要铺开：反盗链 / 无 CORS 的源每次探测都会失败，
   * 前几个全空就没必要再发几十个注定失败的请求（浏览器控制台会刷一屏报错）。
   */
  const warmup = candidates.slice(0, PROFILE_WARMUP_BLOCKS);
  const warmupEntries = await mapWithConcurrency(
    warmup,
    Math.min(concurrency, warmup.length),
    probeBlock
  );
  if (warmupEntries.every((entry) => entry === null)) {
    return finishWithoutProbe('分片媒体参数不可读');
  }
  const restEntries =
    candidates.length > PROFILE_WARMUP_BLOCKS
      ? await mapWithConcurrency(
          candidates.slice(PROFILE_WARMUP_BLOCKS),
          concurrency,
          probeBlock
        )
      : [];
  const entries = [...warmupEntries, ...restEntries];

  /**
   * 样本覆盖率守卫。
   *
   * `resolveDominantProfile` 只统计「真正读到参数」的块，探测挂起或失败的块
   * 不参与投票。如果只成功了三五个块，就可能出现「两个广告块 + 一个正文块」
   * 这样的畸形样本，把广告认成正文、反手删掉正文。因此要求至少一半的块
   * 读到参数（且不少于 3 个），否则这轮不做任何删除。
   */
  const probedCount = entries.filter((entry) => entry !== null).length;
  const minSamples = Math.max(3, Math.ceil(candidates.length * 0.5));
  if (probedCount < minSamples) {
    return finishWithoutProbe(
      `媒体参数样本不足（${probedCount}/${candidates.length}）`
    );
  }

  const dominant = resolveDominantProfile(
    entries.map((entry) => ({
      profile: entry?.profile ?? null,
      weight: entry ? 1 : 0,
    })),
    options.minDominantRatio ?? MIN_DOMINANT_RATIO
  );
  if (!dominant) {
    return finishWithoutProbe('媒体参数样本不足');
  }

  const dominantKey = mediaProfileKey(dominant.profile);
  const profileBlocks = new Set<number>();
  const adProfiles = new Set<string>();
  entries.forEach((entry) => {
    if (!entry) return;
    // 宽高相同但帧率不同（正文 25fps / 广告 30fps）同样算另一套编码
    if (sameMediaProfile(entry.profile, dominant.profile)) return;
    profileBlocks.add(entry.block.id);
    adProfiles.add(mediaProfileKey(entry.profile));
  });

  // 两套规则的结论取并集：结构特征命中 + 媒体参数命中
  const adBlocks = new Set<number>(structural);
  profileBlocks.forEach((id) => adBlocks.add(id));

  if (adBlocks.size === 0) {
    return finalizeAdRemoval(content, analyzed, adBlocks, 'none');
  }

  const source: RemovalSource =
    structural.size > 0 && profileBlocks.size > 0
      ? 'mixed'
      : profileBlocks.size > 0
      ? 'profile'
      : 'structural';
  const details: string[] = [];
  if (structural.size > 0) details.push(`结构特征 ${structural.size} 块`);
  if (profileBlocks.size > 0) {
    details.push(
      `正文 ${dominantKey}，广告 ${Array.from(adProfiles).join(' / ')}`
    );
  }

  return finalizeAdRemoval(
    content,
    analyzed,
    adBlocks,
    source,
    details.join('；')
  );
}
