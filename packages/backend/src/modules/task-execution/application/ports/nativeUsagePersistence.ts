import type {
  ObservationNativePassAck,
  ObservationNativePassAdmission,
  ObservationNativePassIdentity,
  ObservationNativePassPage,
} from '@agent-workflow/shared'
import type {
  ObservationAnyNativeCompletion,
  ObservationNativeBeforeSpawnAck,
  ObservationNativeMeasurement,
  ObservationNativeSourceAck,
  ObservationNativeScopeReference,
} from '@agent-workflow/shared'
import type { ObservationCapturedUsage, ObservationMeasurement } from '@agent-workflow/shared'
import type { TaskExecutionContextRef } from './taskExecutionTopology'
import type { ObservationNativeProcessFact } from '@agent-workflow/shared'

/** Bound to the actual accepted invocation and trusted original Task claim. */
export interface NativeUsageOwnerBinding {
  readonly taskId: string
  readonly nodeRunId: string
  readonly invocationId: string
  readonly executionContext: TaskExecutionContextRef
}
/** Read-only original identity; it grants no execution claim or write capability. */
export type NativeUsageReadBinding = Pick<
  NativeUsageOwnerBinding,
  'taskId' | 'nodeRunId' | 'invocationId'
>
export type NativeUsageSourceAck = ObservationNativeSourceAck
export type NativeUsageEvidence = Omit<ObservationCapturedUsage, 'measurements' | 'capture'> & {
  readonly measurements: readonly (ObservationMeasurement | ObservationNativeMeasurement)[]
  readonly nativeProcess?: ObservationNativeProcessFact
}
/** Internal Task owner seam. All positive receipts follow the original transaction commit. */
export interface NativeUsagePersistence {
  /** Commits the actual original before-spawn operation even while a fresh root is not born. */
  prepare(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly nativeSource: string
    readonly sourceGeneration: string | null
    readonly sourceAbsentAt?: number
    readonly resumeRootSessionId: string | null
  }): Promise<ObservationNativeBeforeSpawnAck>
  admit(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly identity: ObservationNativePassIdentity
    readonly initialCursor: string
    readonly beforeSpawnReceiptId: string
    /** Original root row from the reader's actual snapshot; frozen with the admission. */
    readonly rootCreatedAt: number | null
    readonly supersedes?: string
  }): Promise<ObservationNativePassAdmission>
  persist(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly page: ObservationNativePassPage
  }): Promise<ObservationNativePassAck>
  interrupt(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly identity: ObservationNativePassIdentity
    readonly reason: string
  }): Promise<void>
  /** Only a complete original baseline may exclude a step from resumed usage. */
  baselineMember(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly passId: string
    readonly stepId: string
  }): Promise<boolean>
  /** Complete immutable membership, paged through EOF; limit bounds one response only. */
  steps(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly passId: string
    readonly after: string | null
    readonly limit: number
  }): Promise<{
    readonly items: readonly ObservationNativePassPage['steps'][number][]
    readonly nextCursor: string | null
  }>
  /** Rejects absent, cyclic or conflicting parent links; never manufactures empty ancestry. */
  parent(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly reference: ObservationNativeScopeReference
    readonly sessionId: string
  }): Promise<string | null>
  /** Allocates revisions above observed, pending and frozen originals in the same owner TX. */
  emit(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly eventId: string
    readonly evidence: NativeUsageEvidence
  }): Promise<NativeUsageSourceAck>
  /** Verifies every page, membership, emission and original process receipt before appending. */
  seal(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly completion: ObservationAnyNativeCompletion
  }): Promise<NativeUsageSourceAck>
}
