// RFC-370 v2 §5.2 — the CrewStation v3 business-execution surface aw uses.
//
// One aw task owns one persistent business task (its `/work` volume); agent
// and command subtasks run against it. Every mutation carries the execution
// fence and a caller requestKey, so a retried call is a lookup of the original
// operation, never a second one. Shapes declare only the fields aw reads.
import type { CrewStationPlatformApi } from './platformApi'

export interface BusinessExecutionFence {
  readonly epoch: number
  readonly leaseId: string
  readonly instanceId: string
}

export type BusinessTaskState = 'creating' | 'running' | 'paused' | 'closing' | 'closed' | 'failed'

export interface BusinessTask {
  readonly id: string
  readonly state: BusinessTaskState | string
  readonly generation: number
  readonly resourceState?: string
  readonly message?: string
}

export type BusinessSubtaskState =
  | 'admitting'
  | 'pending'
  | 'running'
  | 'awaiting-input'
  | 'verifying'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface BusinessResult {
  readonly exitCode: number | null
  readonly reason: string
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly finalCursor: string
}

export interface BusinessSubtask {
  readonly id: string
  readonly taskId: string
  readonly kind: 'agent' | 'command'
  readonly attempt: number
  readonly state: BusinessSubtaskState | string
  readonly executionId: string
  readonly sessionId?: string
  readonly materialDigest?: string
  readonly result?: BusinessResult
  readonly error?: { readonly code: string; readonly message: string }
}

export interface BusinessUsageSnapshot {
  readonly measurementId: string
  readonly scope: string
  readonly mode: 'cumulative' | 'delta'
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly complete: boolean
  readonly snapshot?: unknown
}

interface EventEnvelope {
  readonly taskId: string
  readonly subtaskId?: string
  readonly attempt?: number
  readonly cursor: string
  readonly occurredAt: string
  readonly sourceEventId: string
}

export type BusinessEvent = EventEnvelope &
  (
    | {
        readonly type: 'task-state'
        readonly data: { readonly state: string; readonly generation: number }
      }
    | {
        readonly type: 'execution-state'
        readonly data: {
          readonly state: string
          readonly process: string
          readonly reason?: string
        }
      }
    | { readonly type: 'text'; readonly data: { readonly text: string } }
    | {
        readonly type: 'tool-start'
        readonly data: { readonly callId: string; readonly name: string; readonly input?: unknown }
      }
    | {
        readonly type: 'tool-end'
        readonly data: {
          readonly callId: string
          readonly name: string
          readonly output?: unknown
          readonly isError: boolean
        }
      }
    | { readonly type: 'session'; readonly data: { readonly sessionId: string } }
    | { readonly type: 'usage'; readonly data: BusinessUsageSnapshot }
    | {
        readonly type: 'output'
        readonly data: { readonly stream: 'stdout' | 'stderr'; readonly text: string }
      }
    | { readonly type: 'result'; readonly data: BusinessResult }
    | {
        readonly type: 'gap'
        readonly data: { readonly reason: string; readonly earliestCursor: string }
      }
  )

