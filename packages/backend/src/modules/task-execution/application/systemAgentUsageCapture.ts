// RFC-371 v2 §4 — usage of one system-agent call: accepted before spawn,
// metered from stdout by the selected driver, written in place at most every
// few seconds, finished once with the native summary when the driver has one.

import type { AgentInvocationBinding } from './ports/agentInvocation'
import type { SystemAgentObservationRun } from './ports/systemAgentObservation'
import { createCallUsageWriter, type ObservedCallStatus } from './callUsageWriter'
import type { Logger } from '@/util/log'

export function createSystemAgentUsageCapture(input: {
  readonly run: SystemAgentObservationRun
  readonly invocation: AgentInvocationBinding
  readonly resumeSessionId?: string
  readonly log: Logger
  readonly now?: () => number
}) {
  const { run, invocation } = input
  const now = input.now ?? Date.now
  const meterInput = { resumed: Boolean(input.resumeSessionId), configuredModel: null }
  const writer = createCallUsageWriter({
    meter:
      invocation.evidence.prepareUsageMeter?.(meterInput) ??
      invocation.protocol.usageMeter?.(meterInput),
    write: (snapshot) => run.usage(snapshot),
    log: input.log,
    callId: run.callId,
    now,
  })
  let accepted = false
  let finished = false
  return {
    /** Runs immediately before spawn: an unrecorded process never starts. */
    async beforeStart() {
      await run.accept()
      accepted = true
      await invocation.lifecycle.beforeStart?.()
    },
    async line(line: string) {
      if (!accepted || finished) return
      writer.observeLine(line)
      await writer.flush()
    },
    /** End of one stdout chunk. */
    async flush() {
      if (accepted && !finished) await writer.flush()
    },
    async finish(status: ObservedCallStatus) {
      if (!accepted || finished) return
      finished = true
      try {
        await run.finish({ status, endedAt: now(), usage: writer.final() })
      } catch {
        input.log.warn('system-agent-call-finish-failed', { callId: run.callId })
      }
    },
  }
}

/** Map a system run result onto the recorded call status. */
export function systemCallStatus(status: string | undefined): ObservedCallStatus {
  if (status === 'ok') return 'done'
  if (status === 'aborted') return 'canceled'
  if (status === 'unreaped') return 'interrupted'
  return 'failed'
}
