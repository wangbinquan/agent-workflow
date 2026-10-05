import type {
  AcceptObservationInvocation,
  AcceptedObservationInvocation,
  ObservationCapturedUsage,
  ObservationSpanOwnerProof,
  ObservationSpanSourceInput,
  ObservationSpanSourcePage,
  ObservationIngest,
  ObservationNativeScopeReference,
  ObservationUsageCaptureCommit,
} from '@agent-workflow/shared'
import type { NativeUsageScopeFacts } from '../domain/nativeUsageScope'
import type { ProviderNeutralDatabase } from '@/db/query'

/** Task supplies actual immutable page/source facts on the original database reader. */
export interface ObservationNativeScopeSource {
  /** Infrastructure binds all original reads to the actual ledger/report transaction handle. */
  onReader(reader: ProviderNeutralDatabase): ObservationNativeScopeSource
  verify(input: ObservationIngest): Promise<void>
  qualify(
    value: ObservationUsageCaptureCommit & {
      readonly sourceId: string
      readonly sourceCursor: string
    },
  ): Promise<{
    readonly records: string | null
    readonly complete: boolean
  }>
  resolve(
    binding: {
      readonly invocationId: string
      readonly taskId: string
      readonly nodeRunId: string | null
    },
    scope: ObservationNativeScopeReference,
  ): Promise<NativeUsageScopeFacts>
  path(
    binding: {
      readonly invocationId: string
      readonly taskId: string
      readonly nodeRunId: string | null
    },
    scope: ObservationNativeScopeReference,
  ): AsyncIterable<{
    readonly session: string
    readonly parentSession: string | null
    readonly depth: string
    readonly pathDigest: string
  }>
}

export type {
  CompleteObservationBuildResult,
  CompleteObservationStoredReport,
} from '../ports/completeObservationReport'

/** Execution supplies frozen facts; bootstrap selects the accounting authority. */
export type ObservationInvocationStart = Omit<AcceptObservationInvocation, 'authority'> & {
  readonly runtime: Extract<AcceptObservationInvocation['authority'], { kind: 'local' }>['runtime']
}

export interface ObservationInvocationParticipant {
  /** Must persist before spawn. A rejection prevents an unrecorded invocation. */
  accept(input: ObservationInvocationStart): Promise<AcceptedObservationInvocation>
  /** Bounded projection of committed evidence; failures leave the durable source pending. */
  reconcile?(nodeRunId?: string): Promise<number>
  /** Frozen creation proofs only; missing capability is explicit partial coverage. */
  spanOwners?(input: {
    readonly invocationId: string
    readonly sourceNamespace: string
    readonly rootSessionId: string
    readonly limit: number
  }): Promise<{
    readonly owners: readonly ObservationSpanOwnerProof[]
    readonly complete: boolean
    readonly issues: readonly string[]
  }>
}

/** The execution owner supplies numeric-only committed facts and delivery acknowledgements. */
export interface ObservationUsageSource {
  readonly nativeScopes?: ObservationNativeScopeSource
  spanSources?(input: ObservationSpanSourceInput): Promise<ObservationSpanSourcePage>
  pending(input: {
    readonly limit: number
    readonly nodeRunId?: string
    readonly afterNodeRunId?: string
  }): Promise<
    readonly {
      readonly id: number
      readonly taskId: string
      readonly nodeRunId: string
      readonly evidence: ObservationCapturedUsage
    }[]
  >
  acknowledge(ids: readonly number[]): Promise<void>
}
