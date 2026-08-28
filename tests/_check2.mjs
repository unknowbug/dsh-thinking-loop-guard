import { readFileSync } from 'node:fs'
import { LoopDetector } from '../lib/detector.js'

const cfg = {
  reasoning_char_limit: 20000,
  content_repeat_span_min: 100,
  repeat_span_min: 24,
  max_total_sec: 120,
  max_reasoning_sec: 60,
  block_repeat_min: 100,
  block_repeat_count: 3,
}

const text = readFileSync('E:/PYTHON/dsh-thinking-loop-guard/tests/real_loop2.txt', 'utf8')
// 取第一个循环周期（到第二次出现 S1 为止）
const s1 = '但用户说"跑"，我应该尝试。让我先配置 seed + beard.dump，然后跑 gradle runServer。'
const firstCycle = text.slice(0, text.indexOf(s1, 1))
const det = new LoopDetector(cfg)
console.log('first cycle len:', firstCycle.length)
console.log('first cycle checkReasoning:', det.checkReasoning(firstCycle))
