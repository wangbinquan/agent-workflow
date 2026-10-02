import type {
  AcceptedObservationInvocation,
  ObservationCapturedUsage,
  ObservationSpanOwnerProof,
  ObservationSpanScope,
  ObservationSpanState,
} from '@agent-workflow/shared'

/** Allowlisted native metadata. This deliberately contains no numeric counters. */
export interface NativeSpan {
  readonly sessionId: string
  readonly parentSessionId: string | null
  readonly ancestors: readonly string[]
  readonly callId: string
  readonly kind: ObservationSpanScope['kind']
  readonly label: string
  readonly parentCallId: string | null
  readonly model: { readonly provider: string | null; readonly id: string } | null
  readonly measurementRecordId: string | null
  readonly state: ObservationSpanState
  readonly issues?: readonly string[]
  readonly origin?: 'creation' | 'completion'
}
export interface NativeSpanSnapshot {
  readonly rootSessionId: string
  readonly rootCreatedAt: number | null
  readonly clockQuality: 'same-host-native' | 'unknown'
  readonly spans: readonly NativeSpan[]
  readonly fingerprint: string | null
  readonly scannedSessions: number
  readonly scannedParts: number
  readonly issues: readonly string[]
}
export interface NativeSpanOwnerLookup {
  readonly owners: readonly ObservationSpanOwnerProof[]
  readonly complete: boolean
  readonly issues: readonly string[]
}
export interface NativeSpanCaptureIdentity {
  readonly accepted: AcceptedObservationInvocation
  readonly resumeSessionId?: string
  readonly lookupOwners: (input: {
    readonly sourceNamespace: string
    readonly rootSessionId: string
    readonly limit: number
  }) => Promise<NativeSpanOwnerLookup>
}
export interface NativeSpanRootBinding {
  readonly rootSessionId: string
  readonly epoch: number
  readonly mode: 'fresh' | 'resume' | 'reset'
  readonly sourceNamespace: string
  readonly originalRootAccepted: boolean
  readonly spawnedAt: number | null
}
export interface NativeSpanCapture {
  readonly contract: 'runtime-span-facts-v1'
  readonly sourceNamespace: string
  /** The resume baseline and original owners are frozen after acceptance, before spawn. */
  begin(): Promise<void>
  /** Starts bounded scope lookup without delaying business output. Never persists itself. */
  bindRoot(binding: NativeSpanRootBinding): void
  observe(span: NativeSpan, rootSessionId: string, epoch: number): void
  flush(capturedAt: number): ObservationCapturedUsage[]
  /** Reap/drain precede final reads. A late lookup can never write after this closes. */
  finish(
    roots: readonly NativeSpanRootBinding[],
    capturedAt: number,
    issues?: readonly string[],
  ): Promise<ObservationCapturedUsage[]>
}
