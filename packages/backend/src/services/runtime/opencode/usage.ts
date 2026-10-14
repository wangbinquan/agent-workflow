// RFC-371 v2 §4 — OpenCode usage metering.
//
// `opencode run --format json` prints only the root session's parts
// (packages/opencode/src/cli/cmd/run.ts:717 skips other sessions), so the stream
// sees root step_finish tokens only. A delegated sub-agent (`task` tool) runs in
// a child session; after the process drained, one bounded read of the native
// store sums every step-finish part of the root tree created since this
// invocation started, grouped by the assistant message's actual provider/model
// (packages/core/src/session/sql.ts:22-98; tokens per step are recorded at
// packages/opencode/src/session/processor.ts:435-455). OpenCode reports output
// without reasoning, so reasoning is added to output once.

import {
  UsageAccumulator,
  objectOf,
  tokenCount,
  type RuntimeUsageMeter,
  type RuntimeUsageMeterInput,
} from '../usage'
import { opencodeUsageDatabasePath, readOpencodeTreeUsage } from './nativeUsage'

export function createOpencodeUsageMeter(
  input: RuntimeUsageMeterInput & {
    /** The final child environment, used only to locate the native store. */
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly now?: () => number
  },
): RuntimeUsageMeter {
  const since = (input.now ?? Date.now)()
  const stream = new UsageAccumulator()
  const steps = new Set<string>()
  const roots = new Set<string>()
  let delegated = false
  const model = input.configuredModel ?? ''
  return {
    observe(event) {
      if (typeof event.sessionID === 'string' && event.sessionID) roots.add(event.sessionID)
      const part = objectOf(event.part)
      if (event.type === 'tool_use') {
        if (part?.tool !== 'task' || delegated) return false
        delegated = true
        return true
      }
      if (event.type !== 'step_finish') return false
      const id = typeof part?.id === 'string' ? part.id : null
      if (id !== null) {
        if (steps.has(id)) return false
        steps.add(id)
      }
      const tokens = objectOf(part?.tokens)
      const cache = objectOf(tokens?.cache)
      const reasoning = tokenCount(tokens?.reasoning)
      stream.add(model, {
        input: tokenCount(tokens?.input),
        cacheRead: tokenCount(cache?.read),
        cacheWrite: tokenCount(cache?.write),
        output: tokenCount(tokens?.output) + reasoning,
        reasoning,
      })
      return true
    },
    snapshot() {
      return stream.snapshot(delegated ? 'partial' : 'complete')
    },
    finish() {
      const path = input.env ? opencodeUsageDatabasePath(input.env) : null
      if (!path || roots.size === 0) return null
      const tree = readOpencodeTreeUsage(path, [...roots], since)
      // A store that has not recorded every root step the stream saw is not
      // this invocation's store (or is not flushed yet): keep the stream view.
      if (!tree || tree.rootSteps < steps.size) return null
      const summary = new UsageAccumulator()
      for (const row of tree.models) summary.add(row.model, row)
      return summary.snapshot('complete')
    },
  }
}

/** The stream-only meter (no native store); used when no child environment is known. */
export function usageMeter(input: RuntimeUsageMeterInput): RuntimeUsageMeter {
  return createOpencodeUsageMeter(input)
}