export interface BusinessEventPage {
  readonly items: readonly BusinessEvent[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export interface BusinessMaterial {
  readonly materialId: string
  readonly digest: string
  readonly sizeBytes: number
}

export interface BusinessFileChunk {
  readonly path: string
  readonly version: string
  readonly size: number
  readonly offset: number
  readonly contentBase64: string
  readonly nextOffset: number | null
}

export interface BusinessDirectory {
  readonly path: string
  readonly entries: ReadonlyArray<{
    readonly name: string
    readonly kind: 'file' | 'dir' | 'symlink'
    readonly size: number
    readonly modifiedAt: string
  }>
  readonly nextCursor: string | null
}

export type SubmitBusinessSubtask =
  | {
      readonly kind: 'agent'
      readonly requestKey: string
      readonly fence: BusinessExecutionFence
      readonly name: string
      readonly cwd?: string
      readonly agentProfileId: string
      readonly prompt: string
      readonly materialId?: string
      readonly resumeSessionId?: string
    }
  | {
      readonly kind: 'command'
      readonly requestKey: string
      readonly fence: BusinessExecutionFence
      readonly name: string
      readonly cwd?: string
      readonly argv: readonly string[]
      readonly env?: Readonly<Record<string, string>>
      readonly timeoutSeconds?: number
    }

export interface CreateBusinessMaterial {
  readonly requestKey: string
  readonly fence: BusinessExecutionFence
  readonly systemPrompt?: string
  readonly skills?: ReadonlyArray<{ readonly path: string; readonly content: string }>
  readonly env?: Readonly<Record<string, string>>
}

const TASKS = '/v3/business-tasks'

/** Subtask names are display labels (≤ 80 chars). */
export function businessSubtaskName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  return (trimmed.length === 0 ? 'aw' : trimmed).slice(0, 80)
}

export function isTerminalSubtaskState(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

export interface CrewStationBusinessExecution {
  createTask(input: {
    readonly requestKey: string
    readonly fence: BusinessExecutionFence
    readonly taskContractVersion: string
    readonly labels: Readonly<Record<string, string>>
  }): Promise<BusinessTask>
  getTask(taskId: string): Promise<BusinessTask>
  closeTask(
    taskId: string,
    input: {
      readonly requestKey: string
      readonly fence: BusinessExecutionFence
      readonly expectedGeneration: number
    },
  ): Promise<void>
  createMaterial(taskId: string, input: CreateBusinessMaterial): Promise<BusinessMaterial>
  submitSubtask(taskId: string, input: SubmitBusinessSubtask): Promise<BusinessSubtask>
  getSubtask(taskId: string, subtaskId: string): Promise<BusinessSubtask>
  cancelSubtask(
    taskId: string,
    subtaskId: string,
    input: {
      readonly requestKey: string
      readonly fence: BusinessExecutionFence
      readonly expectedAttempt: number
    },
  ): Promise<void>
  events(
    taskId: string,
    query: { readonly after?: string; readonly limit?: number; readonly subtaskId?: string },
  ): Promise<BusinessEventPage>
  streamEvents(
    taskId: string,
    query: { readonly after?: string; readonly subtaskId?: string },
    signal?: AbortSignal,
  ): AsyncIterable<BusinessEvent>
  readFile(
    taskId: string,
    query: {
      readonly path: string
      readonly offset?: number
      readonly limit?: number
      readonly version?: string
    },
  ): Promise<BusinessFileChunk>
  listFiles(
    taskId: string,
    query: { readonly path?: string; readonly after?: string; readonly limit?: number },
  ): Promise<BusinessDirectory>
}

export function createCrewStationBusinessExecution(
  platform: CrewStationPlatformApi,
): CrewStationBusinessExecution {
  const task = (taskId: string) => `${TASKS}/${encodeURIComponent(taskId)}`
  return Object.freeze<CrewStationBusinessExecution>({
    createTask: (input) =>
      platform.post<BusinessTask>(TASKS, {
        requestKey: input.requestKey,
        fence: input.fence,
        taskContractVersion: input.taskContractVersion,
        volumeMode: 'persistent',
        labels: input.labels,
      }),
    getTask: (taskId) => platform.get<BusinessTask>(task(taskId)),
    async closeTask(taskId, input) {
      await platform.post(`${task(taskId)}/close`, input)
    },
    createMaterial: (taskId, input) =>
      platform.post<BusinessMaterial>(`${task(taskId)}/materials`, {
        requestKey: input.requestKey,
        fence: input.fence,
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        skills: input.skills ?? [],
        env: input.env ?? {},
      }),
    submitSubtask: (taskId, input) =>
      platform.post<BusinessSubtask>(`${task(taskId)}/subtasks`, {
        ...input,
        name: businessSubtaskName(input.name),
      }),
    getSubtask: (taskId, subtaskId) =>
      platform.get<BusinessSubtask>(`${task(taskId)}/subtasks/${encodeURIComponent(subtaskId)}`),
    async cancelSubtask(taskId, subtaskId, input) {
      await platform.post(`${task(taskId)}/subtasks/${encodeURIComponent(subtaskId)}/cancel`, input)
    },
    events: (taskId, query) =>
      platform.get<BusinessEventPage>(`${task(taskId)}/events`, {
        after: query.after,
        limit: query.limit,
        subtaskId: query.subtaskId,
      }),
    streamEvents: (taskId, query, signal) =>
      platform.stream<BusinessEvent>(`${task(taskId)}/events/stream`, query, signal),
    readFile: (taskId, query) =>
      platform.get<BusinessFileChunk>(`${task(taskId)}/file`, {
        path: query.path,
        offset: query.offset,
        limit: query.limit,
        version: query.version,
      }),
    listFiles: (taskId, query) =>
      platform.get<BusinessDirectory>(`${task(taskId)}/files`, {
        path: query.path,
        after: query.after,
        limit: query.limit,
      }),
  })
}
