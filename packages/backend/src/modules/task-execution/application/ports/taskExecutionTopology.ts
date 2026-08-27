import type { Language, ScriptLanguage, TaskStatus, TriggerContext } from '@agent-workflow/shared'
import type { OwnershipToken } from '../../domain/ownership'
import type { TaskStatusProjectionReadModel } from '../queries/taskExecutionReadModels'

/**
 * Cross-boundary identity view of RFC-328's exact execution context.
 *
 * The runtime object passed here is still the same trusted context instance;
 * the driver contract only needs its stable identity fields and therefore must
 * not expose the context's daemon-internal database connection.
 */
export interface TaskExecutionContextRef {
  readonly intentId: string
  readonly token: OwnershipToken
}

export interface TaskExecutionTopologyLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  child(name: string): TaskExecutionTopologyLogger
}

/**
 * Runtime knobs that the legacy task launcher already forwards to the scheduler.
 * RFC-331 moves their ownership out of scheduler.ts without changing defaults or
 * adding a second configuration source.
 */
export interface TaskDriveRuntimeOptions {
  readonly appHome: string
  readonly daemonGeneration?: string
  readonly binaryOverride?: readonly string[]
  readonly configPath?: string
  readonly log?: TaskExecutionTopologyLogger
  readonly defaultPerNodeTimeoutMs?: number
  readonly defaultNodeRetries?: number
  readonly sessionRestartBudget?: number
  readonly scriptInterpreters?: Partial<Record<ScriptLanguage, string>>
  readonly scriptDepsInstallTimeoutMs?: number
  readonly maxConcurrentNodes?: number
  readonly maxConcurrentScriptNodes?: number
  readonly maxConcurrentCodeHostCalls?: number
  readonly codeHostRequestTimeoutMs?: number
  readonly codeHostResponseMaxBytes?: number
  readonly multiProcessSubprocessConcurrency?: number
  readonly fanoutMaxShardTotal?: number
  readonly maxActiveChildTasks?: number
  readonly maxInvocationDepth?: number
  readonly subagentLiveCapture?: {
    readonly pollMs: number
    readonly consecutiveFailureLimit: number
  }
  readonly commitPushModel?: string
  readonly commitPushRuntime?: string
  readonly mergeAgentModel?: string
  readonly mergeAgentRuntime?: string
  readonly commitPushMaxRepairRetries?: number
  readonly commitPushDiffMaxBytes?: number
  readonly commitPushExcludePatterns?: readonly string[]
  readonly ensureWorkspaceProfiles?: boolean
  readonly commitPushLang?: Language
  readonly defaultRuntime?: string
}

export interface TaskDriveRequest extends TaskDriveRuntimeOptions {
  readonly taskId: string
  readonly executionContext: TaskExecutionContextRef
  readonly signal: AbortSignal
}

export const INHERITABLE_RUN_CONFIG_KEYS = [
  'daemonGeneration',
  'binaryOverride',
  'configPath',
  'appHome',
  'defaultPerNodeTimeoutMs',
  'defaultNodeRetries',
  'sessionRestartBudget',
  'defaultRuntime',
  'maxConcurrentNodes',
  'maxConcurrentScriptNodes',
  'maxConcurrentCodeHostCalls',
  'codeHostRequestTimeoutMs',
  'codeHostResponseMaxBytes',
  'multiProcessSubprocessConcurrency',
  'maxActiveChildTasks',
  'maxInvocationDepth',
  'subagentLiveCapture',
  'commitPushExcludePatterns',
  'scriptInterpreters',
  'scriptDepsInstallTimeoutMs',
] as const satisfies ReadonlyArray<keyof TaskDriveRuntimeOptions>

export type InheritableRunConfig = Pick<
  TaskDriveRuntimeOptions,
  (typeof INHERITABLE_RUN_CONFIG_KEYS)[number]
>

/** Preserve exact-optional semantics: absent values stay absent. */
export function pickInheritableRunConfig<T extends TaskDriveRuntimeOptions>(
  options: T,
): InheritableRunConfig {
  const selected: Record<string, unknown> = {}
  for (const key of INHERITABLE_RUN_CONFIG_KEYS) {
    const value = options[key]
    if (value !== undefined) selected[key] = value
  }
  return selected as InheritableRunConfig
}

export interface ChildResumeRuntime {
  readonly triggerContext?: TriggerContext
  readonly actorUserId?: string
  readonly runConfig: InheritableRunConfig
}

export interface SchedulerDriverPort {
  kick(request: TaskDriveRequest): Promise<void>
  cancelChild(input: { readonly taskId: string; readonly cascadeFromParent: true }): Promise<void>
  resumeChild(input: {
    readonly taskId: string
    readonly runtime: ChildResumeRuntime
  }): Promise<void>
  isTaskActive(taskId: string): boolean
}

export interface TaskStatusProjection {
  readonly taskId: string
  readonly status: TaskStatus
  readonly errorSummary: string | null
  readonly canceledNodeRuns: readonly {
    readonly id: string
    readonly nodeId: string
  }[]
}

export interface TaskStatusPublisher {
  publish(event: TaskStatusProjection): void
}

/** Required by the scheduler runtime; production construction has no fallback. */
export interface SchedulerRuntimeTopology {
  readonly schedulerDriver: SchedulerDriverPort
  readonly taskStatusReadModel: TaskStatusProjectionReadModel
  readonly taskStatusPublisher: TaskStatusPublisher
}
