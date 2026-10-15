import type { Logger } from '@/util/log'

/** One selected attempt; implementation identities and receipts stay opaque. */
export interface ExecutionStartReceipt {
  readonly executionRef: string
  readonly startedAt: number
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

/** Current real callers consume submit. Recovery/event transport and message
 * capabilities acquire their own consumers in the remaining A-T5/A-T6 work. */
export interface ExecutionEffectPort {
  submit(request: ExecutionEffectRequest): Promise<ExecutionEffectResult>
}
