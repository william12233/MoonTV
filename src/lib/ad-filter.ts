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
 *  3. 短块（≤ 90s）里部分分片带广告特征 URL。
 *
 * 安全性：
 *  - 仅处理含 `#EXT-X-ENDLIST` 的点播列表，直播列表原样返回；
 *  - 单块超过 5 分钟不判广告；
 *  - 剔除时长超过总时长 50%、或会把分片删光时放弃；
 *  - `#EXT-X-KEY` / `#EXT-X-MAP` 等标签永不删除。
 *
 * 排查：每次处理都会输出 `[ad-filter]` 日志，包含每个块的时长/分片数/
 * 广告窗分片数/判定结果与首个分片地址，可据此确认广告为什么没被识别。
 */

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
 * 从点播 HLS 播放列表中移除广告分片。
 *
 * @returns 过滤后的播放列表；无法安全判定时原样返回
 */
export function stripAdSegmentsFromM3U8(content: string): string {
  if (!content) return content;
  // 主播放列表没有分片，交给子播放列表处理，避免刷无意义的日志
  if (content.includes('#EXT-X-STREAM-INF')) return content;
  // 直播列表不做处理，也不打日志（每次刷新播放列表都会触发，纯噪音）
  if (!content.includes('#EXT-X-ENDLIST')) return content;

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

  const adBlocks = new Set<number>();
  blocks.forEach((block) => {
    if (isAdBlock(block)) adBlocks.add(block.id);
  });

  // 被两侧长内容夹住的短块（无 CUE / 无 URL 特征的中插广告）
  const ordered = Array.from(blocks.values())
    .filter((block) => block.segmentCount > 0)
    .sort((a, b) => a.id - b.id);
  ordered.forEach((block, index) => {
    if (adBlocks.has(block.id)) return;
    if (block.duration <= 0 || block.duration > SANDWICHED_AD_SECONDS) return;
    const prev = index > 0 ? ordered[index - 1] : null;
    const next = index < ordered.length - 1 ? ordered[index + 1] : null;
    // 只处理"中插"：首块可能是片头、末块可能是片尾，不做无依据的删除
    if (!prev || !next) return;
    if (
      prev.duration >= block.duration * SANDWICHED_CONTENT_RATIO &&
      next.duration >= block.duration * SANDWICHED_CONTENT_RATIO
    ) {
      adBlocks.add(block.id);
    }
  });

  let totalDuration = 0;
  let removedDuration = 0;
  let totalSegments = 0;
  let removedSegments = 0;
  blocks.forEach((block) => {
    totalDuration += block.duration;
    totalSegments += block.segmentCount;
    if (adBlocks.has(block.id)) {
      removedDuration += block.duration;
      removedSegments += block.segmentCount;
    }
  });

  let reason: RemovalReason = 'no-ad-block';
  if (adBlocks.size > 0) {
    reason = 'filtered';
    if (removedSegments === 0) reason = 'no-ad-block';
    else if (removedSegments >= totalSegments) reason = 'would-remove-all';
    else if (
      totalDuration > 0 &&
      removedDuration / totalDuration > MAX_REMOVED_RATIO
    ) {
      reason = 'ratio-guard';
    }
  }

  const signature =
    `${reason}|${totalSegments}|${removedSegments}|` +
    `${Math.round(totalDuration)}|${Math.round(removedDuration)}`;
  if (shouldLog(signature)) {
    if (reason === 'filtered') {
      // 只有真的删了东西才用 info，便于用户确认去广告生效
      // eslint-disable-next-line no-console
      console.info(
        `[ad-filter] 已移除 ${adBlocks.size} 个广告块：` +
          `${removedSegments}/${totalSegments} 段，约 ${formatSeconds(
            removedDuration
          )}（总长 ${formatSeconds(totalDuration)}）`
      );
    } else {
      // 未命中广告是常态：降到 debug，默认控制台不显示
      // eslint-disable-next-line no-console
      console.debug(
        `[ad-filter] 未发现可识别广告（${blocks.size} 个块 / ${totalSegments} 段，` +
          `总长 ${formatSeconds(totalDuration)}）`
      );
    }
  }

  if (reason !== 'filtered') return content;

  const kept: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'segment' && adBlocks.has(token.blockId)) continue;
    kept.push(...token.lines);
  }
  return kept.join('\n');
}
