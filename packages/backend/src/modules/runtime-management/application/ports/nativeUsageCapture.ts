import type {
  ObservationCapturedUsage,
  ObservationTokenUsage,
  ObservationNativeBeforeSpawnAck,
  ObservationNativeProcessFact,
  ObservationNativeSourceAck,
} from '@agent-workflow/shared'
import type { NativeUsagePassOwner } from './nativeUsageOwner'

export interface NativeUsageStep {
  readonly id: string
  readonly sessionId: string
  readonly parentSessionId: string | null
  readonly ancestors: readonly string[]
  readonly occurredAt: number | null
  readonly usage: ObservationTokenUsage
  readonly model: { readonly provider: string; readonly id: string } | null
}
export interface NativeUsageSnapshot {
  readonly steps: readonly NativeUsageStep[]
  readonly sessions: number
  readonly fingerprint: string | null
  readonly issues: readonly string[]
}
export interface NativeUsageCapture {
  readonly contract: 'opencode-child-steps-v1' | 'opencode-child-pages-v2'
  readonly nativeSource: string
  includesRecord(recordId: string): boolean
  /** Called only after local acceptance, before spawning the runtime. */
  begin(): void
  /** Called only after process reap and stream drain. Never changes the business outcome. */
  finish(
    rootSessionId: string | null,
    observedAt: number,
    issues?: readonly string[],
  ): ObservationCapturedUsage[]
  /** Original durable Task owner: each page commits before the reader releases it. */
  beginDurable?(): Promise<void>
  finishDurable?(rootSessionId: string | null): Promise<void>
  recordProcess?(fact: ObservationNativeProcessFact): Promise<void>
  sealDurable?(): Promise<void>
}
/** The actual Task claim issues this invocation-bound participant. It contains no database,
 * environment, file location, PID supplier or reconstructed execution token. */
export interface NativeUsageDurableOwner {
  prepare(input: {
    readonly nativeSource: string
    readonly sourceGeneration: string
    readonly resumeRootSessionId: string | null
  }): Promise<ObservationNativeBeforeSpawnAck>
  passOwner(before: ObservationNativeBeforeSpawnAck): NativeUsagePassOwner
  recordProcess(fact: ObservationNativeProcessFact): Promise<ObservationNativeSourceAck>
  seal(observedAt: number): Promise<ObservationNativeSourceAck>
}
export interface NativeUsageCaptureIdentity {
  readonly invocationId: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly agentId: string | null
  readonly resumeSessionId?: string
  readonly nextRevision?: () => number
  readonly durableOwner?: NativeUsageDurableOwner
}
