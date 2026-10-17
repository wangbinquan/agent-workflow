/** JSON wire protocol between the control plane adapters and the task-image
 * helper. The helper delegates operations to the existing native owners.
 *
 * RFC-370 §9.2 V2: the request travels as base64 argv chunks and the outcome
 * is written to a file in the task volume, so a result survives a lost stream,
 * a service restart and any size limit of the platform's output summary. */
import { DomainError } from '@/util/errors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export const WORKSPACE_CHUNK_BYTES = 24_000
/** CS runs argv through exec(2): argv and env together must stay below the
 * task container's ARG_MAX (2 MiB). The encoded request keeps 0.5 MiB for env. */
export const WORKSPACE_ARGUMENT_BUDGET_BYTES = 1_536 * 1024
export const WORKSPACE_MAX_CHUNKS = Math.floor(
  WORKSPACE_ARGUMENT_BUDGET_BYTES / WORKSPACE_CHUNK_BYTES,
)
/** Largest raw byte chunk a single command may carry inside its JSON input
 * (base64 inside JSON inside base64 grows it by about 16/9). */
export const WORKSPACE_TRANSFER_CHUNK_BYTES = 768 * 1024
/** Volume-relative directory holding one outcome file per command execution. */
export const WORKSPACE_RESULT_DIRECTORY = '.aw/command-results'
/** Outcomes are control data, not payload channels. */
export const WORKSPACE_RESULT_MAX_BYTES = 1024 * 1024

export class WorkspaceCommandStoppedError extends Error {
  constructor(
    readonly outcome: 'aborted' | 'timeout' | 'exited',
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly truncated: boolean,
  ) {
    super(`workspace command ${outcome}${stderr.length > 0 ? `: ${stderr}` : ''}`)
    this.name = 'WorkspaceCommandStoppedError'
  }
}

/** The helper ran the operation and reported its failure. */
export class WorkspaceCommandFailedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'WorkspaceCommandFailedError'
  }
}

export interface WorkspaceHelperRequest {
  readonly version: 2
  readonly operation: string
  readonly input: unknown
  /** Absolute path under the volume root the helper writes its outcome to. */
  readonly resultPath: string
}

export interface WorkspaceHelperFailure {
  readonly code: string
  readonly message: string
  readonly status?: number
  readonly details?: unknown
}

export type WorkspaceHelperOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: WorkspaceHelperFailure }

export interface WorkspaceHelperOptions {
  /** Stable within one logical attempt; a new attempt passes a new id. */
  readonly operationId?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly onStarted?: (receipt: {
    readonly executionId: string
    readonly businessTaskId: string
    readonly subtaskId: string
    readonly attempt: number
  }) => void | Promise<void>
  readonly onOutput?: (stream: 'stdout' | 'stderr', text: string) => void | Promise<void>
}

export interface WorkspaceHelper {
  call<T>(
    taskId: string,
    operation: string,
    input: unknown,
    options?: WorkspaceHelperOptions,
  ): Promise<T>
}

export class WorkspaceCommandInputTooLargeError extends DomainError {
  constructor(operation: string, bytes: number) {
    super(
      'hosted-command-input-too-large',
      `The ${operation} request (${bytes} bytes encoded) exceeds the task container argument limit`,
      413,
      { operation, bytes, limit: WORKSPACE_ARGUMENT_BUDGET_BYTES },
    )
  }
}

export function workspaceHelperArguments(
  operation: string,
  input: unknown,
  resultPath: string,
): string[] {
  const encoded = Buffer.from(
    JSON.stringify({ version: 2, operation, input, resultPath } satisfies WorkspaceHelperRequest),
  ).toString('base64')
  if (encoded.length > WORKSPACE_ARGUMENT_BUDGET_BYTES)
    throw new WorkspaceCommandInputTooLargeError(operation, encoded.length)
  const chunks: string[] = []
  for (let offset = 0; offset < encoded.length; offset += WORKSPACE_CHUNK_BYTES) {
    chunks.push(encoded.slice(offset, offset + WORKSPACE_CHUNK_BYTES))
  }
  return ['agent-workflow', 'workspace', ...chunks]
}

export function decodeWorkspaceHelperArguments(chunks: readonly string[]): WorkspaceHelperRequest {
  if (
    chunks.length === 0 ||
    chunks.length > WORKSPACE_MAX_CHUNKS ||
    chunks.some((chunk) => chunk.length > WORKSPACE_CHUNK_BYTES)
  ) {
    throw new Error('hosted-workspace-input-exceeds-command-limit')
  }
  const request: unknown = JSON.parse(Buffer.from(chunks.join(''), 'base64').toString('utf8'))
  if (
    request === null ||
    typeof request !== 'object' ||
    (request as WorkspaceHelperRequest).version !== 2 ||
    typeof (request as WorkspaceHelperRequest).operation !== 'string' ||
    typeof (request as WorkspaceHelperRequest).resultPath !== 'string'
  ) {
    throw new Error('hosted-workspace-protocol-invalid')
  }
  return request as WorkspaceHelperRequest
}

/** Preserves the code, HTTP status and structured details of a helper error
 * so the control plane reports exactly what the native owner reported. */
export function workspaceHelperFailureOf(error: unknown): WorkspaceHelperFailure {
  if (error instanceof DomainError)
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; detail?: unknown; details?: unknown }
    const details = record.details ?? record.detail
    return {
      code: typeof record.code === 'string' ? record.code : error.name || 'Error',
      message: error.message,
      ...(details === undefined ? {} : { details }),
    }
  }
  return { code: 'workspace-helper-failed', message: String(error) }
}

export function parseWorkspaceHelperOutcome(text: string): WorkspaceHelperOutcome {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object')
    throw new Error('hosted-workspace-result-invalid')
  const record = value as { ok?: unknown; value?: unknown; error?: unknown }
  if (record.ok === true) return { ok: true, value: record.value }
  const error = record.error as Partial<WorkspaceHelperFailure> | undefined
  if (record.ok !== false || typeof error?.code !== 'string' || typeof error.message !== 'string')
    throw new Error('hosted-workspace-result-invalid')
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }
}

export function workspaceHelperValue<T>(outcome: WorkspaceHelperOutcome): T {
  if (outcome.ok) return outcome.value as T
  const { code, message, status, details } = outcome.error
  if (status !== undefined && status >= 400 && status < 600)
    throw new DomainError(code, message, status as ContentfulStatusCode, details)
  throw new WorkspaceCommandFailedError(code, message, details)
}

export function workspaceResultPath(executionKey: string, volumeRoot = '/work'): string {
  return `${volumeRoot.replace(/\/+$/, '')}/${WORKSPACE_RESULT_DIRECTORY}/${executionKey}.json`
}
