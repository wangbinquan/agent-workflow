import type { IntentExecutionCheckpoint, IntentExecutionControl } from './ports/intentExecution'
import type {
  IntentSystemAgentRunFamily,
  IntentSystemAgentRunResult,
} from './ports/intentSystemAgent'
import type { IntentTurnSessionEventSink } from './turnSession'

/** Resume result processing from Intent's original primary facts. A missing
 * output is an interrupted original attempt, never a reason to run a model. */
export async function recoverPersistedIntentExecution(input: {
  readonly checkpoint: IntentExecutionCheckpoint
  readonly control: IntentExecutionControl
  readonly systemAgents: IntentSystemAgentRunFamily
  readonly eventSink: IntentTurnSessionEventSink
}): Promise<IntentSystemAgentRunResult> {
  const checkpoint = input.checkpoint
  if (checkpoint.result && checkpoint.result.status !== 'unreaped') return checkpoint.result
  const receipt = checkpoint.receipt
  if (!receipt) throw new Error('intent-original-execution-receipt-missing')
  const recoveryOwner = input.systemAgents.recovery
  const recover = recoveryOwner?.recoverReference.bind(recoveryOwner)
  const contents = input.systemAgents.retainedContents
  const release = contents.release.bind(contents)
  const scope = input.systemAgents.workspaces.capture({
    namespace: 'intent',
    name: checkpoint.reservation.turnId,
  })
  const terminal = input.eventSink.markTerminal.bind(input.eventSink)
  if (checkpoint.phase !== 'reaped') {
    let physicalAcknowledged = false
    await input.control.holdOriginal(async () => {
      if (!physicalAcknowledged) {
        if (!recover || !receipt.recoveryRef) return false
        const fact = await recover({
          executionRef: receipt.executionRef,
          recoveryRef: receipt.recoveryRef,
        })
        if (fact.executionRef !== receipt.executionRef || fact.state !== 'reaped') return false
        physicalAcknowledged = true
      }
      await terminal('incomplete', 'post-exit-flush-timeout')
      return (await release({ retainedRef: receipt.retainedRef, scope })).removed
    })
  }
  return {
    ...(checkpoint.result ?? {
      status: 'aborted',
      exitCode: null,
      eventText: '',
      stderrTail: '',
      durationMs: 0,
      retainedRef: receipt.retainedRef,
      scratchRetained: false,
      outputEvidence: {
        assistantTextSeen: false,
        observedAssistantTextBytes: 0,
        retainedAssistantTextBytes: 0,
        eventTextCapHit: false,
        terminalResult: 'not-observed',
      },
    }),
    status: 'aborted',
    scratchRetained: false,
    executionReceipt: receipt,
  }
}
