import type { Config } from '@agent-workflow/shared'

/** Raw configuration facts used by launch policies; reads stay live and may be async. */
export type TaskLaunchConfigurationSnapshot = Pick<
  Config,
  | 'codeHostRequestTimeoutMs'
  | 'codeHostResponseMaxBytes'
  | 'commitPushDiffMaxBytes'
  | 'commitPushLang'
  | 'commitPushMaxRepairRetries'
  | 'commitPushModel'
  | 'commitPushRuntime'
  | 'defaultNodeRetries'
  | 'defaultPerNodeTimeoutMs'
  | 'defaultRuntime'
  | 'gitBaselineSyncWindowMs'
  | 'gitCloneTimeoutMs'
  | 'maxActiveChildTasks'
  | 'maxConcurrentCodeHostCalls'
  | 'maxConcurrentNodes'
  | 'maxConcurrentScriptNodes'
  | 'maxInvocationDepth'
  | 'mergeAgentModel'
  | 'mergeAgentRuntime'
  | 'multiProcessSubprocessConcurrency'
  | 'scriptDepsInstallTimeoutMs'
  | 'scriptInterpreters'
  | 'sessionRestartBudget'
  | 'subagentLiveCapture'
  | 'taskCommitExcludePatterns'
  | 'uploadLimits'
>

export interface TaskLaunchConfigurationQueries {
  read(): TaskLaunchConfigurationSnapshot | Promise<TaskLaunchConfigurationSnapshot>
}
