import type { Logger } from '@/util/log'

/** One selected attempt; implementation identities and receipts stay opaque. */
export interface ExecutionStartReceipt {
  readonly executionRef: string
  readonly startedAt: number
  /** Opaque durable original identity; interpreted only by its selected owner. */
  readonly recoveryRef?: string
}

export type ExecutionOutcome =
  | 'ok'
  | 'nonzero-exit'
  | 'timeout'
  | 'aborted'
  | 'spawn-failed'
  | 'unreaped'

export interface ExecutionCapture {
  readonly onStdoutLine?: (line: string) => void | Promise<void>
  readonly onStderrLine?: (line: string) => void | Promise<void>
  readonly onStdoutChunkEnd?: () => void | Promise<void>
  readonly onStderrChunkEnd?: () => void | Promise<void>
  readonly onLineTruncated?: () => void | Promise<void>
  readonly rawStdout?: boolean
}

/** Capture callbacks acknowledge the original line/chunk before it advances.
 * Material and workspace references are resolved by the selected binding. */
export interface ExecutionEffectRequest {
  readonly executionRef: string
  readonly materialRef: string
  readonly workspaceRef: string
  readonly timeoutMs?: number
  readonly termGraceMs?: number
  readonly abortSignal?: AbortSignal
  readonly beforeStart?: () => void | Promise<void>
  readonly onStarted?: (receipt: ExecutionStartReceipt) => void | Promise<void>
  readonly capture?: ExecutionCapture
  readonly cleanup?: () => void | Promise<void>
  readonly log?: Logger
}

export interface ExecutionEffectResult {
  readonly executionRef: string
  readonly outcome: ExecutionOutcome
  readonly exitCode: number | null
  readonly rawStdout: string
  readonly stderrTail: string
  readonly durationMs: number
  readonly spawnError?: string
  readonly cleanupFailed?: boolean
  readonly drainTimedOut?: boolean
  readonly pumpError?: string
}

export interface ExecutionRecoveryResult {
  readonly executionRef: string
  /** Acknowledges physical retirement only; never a business success/exit code. */
  readonly state: 'reaped' | 'unknown'
}

/** Recover only the selected original attempt. Missing facts remain unknown. */
export interface ExecutionRecoveryPort {
  recoverOriginal(input: { readonly executionRef: string }): Promise<ExecutionRecoveryResult>
}

/** Rebuild recovery from the original durable receipt without a new binding/submit. */
export interface ExecutionRecoveryReferencePort {
  recoverReference(input: {
    readonly executionRef: string
    readonly recoveryRef: string
  }): Promise<ExecutionRecoveryResult>
}

export interface ExecutionEffectPort extends ExecutionRecoveryPort {
  submit(request: ExecutionEffectRequest): Promise<ExecutionEffectResult>
}
