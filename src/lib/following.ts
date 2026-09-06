import { PlayRecord } from './types';

export interface UnwatchedEpisodesInput {
  totalEpisodes: number;
  watchedEpisodes: number;
}

export function computeUnwatchedEpisodes({
  totalEpisodes,
  watchedEpisodes,
}: UnwatchedEpisodesInput): number {
  const safeTotal = Number.isFinite(totalEpisodes)
    ? Math.max(0, Math.floor(totalEpisodes))
    : 0;
  const safeWatched = Number.isFinite(watchedEpisodes)
    ? Math.max(0, Math.floor(watchedEpisodes))
    : 0;

  if (safeTotal <= 0) {
    return 0;
  }

  return Math.max(0, safeTotal - Math.min(safeWatched, safeTotal));
}

/**
 * 构建“标题 → 最新播放记录”的索引。
 *
 * 播放记录在写入时会删除同名的旧记录（同一部剧无论从哪个片源观看，同一时刻
 * 仅保留最近写入的一条），这里再从全量记录中挑选同一标题下 save_time 最新的一条。
 *
 * 追更页用该索引按标题回填“当前播放集数/总集数”，避免因用户换片源观看导致
 * 追更 key(source+id) 与播放记录 key 对不上而取不到记录；标题未命中时仍可回退
 * 到按 source+id 直查。
 */
export function buildPlayRecordTitleIndex(
  allPlayRecords: Record<string, PlayRecord>
): Map<string, PlayRecord> {
  const index = new Map<string, PlayRecord>();
  for (const record of Object.values(allPlayRecords)) {
    if (!record?.title) continue;
    const existing = index.get(record.title);
    if (!existing || (record.save_time ?? 0) >= (existing.save_time ?? 0)) {
      index.set(record.title, record);
    }
  }
  return index;
}
