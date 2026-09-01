// RFC-349 — provider-neutral code-host mutation effect coordinator.

import type { CodeHostAction } from '@agent-workflow/shared'
import type { RetryAuthority } from '../domain/executionEffect'
import {
  CODE_HOST_CLASSIFIER_VERSION,
  CODE_HOST_TRANSPORT_POLICY_VERSION,
  codeHostRecoveryClass,
  type CodeHostProbeOutcome,
  type CodeHostRecoveryDescriptor,
} from '../domain/codeHostRecovery'
import type {
  CodeHostNodeSettlementProjection,
  TaskExecutionEffectPersistence,
} from './ports/taskExecutionEffectStore'
import type { TaskExecutionContext } from './taskExecutionContext'
import { waitForEffectResourceTurn } from './effectResourceWait'

export interface CodeHostSendAttemptInfo {
  readonly candidateId: string
  readonly transportAttempt: number
  readonly method: string
  readonly pathname: string
  readonly recoveryDescriptor: CodeHostRecoveryDescriptor
}

export interface CodeHostSendAttemptSettlement extends CodeHostSendAttemptInfo {
  readonly result: 'response' | 'network-error'
  readonly status?: number
  readonly willRetry: boolean
  readonly retryKind: 'none' | 'transport-policy' | 'compatibility-fallback'
  readonly errorMessage?: string
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

export interface CodeHostEffectObserverHandle {
  readonly effectId: string
  readonly attemptId: string
  readonly info: CodeHostSendAttemptInfo
}

export interface DurableCodeHostEffectObserver {
  beforeSend(info: CodeHostSendAttemptInfo): Promise<CodeHostEffectObserverHandle | null>
  afterSend(
    handle: CodeHostEffectObserverHandle | null,
    settlement: CodeHostSendAttemptSettlement,
  ): Promise<void>
  outcomeUnknown(): boolean
  settleTerminal(projection: CodeHostNodeSettlementProjection): Promise<boolean>
  terminalRecoveryDescriptor(): CodeHostRecoveryDescriptor | null
  resolveTerminalProbe(
    outcome: CodeHostProbeOutcome,
  ): Promise<'applied' | 'retry-authorized' | 'unknown'>
}

export function createCodeHostEffectAttemptObserver(input: {
  persistence: TaskExecutionEffectPersistence
  context: TaskExecutionContext
  action: CodeHostAction
  nodeRunId?: string
  initialRetryAuthority?: RetryAuthority
  identity: CodeHostEffectIdentity
}): DurableCodeHostEffectObserver {
  let nextRetryAuthority: RetryAuthority = input.initialRetryAuthority ?? 'none'
  let unknown = false
  let priorAmbiguity = false
  let terminal: Readonly<{
    handle: CodeHostEffectObserverHandle
    settlement: CodeHostSendAttemptSettlement
  }> | null = null
  let terminalProbe: Extract<CodeHostProbeOutcome, { kind: 'applied' }> | null = null

  const settleAttempt = async (
    handle: CodeHostEffectObserverHandle,
    settlement: CodeHostSendAttemptSettlement,
    projection?: CodeHostNodeSettlementProjection,
  ) => {
    const status = settlement.status ?? null
    const compatibilityMiss =
      settlement.retryKind === 'compatibility-fallback' && (status === 404 || status === 405)
    const applied =
      terminalProbe !== null ||
      (settlement.result === 'response' && status !== null && status >= 200 && status < 300)
    const definitelyNotApplied =
      terminalProbe === null &&
      settlement.result === 'response' &&
      status !== null &&
      status >= 300 &&
      status < 500 &&
      status !== 429
    const state = settlement.willRetry
      ? ('retry-authorized' as const)
      : applied
        ? ('succeeded' as const)
        : definitelyNotApplied
          ? ('failed-not-applied' as const)
          : ('recovery-required' as const)
    const record = {
      token: input.context.token,
      effectId: handle.effectId,
      attemptId: handle.attemptId,
      state,
      applicationEvidence: applied
        ? ('applied' as const)
        : definitelyNotApplied || compatibilityMiss
          ? ('definitely-not-applied' as const)
          : ('ambiguous' as const),
      retryAuthority: settlement.willRetry
        ? settlement.retryKind === 'compatibility-fallback'
          ? ('convergent' as const)
          : ('transport-policy' as const)
        : ('none' as const),
      receiptJson: JSON.stringify({
        v: 1,
        candidateId: settlement.candidateId,
        transportAttempt: settlement.transportAttempt,
        method: settlement.method,
        pathname: settlement.pathname,
        result: settlement.result,
        status,
        willRetry: settlement.willRetry,
        retryKind: settlement.retryKind,
        ...(terminalProbe === null
          ? {}
          : {
              recoveryProbe: {
                outcome: terminalProbe.kind,
                proofCode: terminalProbe.proofCode,
                responseStatus: terminalProbe.responseStatus,
              },
            }),
        ...(settlement.errorMessage === undefined ? {} : { error: settlement.errorMessage }),
      }),
      failureCode: applied
        ? null
        : settlement.result === 'network-error'
          ? 'code-host-network-error'
          : `code-host-http-${status ?? 'unknown'}`,
    }
    if (projection === undefined) await input.persistence.settle(record)
    else await input.persistence.settleCodeHostNode({ settlement: record, projection })
    terminalProbe = null
  }

  return {
    async beforeSend(info) {
      if (info.method === 'GET') return null
      const prepared = await waitForEffectResourceTurn(() =>
        input.persistence.prepareAndAcquire({
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
      return { effectId: prepared.effectId, attemptId: prepared.attemptId, info }
    },
    async afterSend(handle, settlement) {
      if (handle === null) return
      if (
        handle.info.candidateId !== settlement.candidateId ||
        handle.info.transportAttempt !== settlement.transportAttempt ||
        handle.info.method !== settlement.method
      ) {
        throw new Error('code-host attempt observer handle mismatch')
      }
      const status = settlement.status ?? null
      const ambiguous =
        settlement.result === 'network-error' || status === null || status === 429 || status >= 500
      if (settlement.willRetry) {
        await settleAttempt(handle, settlement)
        priorAmbiguity ||= ambiguous
      } else {
        if (terminal !== null) throw new Error('code-host terminal attempt recorded twice')
        terminal = { handle, settlement }
        const applied =
          settlement.result === 'response' && status !== null && status >= 200 && status < 300
        const definitelyNotApplied =
          settlement.result === 'response' &&
          status !== null &&
          status >= 300 &&
          status < 500 &&
          status !== 429
        unknown = !applied && (ambiguous || (priorAmbiguity && definitelyNotApplied))
      }
      nextRetryAuthority = settlement.willRetry
        ? settlement.retryKind === 'compatibility-fallback'
          ? 'convergent'
          : 'transport-policy'
        : 'none'
    },
    outcomeUnknown: () => unknown,
    async settleTerminal(projection) {
      if (terminal === null) return false
      const current = terminal
      terminal = null
      await settleAttempt(current.handle, current.settlement, projection)
      return true
    },
    terminalRecoveryDescriptor: () => terminal?.handle.info.recoveryDescriptor ?? null,
    async resolveTerminalProbe(probe) {
      if (terminal === null || probe.kind === 'unknown') return 'unknown'
      if (probe.kind === 'applied') {
        terminalProbe = probe
        unknown = false
        return 'applied'
      }
      const current = terminal
      terminal = null
      await input.persistence.settle({
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
      unknown = false
      priorAmbiguity = false
      nextRetryAuthority = 'probe'
      return 'retry-authorized'
    },
  }
}
