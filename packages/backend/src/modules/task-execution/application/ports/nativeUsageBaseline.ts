import type { ObservationNativePassCompletion } from '@agent-workflow/shared'

/** Membership from one completely verified original DB read snapshot, live only inside run(). */
export interface NativeUsageBaselineReadView {
  readonly original: ObservationNativePassCompletion
  readonly snapshotId: string
  readonly databaseGeneration: string
  /** One native transport packet. All steps and all packets remain unlimited. */
  members(stepIds: readonly string[]): Promise<ReadonlySet<string>>
}
