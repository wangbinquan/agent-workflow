// RFC-371 v2 §4 — feeds stdout to the selected driver's usage meter and writes
// the replaceable snapshot in place, at most once per interval. Shared by task
// node runs and platform system-agent runs.

import type {
  RuntimeUsageMeter,
  RuntimeUsageSnapshot,
} from '@/modules/runtime-management/public/participants'
import type { Logger } from '@/util/log'

/** Minimum spacing of in-flight usage writes for one call. */
export const USAGE_FLUSH_INTERVAL_MS = 3_000

export type ObservedCallStatus = 'done' | 'failed' | 'canceled' | 'interrupted'

export function createCallUsageWriter(input: {
  readonly meter: RuntimeUsageMeter | undefined
  readonly write: (snapshot: RuntimeUsageSnapshot) => Promise<void>
  readonly log: Logger
  readonly callId: string
  readonly now?: () => number
}) {
  const now = input.now ?? Date.now
  let dirty = false
  // The first change is written at once, whatever the clock's origin.
  let lastWrite = Number.NEGATIVE_INFINITY
  return {
    /** Feed one raw stdout line; malformed or non-object lines are ignored. */
    observeLine(line: string): void {
      if (!input.meter) return
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event === null || typeof event !== 'object' || Array.isArray(event)) return
      if (input.meter.observe(event as Record<string, unknown>)) dirty = true
    },
    /** Write the current snapshot when it changed and the interval allows (or `force`). */
    async flush(force = false): Promise<void> {
      if (!input.meter || !dirty) return
      if (!force && now() - lastWrite < USAGE_FLUSH_INTERVAL_MS) return
      dirty = false
      lastWrite = now()
      try {
        await input.write(input.meter.snapshot())
      } catch {
        input.log.warn('call-usage-write-failed', { callId: input.callId })
      }
    },
    /** The current stream snapshot, without any native read. */
    snapshot(): RuntimeUsageSnapshot | null {
      return input.meter ? input.meter.snapshot() : null
    },
    /** The final snapshot after the process drained (native summary when available). */
    final(): RuntimeUsageSnapshot | null {
      if (!input.meter) return null
      try {
        return input.meter.finish?.() ?? input.meter.snapshot()
      } catch {
        return input.meter.snapshot()
      }
    },
  }
}

/** A node-run status projected onto the recorded call status. */
export function callStatusOfNodeRun(status: string): ObservedCallStatus {
  if (status === 'failed') return 'failed'
  if (status === 'canceled') return 'canceled'
  if (status === 'interrupted') return 'interrupted'
  return 'done'
}
