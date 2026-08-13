export type WebhookAgentResolutionResult<T> =
  | {
      readonly kind: 'resolved'
      readonly agentId: string
      readonly requestGeneration: number
      readonly detailRevision: number
      readonly structureSignature: string
      readonly value: T
    }
  | {
      readonly kind: 'query-error' | 'target-missing'
      readonly agentId: string
      readonly requestGeneration: number
      readonly detailRevision?: undefined
      readonly structureSignature: string
      readonly error: unknown
    }

export interface WebhookAgentPendingIdentity {
  readonly agentId: string
  readonly requestGeneration: number
  readonly pendingResultSeq: number
  readonly detailRevision?: number
  readonly resultKind: WebhookAgentResolutionResult<unknown>['kind']
  readonly structureSignature: string
}

export interface WebhookAgentPendingResult<T> {
  readonly identity: WebhookAgentPendingIdentity
  readonly result: WebhookAgentResolutionResult<T>
}

export interface WebhookAgentResolutionState<T> {
  readonly targetId: string
  readonly requestGeneration: number
  readonly current: WebhookAgentResolutionResult<T> | null
  readonly refreshing: boolean
  readonly pending: WebhookAgentPendingResult<T> | null
  readonly nextPendingResultSeq: number
}

export function initialWebhookAgentResolution<T>(): WebhookAgentResolutionState<T> {
  return {
    targetId: '',
    requestGeneration: 0,
    current: null,
    refreshing: false,
    pending: null,
    nextPendingResultSeq: 1,
  }
}

export function startWebhookAgentResolution<T>(
  state: WebhookAgentResolutionState<T>,
  agentId: string,
  requestGeneration: number,
): WebhookAgentResolutionState<T> {
  if (agentId !== state.targetId) {
    return {
      targetId: agentId,
      requestGeneration,
      current: null,
      refreshing: false,
      pending: null,
      nextPendingResultSeq: state.nextPendingResultSeq,
    }
  }
  if (requestGeneration < state.requestGeneration) return state
  return {
    ...state,
    requestGeneration,
    refreshing: state.current !== null,
    pending: null,
  }
}

function resultMatchesCurrentRequest<T>(
  state: WebhookAgentResolutionState<T>,
  result: WebhookAgentResolutionResult<T>,
): boolean {
  return result.agentId === state.targetId && result.requestGeneration === state.requestGeneration
}

function isSameResolvedStructure<T>(
  current: WebhookAgentResolutionResult<T> | null,
  result: WebhookAgentResolutionResult<T>,
): boolean {
  return (
    current?.kind === 'resolved' &&
    result.kind === 'resolved' &&
    current.structureSignature === result.structureSignature
  )
}

export function acceptWebhookAgentResolution<T>(
  state: WebhookAgentResolutionState<T>,
  result: WebhookAgentResolutionResult<T>,
  deferStructureChange: boolean,
): WebhookAgentResolutionState<T> {
  if (!resultMatchesCurrentRequest(state, result)) return state
  if (
    state.current === null ||
    isSameResolvedStructure(state.current, result) ||
    !deferStructureChange
  ) {
    return { ...state, current: result, refreshing: false, pending: null }
  }

  const pendingResultSeq = state.nextPendingResultSeq
  return {
    ...state,
    refreshing: true,
    pending: {
      identity: {
        agentId: result.agentId,
        requestGeneration: result.requestGeneration,
        pendingResultSeq,
        detailRevision: result.detailRevision,
        resultKind: result.kind,
        structureSignature: result.structureSignature,
      },
      result,
    },
    nextPendingResultSeq: pendingResultSeq + 1,
  }
}

function samePendingIdentity(
  left: WebhookAgentPendingIdentity,
  right: WebhookAgentPendingIdentity,
): boolean {
  return (
    left.agentId === right.agentId &&
    left.requestGeneration === right.requestGeneration &&
    left.pendingResultSeq === right.pendingResultSeq &&
    left.detailRevision === right.detailRevision &&
    left.resultKind === right.resultKind &&
    left.structureSignature === right.structureSignature
  )
}

/** Full-identity CAS: stale blur/Apply closures have exactly zero effects. */
export function applyWebhookAgentPending<T>(
  state: WebhookAgentResolutionState<T>,
  captured: WebhookAgentPendingIdentity,
): WebhookAgentResolutionState<T> {
  if (state.pending === null || !samePendingIdentity(state.pending.identity, captured)) return state
  return {
    ...state,
    current: state.pending.result,
    refreshing: false,
    pending: null,
  }
}
