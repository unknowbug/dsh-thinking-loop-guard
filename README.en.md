# dsh-thinking-loop-guard

> A thinking-chain loop detector & breaker plugin for DSH (in-process, no proxy).

Models (e.g. `deepseek-v4-flash:0731`) occasionally fall into a **degenerate thinking loop**:
`reasoning` repeats the same analysis over and over, producing no visible output for a long time,
burning tokens and stalling the agent. DSH talks to the remote API directly with no middle layer
to detect or interrupt the stream, so this plugin reads the complete reasoning at the **turn
boundary** (`agent/turn-stopping`), detects the loop, and breaks it with `agent.steer()`.

## Problem

- The model enters a degenerate generation loop during reasoning (repeated reasoning / idle
  thinking / no progress).
- DSH connects to the remote API directly — there is **no middle layer** to detect and interrupt
  the streaming response.
- The application layer (agent loop) cannot see the full reasoning until the turn ends, so it
  cannot judge whether a loop is happening.

The reference project [ollama-loop-guard](https://github.com/dustinmoon78/ollama-loop-guard) is an
HTTP proxy that only fits the "local client pulls a remote API" scenario (upstream forced to
loopback). DSH connects to the remote API directly, so a proxy cannot be inserted (SSRF protection
rejects non-loopback upstreams, and changing the baseURL would break the direct connection). This
plugin therefore works **inside DSH — no core changes, no proxy**.

## How it works

```
model output (incl. reasoning) → turn about to close → agent/turn-stopping
    → read latest assistant message reasoning/content
    → LoopDetector (repeat / variant / long-range block / stall / overflow / content repeat)
    → hit → agent.steer(intervention) → machine re-reads inbox → same turn runs another step
    → still looping (> max_retries) → give up, let the turn end normally
```

- **Turn-level detection**: DSH's reasoning is only complete at turn end, so there is no
  streaming per-chunk detection (no proxy to cut).
- **Detector**: ported from [ollama-loop-guard](https://github.com/dustinmoon78/ollama-loop-guard)'s
  `LoopDetector` (MIT, 9/9 tests passing), adapted to the "read full text" model, with a new
  **long-range block-repeat rule** added.
- **Interruption**: `agent.steer()` submits model-visible steering content and continues the same
  turn; retries are counted per turn with escalating intervention:
  - First: steer an intervention message (`intervention`).
  - Second and later: steer a stronger escalation message, and via the `agent/request` waterfall
    lower the turn's subsequent `reasoningEffort` to `escalation_reasoning_effort` (default `low`).
    **Thinking stays enabled** — it just gets shallower, which is less likely to fall into a deep
    loop while preserving normal reasoning ability (thinking is never disabled).

## Detection rules (all configurable)

| Rule | Default | Description |
|---|---|---|
| Reasoning repetition | repeat_span_min=24 | core ≥5 chars after stripping punctuation, repeated span ≥24 chars |
| Variant repetition | same sentence ≥3× | "keep analyzing!…keep analyzing?…keep analyzing." |
| **Long-range block repeat** | block_repeat_min=100, count=3 | a normalized 100-char window appearing ≥3× (catches "re-analyze the same thing" loops) |
| Reasoning stall | max_reasoning_sec=60 | no visible content for too long during thinking |
| Reasoning overflow | reasoning_char_limit=20000 | reasoning exceeds the char limit |
| Content repetition | content_repeat_span_min=100 | repeated visible content |
| Total timeout | max_total_sec=120 | whole-turn time cap |
| Retries | max_retries=2 | escalating intervention |

> **Long-range block repeat** is a rule the reference project lacks: real dead loops often look
> like "one large analysis block recurs verbatim several times, with different text in between"
> (e.g. re-computing the same problem). The reference's tight-loop regexes (consecutive repeat /
> punctuation-variant) miss this, so it was added: normalize the reasoning (strip punctuation and
> whitespace), slide a 100-char window, and flag when any window appears ≥3 times.
> `tests/real_loop.txt` is a real loop sample and is part of the test suite.

## Configuration

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
  escalation_reasoning_effort: "low"   # lowered on escalation (thinking stays on)
```

## Build & inject

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# inside the injector environment: dev_inject_plugin <this dir>
```

## Tests

```bash
pnpm vitest run tests/detector.spec.ts   # 11 detection tests (incl. a real loop sample)
```

## Non-goals

- No changes to DSH core / the agent loop.
- No streaming per-chunk detection (DSH is turn-level).
- No proxy / no baseURL changes.

## Verification

- Unit tests: detection logic (repeat / variant / long-range block / stall / overflow / no
  false-positive on normal text / real loop sample).
- Integration: mock a dead-loop reasoning assistant message and verify
  `agent/turn-stopping` → detection → `steer()` interruption.
- Real sessions: observe whether the loop is interrupted.

## Credits

Detector ported from [ollama-loop-guard](https://github.com/dustinmoon78/ollama-loop-guard) (MIT).

## License

MIT
