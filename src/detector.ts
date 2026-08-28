/**
 * Turn-level thinking-loop detector.
 *
 * Adapted from ollama-loop-guard's `LoopDetector` (MIT, https://github.com/dustinmoon78/ollama-loop-guard).
 * The reference runs on streaming chunks and cuts the upstream mid-stream; DSH is
 * turn-level — reasoning is only complete at `agent/turn-stopping` — so this detector
 * runs on the FULL reasoning/content text of the latest assistant message instead.
 *
 * Detection rules:
 * 1. Literal long-repeat (reference): a unit of 8–200 chars repeated 2+ more times.
 * 2. Punctuation-variant repeat (reference): the same unit ≥3× with interleaved punctuation.
 * 3. **Long-range block repeat (added for DSH)**: a substantial normalized window
 *    (default 100 chars) appearing ≥`block_repeat_count` (default 3) times anywhere in
 *    the reasoning. The reference's tight-loop heuristics miss the real-world
 *    "re-analyze the same thing from scratch" loop, where a large reasoning block recurs
 *    verbatim with different text in between.
 * 4. **Line repeat (added for DSH)**: a normalized line (≥`line_repeat_min` chars) appearing
 *    ≥`line_repeat_count` times. Catches single-think-string sentence-cycle loops where the
 *    same sentence recurs verbatim (e.g. "让我先配置 seed + beard.dump，然后跑 gradle runServer").
 */

/** Detection thresholds (a subset of the plugin config). */
export interface DetectorConfig {
  /** Reasoning phase with zero visible content longer than this (seconds) → stall. */
  max_reasoning_sec: number
  /** Whole turn longer than this (seconds) → timeout. */
  max_total_sec: number
  /** Reasoning text longer than this (chars) → overflow. */
  reasoning_char_limit: number
  /** Minimum repeated-span length (chars) to flag reasoning repetition. */
  repeat_span_min: number
  /** Minimum repeated-span length (chars) to flag content repetition. */
  content_repeat_span_min: number
  /** Normalized window length (chars) for long-range block-repeat detection. */
  block_repeat_min: number
  /** How many times a block window must recur to flag long-range repetition. */
  block_repeat_count: number
  /** Minimum normalized line length (chars) for line-repeat detection. */
  line_repeat_min: number
  /** How many times a line must recur to flag line repetition. */
  line_repeat_count: number
}

/** Why a turn was judged to be looping. */
export type LoopHitReason =
  | 'reasoning repetition'
  | 'reasoning overflow'
  | 'content repetition'
  | `reasoning stall (${number}s, no output)`
  | `total timeout (${number}s)`

/** Punctuation/whitespace stripped when judging the "core" length of a repeated unit. */
const STRIP = /[\s，。、；：！？,.?!;:()\[\]{}<>"'`~\-—…\n\t\r]/g
/** Literal long-repeat: a unit of 8–200 chars repeated 2+ more times. */
const REP = /(.{8,200})\1{2,}/s
/** Variant repeat: the same unit ≥3× with interleaved punctuation ("think more!…?…."). */
const REP_VARIANT = /(.{6,100})[\s，。、；：！？,.?!;:()\[\]{}<>"'`~\-—…]{1,8}\1[\s，。、；：！？,.?!;:()\[\]{}<>"'`~\-—…]{1,8}\1/s

export class LoopDetector {
  constructor(private readonly cfg: DetectorConfig) {}

  /** Check complete reasoning text for repetition / overflow. */
  checkReasoning(text: string): LoopHitReason | null {
    if (text.length > this.cfg.reasoning_char_limit) return 'reasoning overflow'
    if (this.repeat(text, this.cfg.repeat_span_min)) return 'reasoning repetition'
    if (this.blockRepeat(text)) return 'reasoning repetition'
    if (this.lineRepeat(text)) return 'reasoning repetition'
    return null
  }

  /** Check complete visible content for repetition. */
  checkContent(text: string): LoopHitReason | null {
    if (this.repeat(text, this.cfg.content_repeat_span_min)) return 'content repetition'
    return null
  }

  /** Time-based checks: reasoning stall (no content) and total timeout. */
  checkElapsed(elapsedSec: number, hasContent: boolean): LoopHitReason | null {
    if (this.cfg.max_total_sec && elapsedSec > this.cfg.max_total_sec) {
      return `total timeout (${this.cfg.max_total_sec}s)`
    }
    if (this.cfg.max_reasoning_sec && !hasContent && elapsedSec > this.cfg.max_reasoning_sec) {
      return `reasoning stall (${this.cfg.max_reasoning_sec}s, no output)`
    }
    return null
  }

  /**
   * Windowed long-repeat detection over the trailing 4096 chars.
   * Literal repeats must survive punctuation-stripping with a core ≥5 chars;
   * otherwise the punctuation-variant pattern is consulted. A literal match
   * with a too-short core returns false (it does NOT fall through to the
   * variant pattern) — this is what keeps pure punctuation noise unflagged.
   */
  private repeat(text: string, spanMin: number): boolean {
    if (text.length < spanMin) return false
    const window = text.slice(-4096)
    const m = REP.exec(window)
    if (m) {
      const core = m[1].replace(STRIP, '')
      if (core.length < 5) return false
      return m[0].length >= spanMin
    }
    return REP_VARIANT.test(window)
  }

  /**
   * Long-range block-repeat detection: a normalized window of `block_repeat_min`
   * chars appearing ≥`block_repeat_count` times anywhere in the reasoning.
   * Catches the "re-analyze the same thing from scratch" loop where a large block
   * recurs verbatim with different text in between (the tight-loop heuristics miss it).
   */
  private blockRepeat(text: string): boolean {
    const { block_repeat_min: min, block_repeat_count: count } = this.cfg
    if (min <= 0 || count < 2) return false
    const core = text.replace(STRIP, '')
    if (core.length < min * count) return false
    const seen = new Map<string, number>()
    for (let i = 0; i + min <= core.length; i++) {
      const window = core.slice(i, i + min)
      const c = (seen.get(window) ?? 0) + 1
      if (c >= count) return true
      seen.set(window, c)
    }
    return false
  }

  /**
   * Line-repeat detection: split into lines, normalize each, and flag when a
   * line (≥`line_repeat_min` chars) appears ≥`line_repeat_count` times.
   * Catches single-think-string sentence-cycle loops where the same sentence
   * recurs verbatim (the block-window rule can miss these when the cycle has
   * only 2 recurrences or the window straddles sentence boundaries).
   */
  private lineRepeat(text: string): boolean {
    const { line_repeat_min: min, line_repeat_count: count } = this.cfg
    if (min <= 0 || count < 2) return false
    const seen = new Map<string, number>()
    for (const raw of text.split(/\n+/)) {
      const line = raw.replace(STRIP, '')
      if (line.length < min) continue
      const c = (seen.get(line) ?? 0) + 1
      if (c >= count) return true
      seen.set(line, c)
    }
    return false
  }
}
