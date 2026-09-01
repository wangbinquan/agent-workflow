// RFC-349 SQLite compatibility observer; provider-neutral observer lives in application.
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type {
  CodeHostSendAttemptHandle,
  CodeHostSendAttemptInfo,
  CodeHostSendAttemptSettlement,
} from '../public/participants'
import { taskExecutionModule } from '../composition'
import type { TaskExecutionContext } from '../application/taskExecutionContext'
import type { RetryAuthority } from '../domain/executionEffect'
import {
  CODE_HOST_CLASSIFIER_VERSION,
  CODE_HOST_TRANSPORT_POLICY_VERSION,
  codeHostRecoveryClass,
  type CodeHostProbeOutcome,
  type CodeHostRecoveryDescriptor,
} from '../domain/codeHostRecovery'
import type { CodeHostAction } from '@agent-workflow/shared'
import { waitForEffectResourceTurn } from '../application/effectResourceWait'

interface ObserverHandle extends CodeHostSendAttemptHandle {
  readonly effectId: string
  readonly attemptId: string
  readonly info: CodeHostSendAttemptInfo
}

export interface DurableCodeHostEffectObserver {
  beforeSend(
    info: CodeHostSendAttemptInfo,
  ): Promise<CodeHostSendAttemptHandle | null> | CodeHostSendAttemptHandle | null
  afterSend(
    handle: CodeHostSendAttemptHandle | null,
    settlement: CodeHostSendAttemptSettlement,
  ): Promise<void> | void
  /** Aggregate ambiguity across every send in this logical operation. */
  outcomeUnknown(): boolean
  /**
   * Settle the final mutation attempt together with its node projection.
   * Returns false for read-only/preflight paths that emitted no mutation send.
   */
  settleTerminal(onSettledTx: (tx: DbTxSync) => void): boolean
  /** Descriptor for the terminal ambiguous send; NULL for no-send/read paths. */
  terminalRecoveryDescriptor(): CodeHostRecoveryDescriptor | null
  /**
   * Apply a read-only probe. A proven application is settled by the ordinary
   * projection callback; a proven non-application authorizes one same-family
   * attempt without removing the existing manual path.
   */
  resolveTerminalProbe(outcome: CodeHostProbeOutcome): 'applied' | 'retry-authorized' | 'unknown'
}

export interface CodeHostEffectIdentity {
  readonly executionLineageId: string
  readonly operationFamilyKey: string
  readonly operationGeneration: number
  readonly operationKey: string
  readonly requestHash: string
  readonly slotPathJson: string
  readonly slotPathDigest: string
  readonly resourceKeys: readonly string[]
}

export function createCodeHostEffectAttemptObserver(input: {
  db: DbClient
  context: TaskExecutionContext
  action: CodeHostAction
  nodeRunId?: string
  initialRetryAuthority?: RetryAuthority
  identity: CodeHostEffectIdentity
}): DurableCodeHostEffectObserver {
  let nextRetryAuthority: RetryAuthority = input.initialRetryAuthority ?? 'none'
  let outcomeUnknown = false
  let priorAmbiguity = false
  let terminal: Readonly<{
    handle: ObserverHandle
    settlement: CodeHostSendAttemptSettlement
  }> | null = null
  let terminalProbe: Extract<CodeHostProbeOutcome, { kind: 'applied' }> | null = null
  return {
    async beforeSend(info) {
      if (info.method === 'GET') return null
      const prepared = await waitForEffectResourceTurn(() =>
        taskExecutionModule.effects.prepareAndAcquire({
          db: input.db,
          token: input.context.token,
          intentId: input.context.intentId,
          operationKey: input.identity.operationKey,
          executionLineageId: input.identity.executionLineageId,
          operationFamilyKey: input.identity.operationFamilyKey,
          operationGeneration: input.identity.operationGeneration,
          kind: 'code-host-mutation',
          requestHash: input.identity.requestHash,
          slotPathJson: input.identity.slotPathJson,
          slotPathDigest: input.identity.slotPathDigest,
          candidateId: `${info.candidateId}:t${info.transportAttempt}`,
          recoveryClass: codeHostRecoveryClass(input.action, info.method),
          recoveryDescriptorJson: JSON.stringify({
            ...info.recoveryDescriptor,
            nodeRunId: input.nodeRunId ?? null,
          }),
          classifierVersion: CODE_HOST_CLASSIFIER_VERSION,
          transportPolicyVersion: CODE_HOST_TRANSPORT_POLICY_VERSION,
          retryAuthority: nextRetryAuthority,
          resourceKeys: input.identity.resourceKeys,
        }),
      )
      nextRetryAuthority = 'none'
      return {
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        info,
      } as ObserverHandle
    },
    afterSend(handle, settlement) {
      if (handle === null || handle === undefined) return
      const owned = handle as ObserverHandle
      if (
        owned.info.candidateId !== settlement.candidateId ||
        owned.info.transportAttempt !== settlement.transportAttempt ||
        owned.info.method !== settlement.method
      ) {
        throw new Error('code-host attempt observer handle mismatch')
      }
      const status = settlement.status ?? null
      const ambiguous =
        settlement.result === 'network-error' || status === null || status === 429 || status >= 500
      if (settlement.willRetry) {
        settleAttempt(input, owned, settlement)
        priorAmbiguity ||= ambiguous
      } else {
        if (terminal !== null) throw new Error('code-host terminal attempt recorded twice')
        terminal = { handle: owned, settlement }
        const applied =
          settlement.result === 'response' && status !== null && status >= 200 && status < 300
        const definitelyNotApplied =
          settlement.result === 'response' &&
          status !== null &&
          status >= 300 &&
          status < 500 &&
          status !== 429
        outcomeUnknown = !applied && (ambiguous || (priorAmbiguity && definitelyNotApplied))
      }
      nextRetryAuthority = settlement.willRetry
        ? settlement.retryKind === 'compatibility-fallback'
          ? 'convergent'
          : 'transport-policy'
        : 'none'
    },
    outcomeUnknown: () => outcomeUnknown,
    settleTerminal(onSettledTx) {
      if (terminal === null) return false
      const current = terminal
      terminal = null
      if (terminalProbe !== null) {
        settleProbedAppliedAttempt(
          input,
          current.handle,
          current.settlement,
          terminalProbe,
          onSettledTx,
        )
        terminalProbe = null
      } else {
        settleAttempt(input, current.handle, current.settlement, onSettledTx)
      }
      return true
    },
    terminalRecoveryDescriptor() {
      return terminal?.handle.info.recoveryDescriptor ?? null
    },
    resolveTerminalProbe(probe) {
      if (terminal === null || probe.kind === 'unknown') return 'unknown'
      if (probe.kind === 'applied') {
        terminalProbe = probe
        outcomeUnknown = false
        return 'applied'
      }
      const current = terminal
      terminal = null
      taskExecutionModule.effects.settle({
        db: input.db,
        token: input.context.token,
        effectId: current.handle.effectId,
        attemptId: current.handle.attemptId,
        state: 'retry-authorized',
        applicationEvidence: 'definitely-not-applied',
        retryAuthority: 'probe',
        receiptJson: JSON.stringify({
          v: 1,
          candidateId: current.settlement.candidateId,
          transportAttempt: current.settlement.transportAttempt,
          method: current.settlement.method,
          pathname: current.settlement.pathname,
          transportResult: current.settlement.result,
          transportStatus: current.settlement.status ?? null,
          recoveryProbe: {
            outcome: probe.kind,
            proofCode: probe.proofCode,
            responseStatus: probe.responseStatus,
          },
        }),
      })
      terminalProbe = null
      outcomeUnknown = false
      priorAmbiguity = false
      nextRetryAuthority = 'probe'
      return 'retry-authorized'
    },
  }
}

