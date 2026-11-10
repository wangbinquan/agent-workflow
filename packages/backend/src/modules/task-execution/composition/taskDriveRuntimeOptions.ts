// RFC-478 —— 运行时选项漏斗（原 `services/task.ts`）：把配置里的运行时旋钮交给驱动选项，bootstrap 与用例 helper 取它。
// 函数体原样迁来；入参原是测试依赖袋 `TaskContinuationDependencies` 的 `Pick`，按字段写成 `TaskDriveRuntimeConfiguration`。
import type { Language, ScriptLanguage } from '@agent-workflow/shared'
import type { SchedulerDriverPort } from '../application/ports/taskExecutionTopology'
import { composeAgentRunDistillObserver } from './agentRunDistillObserver'

type TaskDriveRequest = Parameters<SchedulerDriverPort['drive']>[0]
export type TaskDriveRuntimeOptions = Omit<
  TaskDriveRequest,
  'taskId' | 'executionContext' | 'signal'
>

/** 运行时选项漏斗的入参：配置里的运行时旋钮（字段含义见各自 RFC，省略即用调度器默认值）。 */
export interface TaskDriveRuntimeConfiguration {
  /** RFC-075: auto commit&push runtime config. */
  commitPush?: {
    model?: string
    runtime?: string
    maxRepairRetries?: number
    diffMaxBytes?: number
    excludePatterns?: readonly string[]
    lang?: Language
  }
  /** RFC-130 §6.1: built-in merge-conflict resolver runtime. */
  mergeAgent?: {
    model?: string
    runtime?: string
  }
  /** RFC-103 T2: global concurrency cap (`maxConcurrentNodes`). */
  maxConcurrentNodes?: number
  /** RFC-266: per-task fan-out sub-pool capacity. */
  multiProcessSubprocessConcurrency?: number
  /** RFC-266: daemon-wide pool for RFC-253 script nodes. */
  maxConcurrentScriptNodes?: number
  /** RFC-269: daemon-wide pool for code-host call nodes + their request knobs. */
  maxConcurrentCodeHostCalls?: number
  codeHostRequestTimeoutMs?: number
  codeHostResponseMaxBytes?: number
  /** Default per-node timeout (ms). */
  defaultPerNodeTimeoutMs?: number
  /** RFC-115: global per-node retry budget. */
  defaultNodeRetries?: number
  /** RFC-313: clean-session restart budget. */
  sessionRestartBudget?: number
  /** RFC-115 (Codex F3): global default runtime NAME. */
  defaultRuntime?: string
  /** RFC-243 §3.2: daemon-wide active-child-task cap. */
  maxActiveChildTasks?: number
  /** RFC-243 §3.2: invocation-chain depth ceiling. */
  maxInvocationDepth?: number
  /** RFC-253: administrator interpreter overrides + dependency build budget. */
  scriptInterpreters?: Partial<Record<ScriptLanguage, string>>
  scriptDepsInstallTimeoutMs?: number
  /**
   * RFC-366: provider-selected agent-run distill participant. Typed from the observer it feeds, so this file takes no
   * type from memory's public entry (that would be one more off-DAG offered file pair; RFC-478).
   */
  memoryDistillEnqueuer?: Parameters<typeof composeAgentRunDistillObserver>[0]
}

/**
 * RFC-103 T2 — single source for threading runtime config (auto commit&push +
 * global concurrency) from `TaskDriveRuntimeConfiguration` into `RunTaskOptions`. Used by
 * startTask / resumeTask / retryNode so the three kick sites can't drift: the
 * historical bug (01-LIFE-06) was retryNode dropping commit&push entirely, and
 * `maxConcurrentNodes` was never threaded from any HTTP entry (02-SCHED).
 */
