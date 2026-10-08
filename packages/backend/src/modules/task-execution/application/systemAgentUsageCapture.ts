import type { ObservationNativeProcessFact } from '@agent-workflow/shared'
import type { AgentInvocationBinding } from './ports/agentInvocation'
import type { SystemAgentObservationRun } from './ports/systemAgentObservation'
import { createInvocationUsageCapture } from '@/modules/runtime-management/public/participants'
import type { Logger } from '@/util/log'

/** Numeric capture is independent of text retention and reuses the original full native reader. */
export function createSystemAgentUsageCapture(input: {
  readonly run: SystemAgentObservationRun
  readonly invocation: AgentInvocationBinding
  readonly resumeSessionId?: string
  readonly log: Logger
}) {
  const { run, invocation } = input
  const capture = createInvocationUsageCapture({
    invocationId: run.invocationId,
    taskId: run.taskId,
    nodeRunId: run.nodeRunId,
    agentId: run.agentId,
    normalize: invocation.evidence.prepareUsageNormalizer?.() ?? invocation.protocol.normalizeUsage,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    includeMeasurement: (row) => native?.includesRecord(row.recordId) ?? true,
  })
  // Never fall back to the old capped native snapshot for a System invocation.
  const native = run.durableOwner
    ? invocation.evidence.prepareNativeUsageCapture?.({
        invocationId: run.invocationId,
        taskId: run.taskId,
        nodeRunId: run.nodeRunId,
        agentId: run.agentId,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        nextRevision: capture.nextRevision,
        durableOwner: run.durableOwner,
      })
    : undefined
  let accepted = false
  const safely = async (operation: () => Promise<void>) => {
    try {
      await operation()
    } catch {
      input.log.warn('system-agent-usage-source-remains-pending', {
        invocationId: run.invocationId,
      })
    }
  }
  return {
    async beforeStart() {
      await run.accept(
        native
          ? { nativeCaptureContract: native.contract, nativeCaptureSource: native.nativeSource }
          : {},
      )
      accepted = true
      if (native?.beginDurable) await safely(() => native.beginDurable!())
      await invocation.lifecycle.beforeStart?.()
    },
    async process(fact: ObservationNativeProcessFact) {
      await run.process(fact)
      if (!accepted) return
      if (native?.recordProcess) await native.recordProcess(fact)
    },
    async root(sessionId: string, previous?: string) {
      await safely(() => run.root(sessionId, previous))
    },
    async line(line: string, sessionId: string | null) {
      if (!accepted) return
      const frame = capture(line, sessionId, Date.now())
      if (frame) await safely(() => run.append([frame]))
    },
    async flush() {
      if (accepted) await safely(() => run.reconcile())
    },
    async finish(sessionId: string | null) {
      if (!accepted) return
      await safely(() => run.append(capture.retryModels(Date.now())))
      if (native?.finishDurable) await safely(() => run.finalize(native, sessionId))
      else await safely(() => run.reconcile())
    },
  }
}
