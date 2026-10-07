import type { Language } from '@agent-workflow/shared'
import type {
  TaskLaunchConfigurationQueries,
  TaskLaunchConfigurationSnapshot,
} from './ports/taskLaunchConfiguration'

export type TaskLaunchRuntimeConfiguration = {
  commitPush?: {
    model?: string
    runtime?: string
    maxRepairRetries?: number
    diffMaxBytes?: number
    excludePatterns: readonly string[]
    lang?: Language
  }
  maxConcurrentNodes?: number
  maxConcurrentScriptNodes?: number // RFC-266
  multiProcessSubprocessConcurrency?: number
  defaultPerNodeTimeoutMs?: number
  defaultRuntime?: string // RFC-112: a registered runtime NAME (built-ins or custom)
  defaultNodeRetries?: number // RFC-115: global per-node retry budget
  sessionRestartBudget?: number // RFC-313
  mergeAgent?: { model?: string; runtime?: string } // RFC-130: built-in merge resolver
  maxActiveChildTasks?: number // RFC-243
  maxInvocationDepth?: number // RFC-243
  scriptInterpreters?: { python?: string; bash?: string; node?: string } // RFC-253
  scriptDepsInstallTimeoutMs?: number // RFC-253
  maxConcurrentCodeHostCalls?: number // RFC-269
  codeHostRequestTimeoutMs?: number // RFC-269
  codeHostResponseMaxBytes?: number // RFC-269
  /**
   * RFC-287 G7：启动路径的克隆/抓取超时（`config.gitCloneTimeoutMs`）。
   * 名字与配置键不同名是刻意的——`resolveCachedRepo` 的入参就叫 cloneTimeoutMs，
   * 漏斗按**下游入参名**命名，避免调用点再做一次改名映射（改名映射正是
   * RFC-284 T30 那批字段被静默丢弃的成因之一）。
   */
  cloneTimeoutMs?: number
  /** RFC-287 G6：基线同步的总容忍窗口（config.gitBaselineSyncWindowMs）。 */
  gitBaselineSyncWindowMs?: number
}

function projectCommitPushConfiguration(cfg: TaskLaunchConfigurationSnapshot):
  | {
      model?: string
      runtime?: string
      maxRepairRetries?: number
      diffMaxBytes?: number
      excludePatterns: readonly string[]
      lang?: Language
    }
  | undefined {
  const out: {
    model?: string
    runtime?: string
    maxRepairRetries?: number
    diffMaxBytes?: number
    excludePatterns: readonly string[]
    lang?: Language
  } = { excludePatterns: cfg.taskCommitExcludePatterns }
  if (cfg.commitPushModel !== undefined) out.model = cfg.commitPushModel
  // RFC-117: commit agent runtime profile (wins over the deprecated model).
  if (cfg.commitPushRuntime !== undefined) out.runtime = cfg.commitPushRuntime
  if (cfg.commitPushMaxRepairRetries !== undefined)
    out.maxRepairRetries = cfg.commitPushMaxRepairRetries
  if (cfg.commitPushDiffMaxBytes !== undefined) out.diffMaxBytes = cfg.commitPushDiffMaxBytes
  // RFC-157: commit-message output language (undefined ≡ en-US at spawn time).
  if (cfg.commitPushLang !== undefined) out.lang = cfg.commitPushLang
  return Object.keys(out).length > 0 ? out : undefined
}

