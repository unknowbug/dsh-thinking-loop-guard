/**
 * @dsh-external/dsh-thinking-loop-guard — 思维链循环检测与打断插件。
 *
 * 机制（turn 级，无中间代理）：
 * - 订阅 `agent/turn-stopping`（serial 事件，turn 即将关闭时触发）。
 * - 此时当前 turn 的 assistant 消息已落盘，reasoning 完整可读。
 * - 用 `agent.session.surface.nodes` 枚举模型可见消息，读最新 assistant 消息的
 *   reasoning/content 文本，跑 LoopDetector（移植自 ollama-loop-guard，MIT）。
 * - 命中循环 → `agent.steer()` 注入干预消息，机器重读 inbox 继续同一 turn 再跑一步。
 * - 按 turn 计数重试（key = `${agentId}:${turn}`），超过 max_retries 放弃，让 turn 正常结束。
 *
 * 升级干预（不关闭思维链）：
 * - 第一次：steer 一条干预消息。
 * - 第二次及以后：steer 更强硬的升级消息，并经由 `agent/request` waterfall 把该 turn
 *   后续请求的 `reasoningEffort` 降到 `escalation_reasoning_effort`（默认 `low`）。
 *   思维链保持开启，只是变浅——浅推理更不容易陷入深循环，同时不牺牲正常推理能力。
 *
 * 资源注册挂 ctx.effect（热重载/卸载自动清理）。
 */
import type { Context } from 'cordis'
import {
  createUserMessage,
  ReasoningEffortId,
  type MessageSource,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from 'schemastery'
import { LoopDetector, type DetectorConfig } from './detector.ts'

export const name = '@dsh-external/dsh-thinking-loop-guard'

export interface Config extends DetectorConfig {
  enabled: boolean
  max_retries: number
  intervention: string
  /** 升级时把该 turn 后续请求的推理强度降到这个档位（思维链仍开启）。 */
  escalation_reasoning_effort: 'off' | 'low' | 'high' | 'max'
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  max_reasoning_sec: z.number().default(60),
  max_total_sec: z.number().default(120),
  max_retries: z.number().default(2),
  reasoning_char_limit: z.number().default(20000),
  repeat_span_min: z.number().default(24),
  content_repeat_span_min: z.number().default(100),
  block_repeat_min: z.number().default(100),
  block_repeat_count: z.number().default(3),
  line_repeat_min: z.number().default(10),
  line_repeat_count: z.number().default(2),
  intervention: z.string().default('检测到重复推理，请停止循环，直接给出最终答案。'),
  escalation_reasoning_effort: z.union(['off', 'low', 'high', 'max']).default('low'),
})

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-thinking-loop-guard' }

/** 第二次及以后的升级干预（第一次用 config.intervention）。 */
const ESCALATION = '再次检测到重复推理：立即停止分析，直接给出最终答案。不要重新计算或重新分析，直接输出结论；若确实无法解决，请直接说明。'

export function apply(ctx: Context, config: Config): void {
  // 每个 turn 独立计数（key = `${agentId}:${turn}`），steer 后同一 turn 继续累加，
  // 新 turn 自然归零；turn 关闭（未命中或放弃）时删除，map 只保留进行中的 turn。
  const retries = new Map<string, number>()
  // 已升级的 turn：后续请求降低推理强度（思维链仍开启）。
  const reduceEffort = new Set<string>()

  // agent/request 是 waterfall：await next() 拿到默认 config，返回替换值。
  // 对已升级的 turn，把 reasoningEffort 降到配置档位（不关闭 thinking）。
  ctx.on('agent/request', async ({ agent, turn }, next) => {
    const key = `${agent.id}:${turn}`
    if (!reduceEffort.has(key)) return next()
    const cfg = await next()
    return {
      ...cfg,
      reasoningEffort: ReasoningEffortId(config.escalation_reasoning_effort),
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    if (!config.enabled) return
    const latest = latestAssistantMessage(agent, turn)
    if (!latest) return

    const detector = new LoopDetector(config)
    const hit = detector.checkReasoning(latest.reasoning) ?? detector.checkContent(latest.content)
    const turnStart = agent.session.events.findLast(
      e => e.type === 'turn/start' && e.data.turn === turn,
    )?.time
    const elapsed = turnStart === undefined ? 0 : (Date.now() - turnStart) / 1000
    const reason = hit ?? detector.checkElapsed(elapsed, latest.content.length > 0)
    ctx.logger.debug(
      `[thinking-loop-guard] turn=${turn} reasoning=${latest.reasoning.length} content=${latest.content.length} reason=${reason ?? 'none'}`,
    )

    const key = `${agent.id}:${turn}`
    if (!reason) {
      retries.delete(key)
      reduceEffort.delete(key)
      return
    }

    const attempts = retries.get(key) ?? 0
    if (attempts >= config.max_retries) {
      retries.delete(key)
      reduceEffort.delete(key)
      ctx.logger.warn(`[thinking-loop-guard] give up after ${attempts} retries (${reason})`)
      return
    }

    retries.set(key, attempts + 1)
    // 第二次及以后升级：降低该 turn 后续请求的推理强度（思维链仍开启）。
    if (attempts >= 1) reduceEffort.add(key)
    const text = attempts === 0 ? config.intervention : ESCALATION
    ctx.logger.info(`[thinking-loop-guard] ${reason} -> steer (attempt ${attempts + 1}/${config.max_retries})`)
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
  })
}

/**
 * 取当前 turn 最新 assistant 消息的 reasoning/content 文本。
 *
 * 关键：循环几乎都发生在**单个 think 串（单条 assistant 消息）内**，所以只检测最新一条
 * 消息的 reasoning 即可。不要累加整个 turn——那会把正常的多步思考（等待后台任务、汇报）
 * 误判成循环（实测误伤）。
 *
 * 用 surface.nodes 枚举模型可见顺序（倒序找最新），直接读 event.data.message
 * （而非 deriveEventMessage，因为空 content 的 assistant 消息会被投影为 null，
 * 而循环检测恰恰需要空 content 时的 reasoning）。
 */
function latestAssistantMessage(
  agent: Agent,
  turn: number,
): { reasoning: string; content: string } | null {
  const events = agent.session.events
  for (const seq of [...agent.session.surface.nodes].reverse()) {
    const event = events[seq]
    if (event?.type !== 'assistant/message') continue
    if (event.data.turn !== turn) continue
    const message = event.data.message
    const reasoning = message.content
      .filter((b): b is Extract<typeof b, { type: 'reasoning' }> => b.type === 'reasoning')
      .map(b => b.text)
      .join('')
    const content = message.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('')
    return { reasoning, content }
  }
  return null
}
