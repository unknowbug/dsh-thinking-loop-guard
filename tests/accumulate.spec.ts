/**
 * 验证跨多条 assistant 消息的循环能被累加后检测到。
 * 真实场景：循环被拆成多个 step/assistant 消息（每条只含一个循环周期），
 * 只读最新一条抓不到；累加整个 turn 的 reasoning 后，跨 step 的重复可见。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { accumulateTurnText } from '../src/index.ts'
import { LoopDetector, type DetectorConfig } from '../src/detector.ts'

const cfg: DetectorConfig = {
  reasoning_char_limit: 20000,
  content_repeat_span_min: 100,
  repeat_span_min: 24,
  max_total_sec: 120,
  max_reasoning_sec: 60,
  block_repeat_min: 100,
  block_repeat_count: 3,
}

function assistantEvent(seq: number, turn: number, step: number, reasoning: string) {
  return {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: { turn, step, message: { content: [{ type: 'reasoning', text: reasoning }] } },
    surfaceOp: 'append',
  }
}

describe('accumulateTurnText', () => {
  it('catches a loop split across multiple assistant messages', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(join(here, 'real_loop2.txt'), 'utf8')
    const s1 = '但用户说"跑"，我应该尝试。让我先配置 seed + beard.dump，然后跑 gradle runServer。'
    // 每个循环周期 = S1 S2 S3 S4，作为一条 assistant 消息
    const cycles = text.split(s1).slice(1).map(p => s1 + p)
    expect(cycles.length).toBeGreaterThanOrEqual(3)

    const events = cycles.map((c, i) => assistantEvent(i, 1, i + 1, c))
    const nodes = events.map(e => e.seq)
    const { reasoning } = accumulateTurnText(events, nodes, 1)

    const det = new LoopDetector(cfg)
    expect(det.checkReasoning(reasoning)).toBe('reasoning repetition')
  })

  it('does not flag a single-cycle turn', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(join(here, 'real_loop2.txt'), 'utf8')
    const s1 = '但用户说"跑"，我应该尝试。让我先配置 seed + beard.dump，然后跑 gradle runServer。'
    const single = s1 + text.split(s1)[1] // 只取第一个周期
    const events = [assistantEvent(0, 1, 1, single)]
    const { reasoning } = accumulateTurnText(events, [0], 1)
    const det = new LoopDetector(cfg)
    expect(det.checkReasoning(reasoning)).toBeNull()
  })
})