function applyRuntimeConfiguration(
  out: TaskLaunchRuntimeConfiguration,
  cfg: TaskLaunchConfigurationSnapshot,
): void {
  if (cfg.maxConcurrentNodes !== undefined) out.maxConcurrentNodes = cfg.maxConcurrentNodes
  // RFC-266: the script pool + the fan-out sub-pool ride the same funnel.
  if (cfg.maxConcurrentScriptNodes !== undefined)
    out.maxConcurrentScriptNodes = cfg.maxConcurrentScriptNodes
  // RFC-269: the code-host pool + its request knobs ride the same funnel.
  // Forgetting one here is the RFC-243/266 failure mode — the pool is a
  // daemon singleton with resize-on-read, so a missing key silently rewrites
  // the administrator's setting back to the default for the WHOLE daemon.
  if (cfg.maxConcurrentCodeHostCalls !== undefined)
    out.maxConcurrentCodeHostCalls = cfg.maxConcurrentCodeHostCalls
  if (cfg.codeHostRequestTimeoutMs !== undefined)
    out.codeHostRequestTimeoutMs = cfg.codeHostRequestTimeoutMs
  if (cfg.codeHostResponseMaxBytes !== undefined)
    out.codeHostResponseMaxBytes = cfg.codeHostResponseMaxBytes
  if (cfg.multiProcessSubprocessConcurrency !== undefined)
    out.multiProcessSubprocessConcurrency = cfg.multiProcessSubprocessConcurrency
  if (cfg.defaultPerNodeTimeoutMs !== undefined && cfg.defaultPerNodeTimeoutMs > 0)
    out.defaultPerNodeTimeoutMs = cfg.defaultPerNodeTimeoutMs
  // RFC-287 G7：任务启动路径的克隆/抓取超时。此前只有仓库路由把它传给
  // `resolveCachedRepo`，启动路径没接——管理员调小它，手动导入仓库时生效，
  // 而真正会卡住启动接口的那次克隆仍按 30 分钟默认值跑。
  if (cfg.gitCloneTimeoutMs !== undefined && cfg.gitCloneTimeoutMs > 0)
    out.cloneTimeoutMs = cfg.gitCloneTimeoutMs
  // RFC-287 G6：基线同步的总容忍窗口。0 是合法值（关闭重试），故**不能**用
  // `> 0` 过滤——那会让「显式关掉重试」被静默忽略、退回默认 60s。
  if (cfg.gitBaselineSyncWindowMs !== undefined)
    out.gitBaselineSyncWindowMs = cfg.gitBaselineSyncWindowMs
  // RFC-111: global default runtime threaded to the scheduler dispatch site.
  if (cfg.defaultRuntime !== undefined) out.defaultRuntime = cfg.defaultRuntime
  // RFC-115: global per-node retry budget (no `> 0` guard — 0 disables retries).
  if (cfg.defaultNodeRetries !== undefined) out.defaultNodeRetries = cfg.defaultNodeRetries
  // RFC-313: 会话升级预算（同样没有 `> 0` 守卫——0 是「关闭升级」这个显式选择）。
  if (cfg.sessionRestartBudget !== undefined) out.sessionRestartBudget = cfg.sessionRestartBudget
  // RFC-253: administrator interpreter overrides + dependency build budget.
  if (cfg.scriptInterpreters !== undefined && Object.keys(cfg.scriptInterpreters).length > 0)
    out.scriptInterpreters = cfg.scriptInterpreters
  if (cfg.scriptDepsInstallTimeoutMs !== undefined && cfg.scriptDepsInstallTimeoutMs > 0)
    out.scriptDepsInstallTimeoutMs = cfg.scriptDepsInstallTimeoutMs
  // RFC-130 §6.1: built-in merge-conflict resolver runtime (profile wins over model).
  if (cfg.mergeAgentModel !== undefined || cfg.mergeAgentRuntime !== undefined) {
    out.mergeAgent = {
      ...(cfg.mergeAgentModel !== undefined ? { model: cfg.mergeAgentModel } : {}),
      ...(cfg.mergeAgentRuntime !== undefined ? { runtime: cfg.mergeAgentRuntime } : {}),
    }
  }
  // RFC-113 §5: claudeCodePath is no longer threaded (the claude runtime row's
  // binary_path carries it now — RFC-112 P2 is收口).
}

function applyChildBudgetConfiguration(
  out: TaskLaunchRuntimeConfiguration,
  cfg: TaskLaunchConfigurationSnapshot,
): void {
  out.maxActiveChildTasks = cfg.maxActiveChildTasks
  out.maxInvocationDepth = cfg.maxInvocationDepth
}

/** Compatibility for synchronous local composition. Policy projections are shared. */
export function resolveTaskCommitPushFromReader(read: () => TaskLaunchConfigurationSnapshot) {
  try {
    return projectCommitPushConfiguration(read())
  } catch {
    return undefined
  }
}

