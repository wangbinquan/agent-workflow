import type { ObservationNativePassCompletion } from '@agent-workflow/shared'
import type { NativeUsageReadBinding } from './nativeUsageReadBinding'

/** Membership from one completely verified original DB read snapshot, live only inside run(). */
export interface NativeUsageBaselineReadView {
  readonly original: ObservationNativePassCompletion
  readonly snapshotId: string
  readonly databaseGeneration: string
  /** One native transport packet. All steps and all packets remain unlimited. */
  members(stepIds: readonly string[]): Promise<ReadonlySet<string>>
}

/** Platform-owned original reader retained through the entire final root traversal. */
export interface NativeUsageBaselineReadSession {
  run<T>(
    input: {
      readonly binding: NativeUsageReadBinding
      readonly original: ObservationNativePassCompletion
      readonly signal?: AbortSignal
    },
    work: (baseline: NativeUsageBaselineReadView | null) => Promise<T>,
  ): Promise<T>
}
