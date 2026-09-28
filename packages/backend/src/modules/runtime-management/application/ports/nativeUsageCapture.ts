import type { ObservationCapturedUsage, ObservationTokenUsage } from '@agent-workflow/shared'

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
  readonly contract: 'opencode-child-steps-v1'
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
}
export interface NativeUsageCaptureIdentity {
  readonly invocationId: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly agentId: string | null
  readonly resumeSessionId?: string
  readonly nextRevision?: () => number
}
