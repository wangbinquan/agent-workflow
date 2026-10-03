import type {
  AcceptedObservationInvocation,
  ObservationTaskFacts,
  CompleteObservationTask,
  ObservationTokenUsage,
} from '@agent-workflow/shared'
import type { UsageContributionEvidence } from '../domain/usageSelection'
import type { CompleteObservationFold } from '../domain/completeObservationMetrics'
import type { PlatformObservation } from '../domain/platformObservation'
import type { CompleteObservationSources } from './completeObservationSources'
import type { CompleteWorkingRows } from './completeWorkingRows'
import type { CompleteSourceReceipt } from './completeReport'
import type { CompleteUsageWorkspace } from './completeUsageWorkspace'

export interface CompleteObservationContribution extends UsageContributionEvidence {
  readonly invocationId: string
  readonly observedAt: number
  readonly localModel: { readonly provider: string | null; readonly id: string } | null
  readonly platformUsage?: Extract<PlatformObservation, { kind: 'usage' }>
}
export interface CompleteInvocationWorking {
  readonly invocation: AcceptedObservationInvocation
  fold: CompleteObservationFold
  rawRecords: string
  nativeComplete: boolean
  nativeCaptureCount: string
  knownZero: boolean
  emptyCostVisible: boolean
}
export interface CompleteObservationTaskInput {
  readonly task: ObservationTaskFacts
  readonly sources: CompleteObservationSources
  readonly asOf: number
  readonly rows: CompleteWorkingRows
  readonly namespace: string
  readonly keyOf: (value: string) => string
  readonly signal?: AbortSignal
  readonly usageWorkspace: (input: {
    readonly rows: CompleteWorkingRows
    readonly namespace: string
    readonly keyOf: (value: string) => string
    readonly identity: (record: CompleteObservationContribution) => string
    readonly signal?: AbortSignal
  }) => {
    readonly workspace: CompleteUsageWorkspace<CompleteObservationContribution>
    append(items: readonly CompleteObservationContribution[]): Promise<void>
    seal(expectedRows: string): void
    flush(): Promise<void>
    readonly allocationsNamespace: string
  }
  /** The same original snapshot's accepted catalogue, never a mutable current rate. */
  readonly value: (input: {
    readonly invocationId: string
    readonly model: CompleteObservationContribution['localModel']
    readonly condition: string | null
    readonly usage: ObservationTokenUsage
  }) => Promise<{
    readonly availability: string
    readonly amountDecimal: string | null
    readonly completeness?: string
  }>
}
export interface CompleteObservationTaskBuild {
  readonly summary: CompleteObservationTask
  readonly fold: CompleteObservationFold
  readonly sourceReceipts: readonly CompleteSourceReceipt[]
  readonly attemptsNamespace: string
  readonly invocationsNamespace: string
  readonly allocationsNamespace: string
  readonly nativeCapturesNamespace: string
  readonly platformCapturesNamespace: string
}