function settleProbedAppliedAttempt(
  input: {
    db: DbClient
    context: TaskExecutionContext
  },
  handle: ObserverHandle,
  settlement: CodeHostSendAttemptSettlement,
  probe: Extract<CodeHostProbeOutcome, { kind: 'applied' }>,
  onSettledTx: (tx: DbTxSync) => void,
): void {
  taskExecutionModule.effects.settle({
    db: input.db,
    token: input.context.token,
    effectId: handle.effectId,
    attemptId: handle.attemptId,
    state: 'succeeded',
    applicationEvidence: 'applied',
    retryAuthority: 'none',
    receiptJson: JSON.stringify({
      v: 1,
      candidateId: settlement.candidateId,
      transportAttempt: settlement.transportAttempt,
      method: settlement.method,
      pathname: settlement.pathname,
      transportResult: settlement.result,
      transportStatus: settlement.status ?? null,
      recoveryProbe: {
        outcome: probe.kind,
        proofCode: probe.proofCode,
        responseStatus: probe.responseStatus,
      },
    }),
    onSettledTx,
  })
}

function settleAttempt(
  input: {
    db: DbClient
    context: TaskExecutionContext
  },
  handle: ObserverHandle,
  settlement: CodeHostSendAttemptSettlement,
  onSettledTx?: (tx: DbTxSync) => void,
): void {
  const status = settlement.status ?? null
  const isCompatibilityMiss =
    settlement.retryKind === 'compatibility-fallback' && (status === 404 || status === 405)
  const isApplied =
    settlement.result === 'response' && status !== null && status >= 200 && status < 300
  const definitelyNotApplied =
    settlement.result === 'response' &&
    status !== null &&
    status >= 300 &&
    status < 500 &&
    status !== 429
  const receiptJson = JSON.stringify({
    v: 1,
    candidateId: settlement.candidateId,
    transportAttempt: settlement.transportAttempt,
    method: settlement.method,
    pathname: settlement.pathname,
    result: settlement.result,
    status,
    willRetry: settlement.willRetry,
    retryKind: settlement.retryKind,
    ...(settlement.errorMessage !== undefined ? { error: settlement.errorMessage } : {}),
  })

  if (settlement.willRetry) {
    taskExecutionModule.effects.settle({
      db: input.db,
      token: input.context.token,
      effectId: handle.effectId,
      attemptId: handle.attemptId,
      state: 'retry-authorized',
      applicationEvidence: isCompatibilityMiss ? 'definitely-not-applied' : 'ambiguous',
      retryAuthority:
        settlement.retryKind === 'compatibility-fallback' ? 'convergent' : 'transport-policy',
      receiptJson,
      failureCode:
        settlement.result === 'network-error'
          ? 'code-host-network-error'
          : `code-host-http-${status ?? 'unknown'}`,
      ...(onSettledTx === undefined ? {} : { onSettledTx }),
    })
    return
  }
  taskExecutionModule.effects.settle({
    db: input.db,
    token: input.context.token,
    effectId: handle.effectId,
    attemptId: handle.attemptId,
    state: isApplied
      ? 'succeeded'
      : definitelyNotApplied
        ? 'failed-not-applied'
        : 'recovery-required',
    applicationEvidence: isApplied
      ? 'applied'
      : definitelyNotApplied
        ? 'definitely-not-applied'
        : 'ambiguous',
    retryAuthority: 'none',
    receiptJson,
    failureCode: isApplied
      ? null
      : settlement.result === 'network-error'
        ? 'code-host-network-error'
        : `code-host-http-${status ?? 'unknown'}`,
    ...(onSettledTx === undefined ? {} : { onSettledTx }),
  })
}
