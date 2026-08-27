# dsh-thinking-loop-guard

> 思维链循环检测与打断插件（DSH 内部实现，无中间代理）。

模型（如 `deepseek-v4-flash:0731`）偶尔陷入**思维链死循环**：`reasoning` 反复重复同一段分析，
长时间不产出可见内容，烧 token、卡住 agent。DSH 直连远程 API，没有中间层能检测并打断流式响应，
所以本插件在 **turn 边界**（`agent/turn-stopping`）读取完整 reasoning，检测循环并 `agent.steer()`
打断重输出。

## 问题背景

- 模型在推理阶段进入退化生成循环（reasoning 重复 / 思考空转 / 无进展）。
- DSH 直连远程 API，**没有中间层**能检测并打断流式响应。
- 应用层（agent loop）在 turn 结束前拿不到完整 reasoning，无法判断是否循环。

参考项目 [ollama-loop-guard](https://github.com/dustinmoon78/ollama-loop-guard) 是 HTTP 代理，
只适合"本地客户端拉远程 API"场景（upstream 强制环回）。DSH 直连远程 API，代理插不进去
（SSRF 防护拒绝非环回 upstream，改 baseURL 会破坏直连）。因此本插件在 DSH 内部实现，
**无需改核心、无需中间代理**。

## 工作机制

```
模型产出（含 reasoning）→ turn 即将关闭 → agent/turn-stopping
    → 读最新 assistant 消息的 reasoning/content
    → LoopDetector 检测（重复/变体/长程块/空转/溢出/内容重复）
    → 命中 → agent.steer(干预消息) → 机器重读 inbox → 同一 turn 再跑一步
    → 重试仍循环（> max_retries）→ 放弃，让 turn 正常结束
```

- **turn 级检测**：DSH 的 reasoning 在 turn 结束才完整，故不做流式逐 chunk 检测（无代理可切）。
- **检测器**：移植自 [ollama-loop-guard](https://github.com/dustinmoon78/ollama-loop-guard) 的
  `LoopDetector`（MIT，9/9 测试通过），适配为"读完整文本"模型，并**新增长程块重复规则**。
- **打断**：`agent.steer()` 提交模型可见的 steering 内容，继续同一 turn；按 turn 计数重试，
  逐级升级干预：
  - 第一次：steer 一条干预消息（`intervention`）。
  - 第二次及以后：steer 更强硬的升级消息，并经由 `agent/request` waterfall 把该 turn 后续请求的
    `reasoningEffort` 降到 `escalation_reasoning_effort`（默认 `low`）。**思维链保持开启**，只是变浅——
    浅推理更不容易陷入深循环，同时不牺牲正常推理能力（不关闭 thinking）。

## 检测规则（全部可配置）

| 规则 | 默认 | 说明 |
|---|---|---|
| reasoning 重复 | repeat_span_min=24 | 剥离标点后主体 ≥5 字符、重复串 ≥24 字符 |
| 变体重复 | 同句 ≥3 次 | "继续分析！…继续分析？…继续分析。" |
| **长程块重复** | block_repeat_min=100, count=3 | 归一化后 100 字符窗口出现 ≥3 次（抓"大块分析反复重算"循环） |
| reasoning 空转 | max_reasoning_sec=60 | 思考阶段无可见内容超时 |
| reasoning 溢出 | reasoning_char_limit=20000 | reasoning 字符量超限 |
| 内容重复 | content_repeat_span_min=100 | 可见 content 重复 |
| 总超时 | max_total_sec=120 | 单 turn 总时长上限 |
| 重试 | max_retries=2 | 逐级升级干预 |

> **长程块重复**是参考项目没有的规则：真实死循环常表现为"一大段分析文本整体重复多次，
> 块之间有不同内容"（如反复重算同一问题）。参考项目的紧循环正则（连续重复 / 带标点变体）
> 抓不到这种，故新增：把 reasoning 归一化（去标点空白）后，滑动 100 字符窗口，任一窗口出现
> ≥3 次即判循环。`tests/real_loop.txt` 是真实循环样本，已纳入测试。

## 配置

```yaml
thinking-loop-guard:
  enabled: true
  max_reasoning_sec: 60
  max_total_sec: 120
  max_retries: 2
  reasoning_char_limit: 20000
  repeat_span_min: 24
  content_repeat_span_min: 100
  block_repeat_min: 100
  block_repeat_count: 3
  intervention: "检测到重复推理，请停止循环，直接给出最终答案。"
  escalation_reasoning_effort: "low"   # 升级时降到该档位（思维链仍开启）
```

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# 注入器环境内：dev_inject_plugin <本目录>
```

## 测试

```bash
pnpm vitest run tests/detector.spec.ts   # 检测逻辑 11 项（含真实循环样本）
```

## 非目标

- 不改 DSH 核心 / agent loop。
- 不做流式逐 chunk 检测（DSH 是 turn 级）。
- 不引入中间代理 / 改 baseURL。

## 验证

- 单元测试：检测逻辑（重复/变体/长程块/空转/溢出/正常文本不误报/真实循环样本）。
- 集成：mock 一个死循环 reasoning 的 assistant 消息，验证 `agent/turn-stopping` 触发 →
  检测 → `steer()` 打断。
- 真实会话：观察是否在循环时打断。

## 致谢

检测器移植自 [ollama-loop-guard](https://github.com/dustinmoon78/ollama-loop-guard)（MIT）。

## License

MIT
