/**
 * Detects degenerate repetition in LLM output — the failure mode where a weak
 * model repeats the same sentence/line many times instead of acting or ending.
 *
 * Pure and side-effect free so it can guard both streamed and completed replies.
 * The signal is intentionally conservative: a segment must repeat many times AND
 * dominate the output, so ordinary text (or a few repeated code/data lines) is
 * never flagged.
 */

export interface RepetitionOptions {
  /** Minimum normalized segment length to count (ignore trivial fragments). */
  minSegmentLength?: number;
  /** How many times one segment may repeat before it counts as degenerate. */
  maxRepeats?: number;
  /** Fraction of counted segments the top segment must occupy (0–1). */
  dominance?: number;
}

const DEFAULT_MIN_SEGMENT_LENGTH = 12;
const DEFAULT_MAX_REPEATS = 4;
const DEFAULT_DOMINANCE = 0.5;

/** Split on line breaks and after sentence terminators (ASCII + CJK). */
const SEGMENT_SPLIT_RE = /[\r\n]+|(?<=[。！？.!?])/;

function normalize(segment: string): string {
  return segment.replace(/\s+/g, ' ').trim();
}

/** Count occurrences of each non-trivial normalized segment. */
function segmentCounts(text: string, minLength: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.split(SEGMENT_SPLIT_RE)) {
    const seg = normalize(raw);
    if (seg.length < minLength) continue;
    counts.set(seg, (counts.get(seg) ?? 0) + 1);
  }
  return counts;
}

/**
 * True when the text has degenerated into repetition: some segment repeats at
 * least `maxRepeats` times and makes up at least `dominance` of all counted
 * segments.
 */
export function detectDegenerateRepetition(text: string, opts: RepetitionOptions = {}): boolean {
  if (!text) return false;
  const minLength = opts.minSegmentLength ?? DEFAULT_MIN_SEGMENT_LENGTH;
  const maxRepeats = opts.maxRepeats ?? DEFAULT_MAX_REPEATS;
  const dominance = opts.dominance ?? DEFAULT_DOMINANCE;

  let total = 0;
  let top = 0;
  for (const count of segmentCounts(text, minLength).values()) {
    total += count;
    if (count > top) top = count;
  }
  if (total === 0) return false;
  return top >= maxRepeats && top / total >= dominance;
}

/**
 * Stateful guard for streaming output. Feed deltas as they arrive; once
 * repetition is detected the guard latches so the caller can abort the stream.
 */
export class RepetitionGuard {
  private buffer = '';
  private tripped = false;

  constructor(private readonly opts: RepetitionOptions = {}) {}

  /** Feed a streamed chunk; returns true once degeneration is detected (latched). */
  push(chunk: string): boolean {
    if (this.tripped) return true;
    this.buffer += chunk;
    // Repetition is dense, so the tail is enough — bound memory on long replies.
    if (this.buffer.length > 20_000) this.buffer = this.buffer.slice(-20_000);
    if (detectDegenerateRepetition(this.buffer, this.opts)) this.tripped = true;
    return this.tripped;
  }

  get degenerated(): boolean {
    return this.tripped;
  }
}
