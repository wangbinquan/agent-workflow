/** JSON wire protocol between the control plane adapters and the task-image
 * helper. The helper delegates operations to the existing native owners. */
export const WORKSPACE_RESULT_PREFIX = 'AW_WORKSPACE_RESULT_V1:'
export const WORKSPACE_CHUNK_BYTES = 24_000
export const WORKSPACE_MAX_CHUNKS = 1_020

export class WorkspaceCommandStoppedError extends Error {
  constructor(
    readonly outcome: 'aborted' | 'timeout' | 'exited',
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly truncated: boolean,
  ) {
    super(`workspace command ${outcome}: ${stderr}`)
    this.name = 'WorkspaceCommandStoppedError'
  }
}

export interface WorkspaceHelperRequest {
  readonly version: 1
  readonly operation: string
  readonly input: unknown
}

export interface WorkspaceHelper {
  call<T>(
    taskId: string,
    operation: string,
    input: unknown,
    options?: {
      readonly operationId?: string
      readonly signal?: AbortSignal
      readonly timeoutMs?: number
      readonly nodeRunId?: string
      readonly onStarted?: (receipt: {
        readonly executionId: string
        readonly businessTaskId: string
        readonly subtaskId: string
        readonly attempt: number
      }) => void | Promise<void>
      readonly onOutput?: (stream: 'stdout' | 'stderr', text: string) => void | Promise<void>
    },
  ): Promise<T>
}

export function workspaceHelperArguments(operation: string, input: unknown): string[] {
  const encoded = Buffer.from(
    JSON.stringify({ version: 1, operation, input } satisfies WorkspaceHelperRequest),
  ).toString('base64')
  const chunks: string[] = []
  for (let offset = 0; offset < encoded.length; offset += WORKSPACE_CHUNK_BYTES) {
    chunks.push(encoded.slice(offset, offset + WORKSPACE_CHUNK_BYTES))
  }
  if (chunks.length > WORKSPACE_MAX_CHUNKS)
    throw new Error('hosted-workspace-input-exceeds-command-limit')
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
    (request as WorkspaceHelperRequest).version !== 1 ||
    typeof (request as WorkspaceHelperRequest).operation !== 'string'
  ) {
    throw new Error('hosted-workspace-protocol-invalid')
  }
  return request as WorkspaceHelperRequest
}

export function workspaceHelperResult<T>(stdout: string): T {
  const line = stdout.trimEnd().split('\n').at(-1)
  if (line === undefined || !line.startsWith(WORKSPACE_RESULT_PREFIX)) {
    throw new Error('hosted-workspace-result-missing')
  }
  const result = JSON.parse(line.slice(WORKSPACE_RESULT_PREFIX.length)) as {
    ok: boolean
    value?: T
    error?: string
  }
  if (!result.ok) throw new Error(result.error ?? 'hosted-workspace-helper-failed')
  return result.value as T
}
