// RFC-371 v2 §4 — Claude Code usage metering (stream-json).
//
// One API response is split into several `assistant` events sharing a message
// id; their usage repeats, and output may grow, so each message keeps the
// largest value per bucket. Output in assistant events is not final, so the
// running snapshot is partial. The `result` event's `modelUsage` is the
// per-model total including sub-agents; it replaces the stream view — except
// for a resumed session, whose counters may include the restored history
// (design/RFC-371-run-observability/protocol-evidence.md), and except for an
// `error_during_execution` all-zero report, which never erases known usage.

import {
  UsageAccumulator,
  modelKey,
  objectOf,
  tokenCount,
  type RuntimeUsageMeter,
  type RuntimeUsageMeterInput,
  type RuntimeUsageModel,
} from '../usage'

interface MessageUsage {
  readonly model: string
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

export function usageMeter(input: RuntimeUsageMeterInput): RuntimeUsageMeter {
  const messages = new Map<string, MessageUsage>()
  let final: RuntimeUsageModel[] | null = null
  return {
    observe(event) {
      if (event.type === 'assistant') {
        if (final) return false
        const message = objectOf(event.message)
        const usage = objectOf(message?.usage)
        const id = typeof message?.id === 'string' ? message.id : null
        if (!id || !usage) return false
        const previous = messages.get(id)
        const next: MessageUsage = {
          model: previous?.model || modelKey(message?.model),
          input: Math.max(previous?.input ?? 0, tokenCount(usage.input_tokens)),
          cacheRead: Math.max(previous?.cacheRead ?? 0, tokenCount(usage.cache_read_input_tokens)),
          cacheWrite: Math.max(
            previous?.cacheWrite ?? 0,
            tokenCount(usage.cache_creation_input_tokens),
          ),
          output: Math.max(previous?.output ?? 0, tokenCount(usage.output_tokens)),
        }
        if (
          previous &&
          previous.model === next.model &&
          previous.input === next.input &&
          previous.cacheRead === next.cacheRead &&
          previous.cacheWrite === next.cacheWrite &&
          previous.output === next.output
        )
          return false
        messages.set(id, next)
        return true
      }
      if (event.type !== 'result' || input.resumed) return false
      const byModel = objectOf(event.modelUsage)
      const rows = Object.entries(byModel ?? {}).flatMap(([name, value]) => {
        const usage = objectOf(value)
        const model = modelKey(name)
        return usage && model
          ? [
              {
                model,
                input: tokenCount(usage.inputTokens),
                cacheRead: tokenCount(usage.cacheReadInputTokens),
                cacheWrite: tokenCount(usage.cacheCreationInputTokens),
                output: tokenCount(usage.outputTokens),
                reasoning: 0,
              },
            ]
          : []
      })
      if (!rows.length) return false
      const empty = rows.every(
        (row) => row.input + row.cacheRead + row.cacheWrite + row.output === 0,
      )
      if (empty && (event.subtype === 'error_during_execution' || messages.size > 0)) return false
      final = rows
      return true
    },
    snapshot() {
      const totals = new UsageAccumulator()
      if (final) {
        totals.replace(final)
        return totals.snapshot('complete')
      }
      for (const row of messages.values()) totals.add(row.model, { ...row, reasoning: 0 })
      return totals.snapshot('partial')
    },
  }
}
