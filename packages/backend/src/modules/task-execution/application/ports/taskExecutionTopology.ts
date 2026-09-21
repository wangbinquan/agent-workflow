import type { Language, TriggerContext } from '@agent-workflow/shared'
import type { OwnershipToken } from '../../domain/ownership'
import type { AgentRunSettledObserver } from './agentRunSettledObserver'

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

type TaskExecutionLogFieldValue = string | number | boolean | null | undefined

export interface TaskExecutionTopologyLogger {
  debug(message: string, fields?: Readonly<Record<string, TaskExecutionLogFieldValue>>): void
  info(message: string, fields?: Readonly<Record<string, TaskExecutionLogFieldValue>>): void
  warn(message: string, fields?: Readonly<Record<string, TaskExecutionLogFieldValue>>): void
  error(message: string, fields?: Readonly<Record<string, TaskExecutionLogFieldValue>>): void
  child(name: string): TaskExecutionTopologyLogger
}

/** Closed interpreter vocabulary; `ScriptLanguage` has exactly these three members. */
interface ScriptInterpreterOverrides {
  readonly python?: string
  readonly bash?: string
  readonly node?: string
}

/**
 * Runtime knobs that the legacy task launcher already forwards to the scheduler.
 * RFC-331 moves their ownership out of scheduler.ts without changing defaults or
 * adding a second configuration source.
 */
export interface TaskDriveRuntimeKnobs {
  readonly daemonGeneration?: string
  readonly binaryOverride?: readonly string[]
  readonly configPath?: string
  readonly log?: TaskExecutionTopologyLogger
  readonly defaultPerNodeTimeoutMs?: number
  readonly defaultNodeRetries?: number
  readonly sessionRestartBudget?: number
  readonly scriptInterpreters?: ScriptInterpreterOverrides
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
  readonly commitPushLang?: Language
  readonly defaultRuntime?: string
  /**
   * RFC-366 —— agent 运行结束的观察者。
   *
   * 它必须出现在**这张显式清单**上，而不只是 `RunTaskOptions` 里：这张表就是
   * 「启动器转发给调度器的东西」的声明面，`TaskDriveRequest` 与
   * `runtimeConfigOpts` 的返回类型都从它派生。只加在 `RunTaskOptions` 上时，
   * 对象展开会让它在运行期照样流到引擎（`state.opts.agentRunSettled` 取得到），
   * 但类型上 drive 请求里根本没有这一项——于是 bootstrap → 引擎这一段接线
   * 没有任何编译期约束，改名只会在运行期坏掉，而且是「记忆少了」这种不报错的坏。
   */
  readonly agentRunSettled?: AgentRunSettledObserver
}

export interface TaskDriveRuntimeOptions extends TaskDriveRuntimeKnobs {
  readonly appHome: string
  readonly ensureWorkspaceProfiles?: boolean
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
] as const satisfies ReadonlyArray<keyof InheritableRunConfig>

/** Explicit public resume shape; keep it in lockstep with the key catalog above. */
export interface InheritableRunConfig {
  readonly daemonGeneration?: string
  readonly binaryOverride?: readonly string[]
  readonly configPath?: string
  readonly appHome: string
  readonly defaultPerNodeTimeoutMs?: number
  readonly defaultNodeRetries?: number
  readonly sessionRestartBudget?: number
  readonly defaultRuntime?: string
  readonly maxConcurrentNodes?: number
  readonly maxConcurrentScriptNodes?: number
  readonly maxConcurrentCodeHostCalls?: number
  readonly codeHostRequestTimeoutMs?: number
  readonly codeHostResponseMaxBytes?: number
  readonly multiProcessSubprocessConcurrency?: number
  readonly maxActiveChildTasks?: number
  readonly maxInvocationDepth?: number
  readonly subagentLiveCapture?: {
    readonly pollMs: number
    readonly consecutiveFailureLimit: number
  }
  readonly commitPushExcludePatterns?: readonly string[]
  readonly scriptInterpreters?: ScriptInterpreterOverrides
  readonly scriptDepsInstallTimeoutMs?: number
}

type MutableInheritableRunConfig = {
  -readonly [K in keyof InheritableRunConfig]: InheritableRunConfig[K]
}

const inheritableRunConfigKeysAreExhaustive: Exclude<
  keyof InheritableRunConfig,
  (typeof INHERITABLE_RUN_CONFIG_KEYS)[number]
> extends never
  ? true
  : never = true
void inheritableRunConfigKeysAreExhaustive

/** Preserve exact-optional semantics: absent values stay absent. */
export function pickInheritableRunConfig<T extends TaskDriveRuntimeOptions>(
  options: T,
): InheritableRunConfig {
  const selected: Partial<MutableInheritableRunConfig> &
    Pick<MutableInheritableRunConfig, 'appHome'> = { appHome: options.appHome }
  for (const key of INHERITABLE_RUN_CONFIG_KEYS) {
    const value = options[key]
    if (value !== undefined) Object.assign(selected, { [key]: value })
  }
  return selected
}

export interface ChildResumeRuntime {
  readonly triggerContext?: TriggerContext
  readonly actorUserId?: string
  readonly runConfig: InheritableRunConfig
}

export interface SchedulerDriverPort {
  /** RFC-332 W2-B task-level application entry; scheduler mechanics do not own this body. */
  drive(request: TaskDriveRequest): Promise<void>
  cancelChild(input: {
    readonly taskId: string
    readonly cause: Readonly<{ readonly kind: 'parent-cascade'; readonly parentTaskId: string }>
  }): Promise<void>
  resumeChild(input: {
    readonly taskId: string
    readonly runtime: ChildResumeRuntime
  }): Promise<void>
  isTaskActive(taskId: string): boolean
}
