// RFC-370 v2 §5.2 — the CrewStation v3 business-execution surface aw uses.
//
// One aw task owns one persistent business task (its `/work` volume); agent
// and command subtasks run against it. Every mutation carries the execution
// fence and a caller requestKey, so a retried call is a lookup of the original
// operation, never a second one. Shapes declare only the fields aw reads.
import { isCrewStationApiError, type CrewStationPlatformApi } from './platformApi'
import type { HostedStartupInventory } from './startupInventory'
import type {
  BusinessEnvironmentValue,
  BusinessMaterialFile,
  BusinessNativeConfig,
} from './nativeMaterial'

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
  /** `archive-and-delete`: the volume is reclaimed by finalizing (RFC-035);
   * absent or `legacy` (parents created before): closing keeps the volume. */
  readonly completionPolicy?: 'legacy' | 'archive-and-delete'
  readonly volumeUid?: string | null
  readonly contractDigest?: string
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
  readonly previousId?: string
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
          /** A call reported only once, finished (OpenCode), carries its input here. */
          readonly input?: unknown
          readonly output?: unknown
          readonly isError: boolean
        }
      }
    | { readonly type: 'session'; readonly data: { readonly sessionId: string } }
    | { readonly type: 'usage'; readonly data: BusinessUsageSnapshot }
    | { readonly type: 'startup-inventory'; readonly data: HostedStartupInventory }
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
      readonly startupInventoryVersion?: 1
    }
  | {
      readonly kind: 'command'
      readonly requestKey: string
      readonly fence: BusinessExecutionFence
      readonly name: string
      readonly cwd?: string
      readonly argv: readonly string[]
      readonly env?: Readonly<Record<string, BusinessEnvironmentValue>>
      readonly timeoutSeconds?: number
    }

export interface CreateBusinessMaterial {
  readonly requestKey: string
  readonly fence: BusinessExecutionFence
  readonly systemPrompt?: string
  readonly skills?: readonly BusinessMaterialFile[]
  readonly nativeConfig?: BusinessNativeConfig
  readonly env?: Readonly<Record<string, BusinessEnvironmentValue>>
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

/** RFC-370 §9.2 V3 — the parent was paused (or is still resuming) between
 * the caller's readiness check and this request; resuming it and repeating
 * the same idempotent request is the recovery. */
export function isParentNotRunningError(error: unknown): boolean {
  return (
    isCrewStationApiError(error) &&
    (error.code === 'task_paused' || error.code === 'task_not_running')
  )
}

export interface CrewStationBusinessExecution {
  createTask(input: {
    readonly requestKey: string
    readonly fence: BusinessExecutionFence
    readonly taskContractVersion: string
    readonly labels: Readonly<Record<string, string>>
  }): Promise<BusinessTask>
  getTask(taskId: string): Promise<BusinessTask>
  /** Releases a `legacy` parent; its persistent volume is kept (RFC-027). */
  closeTask(
    taskId: string,
    input: {
      readonly requestKey: string
      readonly fence: BusinessExecutionFence
      readonly expectedGeneration: number
    },
  ): Promise<void>
  /** Ends an `archive-and-delete` parent: compute stops, the archive (none for
   * AW) is settled and the volume deleted (RFC-035 finalization). */
  finalizeTask(
    taskId: string,
    input: {
      readonly requestKey: string
      readonly fence: BusinessExecutionFence
      readonly expectedGeneration: number
      readonly outcome: 'succeeded' | 'failed' | 'cancelled'
      readonly archive: { readonly noArtifactsReason: string }
    },
  ): Promise<void>
  /** Releases the task container while keeping the persistent volume (RFC-027). */
  pauseTask(
    taskId: string,
    input: {
      readonly requestKey: string
      readonly fence: BusinessExecutionFence
      readonly expectedGeneration: number
    },
  ): Promise<void>
  resumeTask(
    taskId: string,
    input: {
      readonly requestKey: string
      readonly fence: BusinessExecutionFence
      readonly expectedGeneration: number
    },
  ): Promise<void>
  /** Every subtask of the task, including non-terminal ones. */
  listSubtasks(taskId: string): Promise<readonly BusinessSubtask[]>
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
        // RFC-370 hosted acceptance (2026-10-18): a `legacy` parent keeps its
        // persistent volume when it is closed, so every deleted task leaked a
        // PVC until the project's volume quota blocked new tasks.
        completionPolicy: 'archive-and-delete',
        labels: input.labels,
      }),
    getTask: (taskId) => platform.get<BusinessTask>(task(taskId)),
    async closeTask(taskId, input) {
      await platform.post(`${task(taskId)}/close`, input)
    },
    async finalizeTask(taskId, input) {
      await platform.post(`${task(taskId)}/finalize`, input)
    },
    async pauseTask(taskId, input) {
      await platform.post(`${task(taskId)}/pause`, input)
    },
    async resumeTask(taskId, input) {
      await platform.post(`${task(taskId)}/resume`, input)
    },
    async listSubtasks(taskId) {
      return (await platform.get<{ items: BusinessSubtask[] }>(`${task(taskId)}/subtasks`)).items
    },
    createMaterial: (taskId, input) =>
      platform.post<BusinessMaterial>(`${task(taskId)}/materials`, {
        requestKey: input.requestKey,
        fence: input.fence,
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        ...(input.nativeConfig === undefined ? {} : { nativeConfig: input.nativeConfig }),
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