export function runtimeConfigOpts(
  deps: TaskDriveRuntimeConfiguration,
): Partial<TaskDriveRuntimeOptions> {
  return {
    // RFC-366: agent-run distill. Threaded through the SAME funnel as every
    // other runtime option for the reason this funnel exists (RFC-103 T2): the
    // three kick sites — startTask / resumeTask / retryNode — must not drift,
    // and a resumed or retried run's agents are exactly the ones worth learning
    // from. Absent enqueuer (legacy fixtures) → the engine's no-op observer.
    ...(deps.memoryDistillEnqueuer === undefined
      ? {}
      : { agentRunSettled: composeAgentRunDistillObserver(deps.memoryDistillEnqueuer) }),
    ...(deps.maxActiveChildTasks !== undefined
      ? { maxActiveChildTasks: deps.maxActiveChildTasks }
      : {}),
    ...(deps.maxInvocationDepth !== undefined
      ? { maxInvocationDepth: deps.maxInvocationDepth }
      : {}),
    ...(deps.commitPush?.model !== undefined ? { commitPushModel: deps.commitPush.model } : {}),
    ...(deps.commitPush?.runtime !== undefined
      ? { commitPushRuntime: deps.commitPush.runtime }
      : {}),
    // RFC-130 §6.1: built-in merge-conflict resolver runtime.
    ...(deps.mergeAgent?.model !== undefined ? { mergeAgentModel: deps.mergeAgent.model } : {}),
    ...(deps.mergeAgent?.runtime !== undefined
      ? { mergeAgentRuntime: deps.mergeAgent.runtime }
      : {}),
    ...(deps.commitPush?.maxRepairRetries !== undefined
      ? { commitPushMaxRepairRetries: deps.commitPush.maxRepairRetries }
      : {}),
    ...(deps.commitPush?.diffMaxBytes !== undefined
      ? { commitPushDiffMaxBytes: deps.commitPush.diffMaxBytes }
      : {}),
    ...(deps.commitPush?.excludePatterns !== undefined
      ? { commitPushExcludePatterns: deps.commitPush.excludePatterns }
      : {}),
    // RFC-157: commit-message output language (undefined ≡ en-US downstream).
    ...(deps.commitPush?.lang !== undefined ? { commitPushLang: deps.commitPush.lang } : {}),
    ...(deps.maxConcurrentNodes !== undefined
      ? { maxConcurrentNodes: deps.maxConcurrentNodes }
      : {}),
    // RFC-266: the fan-out sub-pool + the independent script pool ride the SAME
    // funnel. The fan-out one was persisted by Settings and consumed by the
    // scheduler but wired by nobody in between.
    ...(deps.multiProcessSubprocessConcurrency !== undefined
      ? { multiProcessSubprocessConcurrency: deps.multiProcessSubprocessConcurrency }
      : {}),
    ...(deps.maxConcurrentScriptNodes !== undefined
      ? { maxConcurrentScriptNodes: deps.maxConcurrentScriptNodes }
      : {}),
    // RFC-269: the code-host pool + request knobs ride the same funnel.
    ...(deps.maxConcurrentCodeHostCalls !== undefined
      ? { maxConcurrentCodeHostCalls: deps.maxConcurrentCodeHostCalls }
      : {}),
    ...(deps.codeHostRequestTimeoutMs !== undefined
      ? { codeHostRequestTimeoutMs: deps.codeHostRequestTimeoutMs }
      : {}),
    ...(deps.codeHostResponseMaxBytes !== undefined
      ? { codeHostResponseMaxBytes: deps.codeHostResponseMaxBytes }
      : {}),
    // RFC-253（RFC-284 T30 修配）：管理员解释器覆盖 + 依赖构建预算——此前唯二
    // 被漏斗丢弃的 launchRuntime 键（根任务即断线，见 TaskContinuationDependencies 字段注释）。
    ...(deps.scriptInterpreters !== undefined
      ? { scriptInterpreters: deps.scriptInterpreters }
      : {}),
    ...(deps.scriptDepsInstallTimeoutMs !== undefined
      ? { scriptDepsInstallTimeoutMs: deps.scriptDepsInstallTimeoutMs }
      : {}),
    // RFC-115: per-node timeout + retry budget + default runtime. Previously
    // timeout was hand-spread at each runTask call site and defaultRuntime was
    // never threaded at all (Codex F3) — single funnel now so every start /
    // resume / retry / fusion entry gets all three consistently.
    ...(deps.defaultPerNodeTimeoutMs !== undefined
      ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
      : {}),
    ...(deps.sessionRestartBudget !== undefined
      ? { sessionRestartBudget: deps.sessionRestartBudget }
      : {}),
    ...(deps.defaultNodeRetries !== undefined
      ? { defaultNodeRetries: deps.defaultNodeRetries }
      : {}),
    ...(deps.defaultRuntime !== undefined ? { defaultRuntime: deps.defaultRuntime } : {}),
  }
}
