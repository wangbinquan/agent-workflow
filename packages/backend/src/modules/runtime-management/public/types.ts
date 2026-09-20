/** Runtime protocol identity shared by provider-neutral module contracts. */
export type RuntimeKind = 'opencode' | 'claude-code'

/** The existing diagnostic wire, independent of the process adapter's options. */
export interface RuntimeSmokeResult {
  readonly outcome:
    | 'conforms'
    | 'spawn-failed'
    | 'auth-missing'
    | 'network-blocked'
    | 'model-call-failed'
    | 'stream-nonconforming'
  readonly conforms: boolean
  readonly detail: string
  readonly capturedSessionId?: string
  readonly sawNonce: boolean
  readonly sawEnvelope: boolean
  readonly exitCode: number | null
}

/** Durable marker emitted when a distillation runtime transcript cannot be captured. */
export const DISTILL_CAPTURE_FAILED_KIND = 'rfc043/distill-capture-failed'