export function resolveTaskLaunchRuntimeFromReader(
  read: () => TaskLaunchConfigurationSnapshot,
): TaskLaunchRuntimeConfiguration {
  const out: TaskLaunchRuntimeConfiguration = {}
  const commitPush = resolveTaskCommitPushFromReader(read)
  if (commitPush !== undefined) out.commitPush = commitPush
  try {
    applyRuntimeConfiguration(out, read())
  } catch {
    /* scheduler defaults */
  }
  try {
    applyChildBudgetConfiguration(out, read())
  } catch {
    /* child-budget defaults */
  }
  return out
}

/** Three independent reads retain the original commit/runtime/child fallback boundaries. */
export async function resolveTaskLaunchRuntimeConfiguration(
  queries: TaskLaunchConfigurationQueries,
): Promise<TaskLaunchRuntimeConfiguration> {
  const out: TaskLaunchRuntimeConfiguration = {}
  try {
    const commitPush = projectCommitPushConfiguration(await queries.read())
    if (commitPush !== undefined) out.commitPush = commitPush
  } catch {
    /* commit defaults */
  }
  try {
    applyRuntimeConfiguration(out, await queries.read())
  } catch {
    /* scheduler defaults */
  }
  try {
    applyChildBudgetConfiguration(out, await queries.read())
  } catch {
    /* child-budget defaults */
  }
  return out
}

export function resolveTaskSubagentLiveCaptureFromReader(
  read: () => TaskLaunchConfigurationSnapshot,
) {
  try {
    return read().subagentLiveCapture
  } catch {
    return undefined
  }
}

export async function resolveTaskSubagentLiveCapture(queries: TaskLaunchConfigurationQueries) {
  try {
    return (await queries.read()).subagentLiveCapture
  } catch {
    return undefined
  }
}

/** Start dependencies retain the original subagent, commit, runtime, child read order. */
export async function resolveTaskStartLaunchConfiguration(
  queries: TaskLaunchConfigurationQueries,
): Promise<
  TaskLaunchRuntimeConfiguration & {
    subagentLiveCapture?: TaskLaunchConfigurationSnapshot['subagentLiveCapture']
  }
> {
  const subagentLiveCapture = await resolveTaskSubagentLiveCapture(queries)
  const runtime = await resolveTaskLaunchRuntimeConfiguration(queries)
  const defaults: Record<keyof TaskLaunchRuntimeConfiguration, undefined> = {
    commitPush: undefined,
    maxConcurrentNodes: undefined,
    maxConcurrentScriptNodes: undefined,
    multiProcessSubprocessConcurrency: undefined,
    defaultPerNodeTimeoutMs: undefined,
    defaultRuntime: undefined,
    defaultNodeRetries: undefined,
    sessionRestartBudget: undefined,
    mergeAgent: undefined,
    maxActiveChildTasks: undefined,
    maxInvocationDepth: undefined,
    scriptInterpreters: undefined,
    scriptDepsInstallTimeoutMs: undefined,
    maxConcurrentCodeHostCalls: undefined,
    codeHostRequestTimeoutMs: undefined,
    codeHostResponseMaxBytes: undefined,
    cloneTimeoutMs: undefined,
    gitBaselineSyncWindowMs: undefined,
  }
  return {
    ...defaults,
    subagentLiveCapture,
    ...runtime,
  }
}

export type TaskLaunchUploadLimits = NonNullable<TaskLaunchConfigurationSnapshot['uploadLimits']>

function projectUploadLimits(
  cfg: TaskLaunchConfigurationSnapshot,
  fallback: TaskLaunchUploadLimits,
): TaskLaunchUploadLimits {
  const u = cfg.uploadLimits
  if (u !== undefined) return { perFile: u.perFile, perRequest: u.perRequest, perCount: u.perCount }
  return { ...fallback }
}

export function resolveTaskUploadLimitsFromReader(
  read: () => TaskLaunchConfigurationSnapshot,
  fallback: TaskLaunchUploadLimits,
): TaskLaunchUploadLimits {
  try {
    return projectUploadLimits(read(), fallback)
  } catch {
    return { ...fallback }
  }
}

export async function resolveTaskUploadLimits(
  queries: TaskLaunchConfigurationQueries,
  fallback: TaskLaunchUploadLimits,
): Promise<TaskLaunchUploadLimits> {
  try {
    return projectUploadLimits(await queries.read(), fallback)
  } catch {
    return { ...fallback }
  }
}
