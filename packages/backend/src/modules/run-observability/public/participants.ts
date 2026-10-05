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
import type {
  NativeHistoryPreparation,
  NativeHistoryStep,
  NativeHistoryProgress,
} from '../domain/nativeUsageHistory'
export type { NativeHistoryPreparation } from '../domain/nativeUsageHistory'
export {
  nativeHistoryFingerprint,
  NativeHistoryPreparationSchema,
} from '../domain/nativeUsageHistory'

/** Task owns original history evidence; the unique ledger owns all numeric revisions. */
export interface ObservationNativeHistorySource {
  onReader(reader: object): ObservationNativeHistorySource
  /** Full original read closes before any ledger write; bootstrap selects the actual Worker/channel. */
  prepare(
    value: NativeHistoryPreparation['value'],
    signal?: AbortSignal,
  ): Promise<NativeHistoryPreparation | null>
  /** One transport packet on the actual writer transaction; only an empty original query is EOF. */
  page(
    preparation: NativeHistoryPreparation,
    after: string | null,
  ): Promise<readonly NativeHistoryStep[]>
}

/** Task supplies actual immutable page/source facts on the original database reader. */
export interface ObservationNativeScopeSource {
  /** Opaque owner handle; infrastructure alone resolves the actual ledger/report reader. */
  onReader(reader: object): ObservationNativeScopeSource
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
  /** One committed original history packet for this accepted invocation, without scanning other Tasks. */
  reconcileNativeHistory?(invocationId: string): Promise<NativeHistoryProgress | undefined>
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
  readonly nativeHistory?: ObservationNativeHistorySource
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
