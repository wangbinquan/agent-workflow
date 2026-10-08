import type { ObservationTokenUsage } from './observationUsage'
import type { CompleteObservationMetrics } from './observationComplete'

/** Original execution facts; none of these references claims an accepted invocation. */
export interface HistoricalObservationExecution {
  readonly kind: 'historical-observed'
  readonly referenceId: string
  readonly sourceKind: 'task' | 'memory-distill' | 'intent-turn' | 'mcp-runtime-test'
  readonly ownerId: string
  readonly attemptId: string | null
  readonly nodeRunId: string | null
  readonly parentTaskId: string | null
  readonly ownerUserId?: string | null
  readonly name: string
  readonly status: string
  readonly originalStatus?: string
  readonly computeKind?: 'agent' | 'non-agent' | 'unknown'
  readonly createdAt: number | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly agentId: string | null
  readonly agentRevision: number | null
  readonly agentName: string | null
  readonly purpose: 'task' | 'system' | 'playground' | 'memory'
  readonly runtime: {
    readonly registrationId: string | null
    readonly configurationRevision: number | null
    readonly protocol: 'opencode' | 'claude-code' | null
    readonly name: string | null
  } | null
  readonly rootSessionId: string | null
  readonly recordedUsage: ObservationTokenUsage | null
}

/** Only original identity/numeric references leave a transcript owner. */
export interface HistoricalObservationEvent {
  readonly id: string
  readonly attemptId: string | null
  readonly sessionId: string | null
  readonly parentSessionId: string | null
  readonly stepId: string | null
  readonly occurredAt: number
}
export interface HistoricalObservationPage<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}
export interface HistoricalObservationPageInput {
  readonly after?: string
  readonly limit: number
}
export interface HistoricalObservationOwnerQuery {
  owners(
    input: HistoricalObservationPageInput,
  ): Promise<HistoricalObservationPage<HistoricalObservationExecution>>
  events(
    ownerId: string,
    input: HistoricalObservationPageInput,
  ): Promise<HistoricalObservationPage<HistoricalObservationEvent>>
}

export interface HistoricalNativeObservationIdentity {
  readonly kind: 'historical-observed'
  readonly passId: string
  readonly referenceId: string
  readonly nativeSource: string
  readonly sourceGeneration: string
  readonly rootSessionId: string
}
export interface HistoricalNativeObservationPage {
  readonly identity: HistoricalNativeObservationIdentity
  readonly ordinal: string
  readonly cursor: string
  readonly nextCursor: string | null
  readonly previousDigest: string
  readonly payloadDigest: string
  readonly cumulativeDigest: string
  readonly scanPositionBefore: string
  readonly scanPositionAfter: string
  readonly scannedRawRows: string
  readonly counts: { readonly sessions: string; readonly parts: string; readonly steps: string }
  readonly sessions: readonly { readonly id: string; readonly parentSessionId: string | null }[]
  readonly steps: readonly {
    readonly id: string
    readonly parentSessionId: string | null
    readonly stepId: string
    readonly occurredAt: number | null
    readonly usage: ObservationTokenUsage
    readonly model: { readonly provider: string; readonly id: string } | null
  }[]
  readonly issues: readonly string[]
  readonly eof: {
    readonly fingerprint: string
    readonly counts: HistoricalNativeObservationPage['counts']
  } | null
}
export interface HistoricalNativeObservationReader {
  readonly identity: HistoricalNativeObservationIdentity
  readonly initialCursor: string
  readonly rootCreatedAt: number | null
  next(cursor: string): HistoricalNativeObservationPage
  acknowledge(ordinal: string, payloadDigest: string): void
  close(): void
}

export interface CompleteHistoricalObservationExecution {
  readonly referenceRole: 'owner' | 'execution'
  readonly execution: HistoricalObservationExecution
  readonly parentTaskName: string | null
  readonly scopeMatch: 'matched' | 'excluded' | 'unresolved'
  readonly timeBasis: 'task-cohort' | 'execution-start' | 'owner-created' | 'unknown-time'
  readonly cohortAt: number | null
  readonly coveredByAcceptedRecords: boolean
  readonly metrics: CompleteObservationMetrics
  readonly issues: readonly string[]
}
export interface CompleteHistoricalObservationRecord {
  readonly kind: 'historical-observed'
  readonly nativeSource: string
  readonly recordId: string
  readonly sessionId: string
  readonly occurredAt: number | null
  readonly model: { readonly provider: string; readonly id: string } | null
  readonly originalUsage: ObservationTokenUsage
  readonly candidateCount: string
  readonly scopeMatch: 'matched' | 'excluded' | 'unresolved'
  readonly coveredByAcceptedRecords: boolean
  readonly includedInTotals: boolean
  readonly versionFingerprint?: string
  readonly metrics: CompleteObservationMetrics
  readonly issues: readonly string[]
}
export interface CompleteHistoricalObservationReference {
  readonly referenceId: string
  readonly execution: HistoricalObservationExecution
  readonly scopeMatch: 'matched' | 'excluded' | 'unresolved'
  readonly timeBasis: CompleteHistoricalObservationExecution['timeBasis']
  readonly cohortAt: number | null
}
