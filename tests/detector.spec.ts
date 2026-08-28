/**
 * LoopDetector 单元测试（移植自 ollama-loop-guard test_loop_detector.py，9/9）。
 * 运行：pnpm vitest run tests/detector.spec.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { LoopDetector, type DetectorConfig } from '../src/detector.ts'

const cfg: DetectorConfig = {
  reasoning_char_limit: 20000,
  content_repeat_span_min: 100,
  repeat_span_min: 24,
  max_total_sec: 120,
  max_reasoning_sec: 60,
  block_repeat_min: 100,
  block_repeat_count: 3,
  line_repeat_min: 10,
  line_repeat_count: 2,
}

describe('LoopDetector', () => {
  it('detects reasoning repetition', () => {
    const det = new LoopDetector(cfg)
    const chunk = '我们需要继续深入分析问题 '.repeat(10)
    expect(det.checkReasoning(chunk)).toBe('reasoning repetition')
  })

  it('does not false-positive on normal text', () => {
    const det = new LoopDetector(cfg)
    const text = '用户要求写一段中文说明，解释天空为什么是蓝色的。这涉及瑞利散射：大气中的分子与阳光相互作用，'
      + '波长较短的蓝光被散射得最多，因此从地面看天空呈现蓝色。需要解释得简单直接，避免复杂术语。'
    expect(det.checkReasoning(text)).toBeNull()
  })

  it('does not flag punctuation noise', () => {
    const det = new LoopDetector(cfg)
    expect(det.checkReasoning('。，。，。，。，。，。，。，。，。，。，。，。，。，。，。，。，。，。，。，')).toBeNull()
  })

  it('flags repetition with interleaved punctuation', () => {
    const det = new LoopDetector(cfg)
    const chunk = '我们需要继续深入分析！我们需要继续深入分析？我们需要继续深入分析。我们需要继续深入分析；'
      + '我们需要继续深入分析、我们需要继续深入分析——我们需要继续深入分析：我们需要继续深入分析。'
    expect(det.checkReasoning(chunk)).toBe('reasoning repetition')
  })

  it('detects reasoning overflow', () => {
    const det = new LoopDetector(cfg)
    expect(det.checkReasoning('x'.repeat(cfg.reasoning_char_limit + 10))).toBe('reasoning overflow')
  })

  it('detects content repetition', () => {
    const det = new LoopDetector(cfg)
    expect(det.checkContent('同样的内容反复输出 '.repeat(30))).toBe('content repetition')
  })

  it('detects reasoning stall', () => {
    const det = new LoopDetector(cfg)
    expect(det.checkElapsed(cfg.max_reasoning_sec + 5, false)).toBe('reasoning stall (60s, no output)')
  })

  it('detects total timeout', () => {
    const det = new LoopDetector(cfg)
    expect(det.checkElapsed(cfg.max_total_sec + 5, true)).toBe('total timeout (120s)')
  })

  it('does not stall when content is present', () => {
    const det = new LoopDetector(cfg)
    expect(det.checkElapsed(cfg.max_reasoning_sec + 5, true)).toBeNull()
  })

  it('detects the real-world long-range block loop', () => {
    // A real degenerate loop: a large analysis block recurs verbatim ~3× with
    // different text in between. The reference tight-loop heuristics miss this;
    // the long-range block-repeat rule must catch it.
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(join(here, 'real_loop.txt'), 'utf8')
    const det = new LoopDetector(cfg)
    expect(det.checkReasoning(text)).toBe('reasoning repetition')
  })

  it('does not flag a single long analysis block', () => {
    // The same block appearing ONCE (no recurrence) must not be flagged.
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(join(here, 'real_loop.txt'), 'utf8')
    const single = text.slice(0, text.indexOf('等等，我重新算一下。单 chunk finalDensity 0.05μs/pt，8 chunk 4.32μs/pt。但纯树 0.93μs/pt 1 和 8 chunk 一样。', 1))
    const det = new LoopDetector(cfg)
    expect(det.checkReasoning(single)).toBeNull()
  })

  it('detects a single-think-string sentence-cycle loop', () => {
    // A loop of ~8 distinct sentences cycling within ONE think string.
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(join(here, 'real_loop3.txt'), 'utf8')
    const det = new LoopDetector(cfg)
    expect(det.checkReasoning(text)).toBe('reasoning repetition')
  })

  it('detects line-level repetition (same sentence recurs verbatim)', () => {
    // A single think string where one sentence recurs verbatim — the line-repeat rule.
    const text = '让我先配置 seed + beard.dump，然后跑 gradle runServer。\n'
      + '考虑到这是大工程，让我先改 level-seed。\n'
      + '让我先配置 seed + beard.dump，然后跑 gradle runServer。\n'
      + '但需要找含结构区域。\n'
      + '让我先配置 seed + beard.dump，然后跑 gradle runServer。'
    const det = new LoopDetector(cfg)
    expect(det.checkReasoning(text)).toBe('reasoning repetition')
  })

  it('does not flag a normal multi-line analysis', () => {
    // A normal analysis with no repeated lines must not be flagged.
    const text = '用户要求解释天空为什么是蓝色的。\n'
      + '这涉及瑞利散射：大气中的分子与阳光相互作用。\n'
      + '波长较短的蓝光被散射得最多，因此从地面看天空呈现蓝色。\n'
      + '需要解释得简单直接，避免复杂术语。'
    const det = new LoopDetector(cfg)
    expect(det.checkReasoning(text)).toBeNull()
  })
})
