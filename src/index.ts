/**
 * @dsh-external/dsh-thinking-loop-guard — 思维链循环检测与打断插件。
 *
 * 机制（无中间代理）：
 * 1. **实时可见输出检测**（核心）：订阅 `session/event` 的 `assistant/chunk`，累积当前
 *    step 的可见 content（text-delta），实时检测重复。命中 → `agent.steer()` 打断。
 *    这能抓到"tickticktick…"这类**单次输出内**的可见循环（turn-stopping 抓不到，
 *    因为循环发生时 turn 还没结束）。
 * 2. **turn 结束检测**：`agent/turn-stopping` 时读最新 assistant 消息的 reasoning，
 *    检测思维链循环（单 think 串内）。
 * 3. 按 turn 计数重试（key = `${agentId}:${turn}`），超过 max_retries 放弃。
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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from 'schemastery'
import { LoopDetector, type DetectorConfig } from './detector.ts'

export const name = '@dsh-external/dsh-thinking-loop-guard'

export interface Config extends DetectorConfig {
  enabled: boolean
  max_retries: number
  intervention: string
  /** 升级时把该 turn 后续请求的推理强度降到这个档位（思维链仍开启）。 */
  escalation_reasoning_effort: 'off' | 'low' | 'high' | 'max'
  /** 实时可见输出检测：累积多少字符后开始检测。 */
  stream_min_chars: number
  /** 工具调用循环：同一 step 内同一工具调用超过该次数 → 判循环。 */
  max_repeated_tool_calls: number
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
  stream_min_chars: z.number().default(200),
  max_repeated_tool_calls: z.number().default(5),
  intervention: z.string().default('检测到重复推理，请停止循环，直接给出最终答案。'),
  escalation_reasoning_effort: z.union(['off', 'low', 'high', 'max']).default('low'),
})

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-thinking-loop-guard' }

/** 第二次及以后的升级干预（第一次用 config.intervention）。 */
const ESCALATION = '再次检测到重复推理：立即停止分析，直接给出最终答案。不要重新计算或重新分析，直接输出结论；若确实无法解决，请直接说明。'

export function apply(ctx: Context, config: Config): void {
  // 每个 turn 独立计数（key = `${agentId}:${turn}`），steer 后同一 turn 继续累加。
  const retries = new Map<string, number>()
  // 已升级的 turn：后续请求降低推理强度（思维链仍开启）。
  const reduceEffort = new Set<string>()
  // session.id -> agent 映射（session/event 是全局的，需反查 agent）。
  const sessionToAgent = new Map<string, Agent>()
  // 当前 step 的可见 content 累积（key = `${agentId}:${turn}:${step}`）。
  const streamContent = new Map<string, string>()
  // 当前 step 的工具调用计数（key = `${agentId}:${turn}:${step}:${toolName}`）。
  const toolCalls = new Map<string, number>()

  // agent/request 是 waterfall：await next() 拿到默认 config，返回替换值。
  ctx.on('agent/request', async ({ agent, turn }, next) => {
    const key = `${agent.id}:${turn}`
    if (!reduceEffort.has(key)) return next()
    const cfg = await next()
    return {
      ...cfg,
      reasoningEffort: ReasoningEffortId(config.escalation_reasoning_effort),
    }
  })

  // 建立 session -> agent 映射。
  ctx.on('agent/created', ({ agent }) => {
    sessionToAgent.set(agent.session.id, agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    sessionToAgent.delete(agent.session.id)
  })

  // 实时可见输出检测：累积 text-delta 检测文本重复；统计 tool-call 检测工具调用循环。
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!config.enabled) return
    if (event.type !== 'assistant/chunk') return
    const agent = sessionToAgent.get(session.id)
    if (!agent) return
    const chunk = event.data.chunk
    const { turn, step } = event.data

    // 工具调用循环：同一 step 内同一工具反复调用（如 job_output × 300）。
    if (chunk.type === 'tool-call-delta' && chunk.name) {
      const tkey = `${agent.id}:${turn}:${step}:${chunk.name}`
      const count = (toolCalls.get(tkey) ?? 0) + 1
      toolCalls.set(tkey, count)
      if (count >= config.max_repeated_tool_calls) {
        toolCalls.delete(tkey)
        intervene(ctx, agent, turn, `tool-call loop (${chunk.name} × ${count})`, retries, reduceEffort, config)
      }
      return
    }

    // 文本重复：累积 text-delta。
    if (chunk.type !== 'text-delta') return
    const key = `${agent.id}:${turn}:${step}`
    const buf = (streamContent.get(key) ?? '') + chunk.text
    streamContent.set(key, buf)
    if (buf.length < config.stream_min_chars) return

    const detector = new LoopDetector(config)
    const hit = detector.checkContent(buf)
    if (!hit) return
    // 命中 → 打断。清空累积，避免重复触发。
    streamContent.delete(key)
    intervene(ctx, agent, turn, hit, retries, reduceEffort, config)
  })

  // turn 结束检测：读最新 assistant 消息的 reasoning（单 think 串）。
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
    if (reason) intervene(ctx, agent, turn, reason, retries, reduceEffort, config)
  })
}

/** 命中循环 → 按重试计数 steer 干预（或放弃）。 */
function intervene(
  ctx: Context,
  agent: Agent,
  turn: number,
  reason: string,
  retries: Map<string, number>,
  reduceEffort: Set<string>,
  config: Config,
): void {
  const key = `${agent.id}:${turn}`
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
}

/**
 * 取当前 turn 最新 assistant 消息的 reasoning/content 文本。
 * 循环几乎都发生在单个 think 串（单条 assistant 消息）内，所以只检测最新一条。
 * 用 surface.nodes 枚举模型可见顺序（倒序找最新），直接读 event.data.message。
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
