import type {
  ObservationCapturedUsage,
  ObservationTokenUsage,
  ObservationNativeBeforeSpawnAck,
  ObservationNativeProcessFact,
  ObservationNativeSourceAck,
  ObservationNativePassAck,
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
  readonly contract:
    | 'opencode-child-steps-v1'
    | 'opencode-child-pages-v2'
    | 'opencode-child-root-pages-v3'
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
  /** Actual lease source population, frozen after reap/drain; packet size never caps roots. */
  readonly rootCollection?: {
    freeze(): Promise<void>
    page(after: string | null): Promise<readonly string[]>
  }
  prepare(input: {
    readonly nativeSource: string
    readonly sourceGeneration: string | null
    readonly sourceAbsentAt?: number
    readonly resumeRootSessionId: string | null
  }): Promise<ObservationNativeBeforeSpawnAck>
  passOwner(before: ObservationNativeBeforeSpawnAck): NativeUsagePassOwner
  /** A resume may keep one verified original before snapshot alive for every final page. */
  withFinalOwner?(
    before: ObservationNativeBeforeSpawnAck,
    read: (owner: NativeUsagePassOwner) => Promise<ObservationNativePassAck>,
  ): Promise<ObservationNativePassAck>
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
