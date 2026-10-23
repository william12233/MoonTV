/** Byte ranges use an exclusive end, matching hls.js. */
export interface SegmentByteRange {
  start: number;
  end: number;
}

export function normalizeByteRange(
  start: unknown,
  end: unknown
): SegmentByteRange | undefined {
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    return undefined;
  }
  return { start, end };
}

export function parseByteRange(
  value: string,
  implicitStart?: number
): SegmentByteRange {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  const start = match?.[2] === undefined ? implicitStart : Number(match[2]);
  const range = normalizeByteRange(start, Number(start) + Number(match?.[1]));
  if (!match || !range) throw new Error('Invalid HLS byte range');
  return range;
}

export function byteRangeHeader(range: SegmentByteRange): string {
  return `bytes=${range.start}-${range.end - 1}`;
}

/** Never store an entire file under a partial segment key. */
export async function readByteRangeResponse(
  response: Response,
  range?: SegmentByteRange
): Promise<ArrayBuffer> {
  if (range) {
    const contentRange = response.headers.get('Content-Range');
    const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i);
    if (
      response.status !== 206 ||
      (contentRange &&
        (!match ||
          Number(match[1]) !== range.start ||
          Number(match[2]) !== range.end - 1))
    ) {
      await response.body?.cancel();
      throw new Error('Server did not return the requested byte range');
    }
  }
  const buffer = await response.arrayBuffer();
  if (range && buffer.byteLength !== range.end - range.start) {
    throw new Error('Incomplete byte range response');
  }
  return buffer;
}
