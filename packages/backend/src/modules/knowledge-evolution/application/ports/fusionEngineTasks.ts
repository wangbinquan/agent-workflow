// RFC-353 T5（RFC-294 W4-E3）—— `FusionEngineTaskOperations` 是 KE 向 task-execution 要的启动面。
// RFC-560 (RFC-294 S9 step 15): moved here from `public/participants.ts`. Knowledge Evolution owns this required port;
// task-execution implements it through its designated knowledge-evolution adapter, which takes the type from
// `composition/required-ports.ts`.
import type { TaskStatus } from '@agent-workflow/shared'

import type { FusionResultManifestRead, FusionTreeFile } from '../../domain/fusionTree'

/** RFC-370 §10 V20 —— 引擎任务的种子树：技能某一版本的精确字节，可叠一层上轮提案作未提交改动。 */
export interface FusionWorkspaceSeed {
  /** Committed as the workspace baseline: the diff the merger approves is measured from it. */
  readonly base: readonly FusionTreeFile[]
  /** Written over the baseline as uncommitted changes (a re-run refines its last attempt). */
  readonly overlay: readonly FusionTreeFile[] | null
}

/** RFC-370 §10 V20 —— 收集回来的提案：相对基线的 diff、agent 的结果清单、编辑后的完整树。 */
export interface FusionEngineTaskResult {
  readonly diff: string
  readonly manifest: FusionResultManifestRead
  readonly files: readonly FusionTreeFile[]
}

export interface FusionEngineTaskRecord {
  readonly status: TaskStatus
  readonly errorSummary: string | null
  readonly worktreePath: string
  readonly baseCommit: string | null
}

/**
 * RFC-370 §10 V20：KE 只交出种子树（技能字节），工作区由 task-execution 经 source-control 准备——
 * 本地是 `fusions/<id>/iter<n>/work` 的 Git 仓，托管是引擎任务自己卷里的工作副本。
 */
export interface FusionEngineTaskLaunch {
  readonly taskId: string
  readonly fusionId: string
  readonly iteration: number
  readonly seed: FusionWorkspaceSeed
  readonly workflowId: string
  readonly name: string
  readonly inputs: Readonly<Record<string, string>>
  readonly collaboratorUserIds?: readonly string[]
  readonly ownerUserId: string
  readonly initiator: 'manual' | 'api'
  readonly platformInputPaths: readonly string[]
  readonly completionMode?: 'background' | 'await-settle'
}

export interface FusionEngineTaskOperations {
  launch(command: FusionEngineTaskLaunch): Promise<void>
  load(taskId: string): Promise<FusionEngineTaskRecord | null>
  /** The settled task's proposal; `null` when the task no longer exists. */
  collect(taskId: string): Promise<FusionEngineTaskResult | null>
  /** Gives the task's workspace back once its proposal is no longer needed there. */
  release(taskId: string): Promise<void>
  cancel(taskId: string): Promise<void>
}
