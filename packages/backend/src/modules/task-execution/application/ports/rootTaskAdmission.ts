// RFC-486: the root task admission port. The launch kernel (application) supplies the ids, the clock reading and the
// launch facts; the infrastructure adapter shapes the rows and owns the one serializable transaction.

import type { initialDwState } from '@agent-workflow/shared'
import {
  type GitCommitIdentity,
  type Task,
  type TaskCatalogVisibility,
  type TaskLaunchOrigin,
  type TaskStartOptions,
  type TriggerContext,
  type WorkflowDefinition,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { type TaskSubject } from '../../domain/taskSubject'
import { type Actor } from '@/auth/actor'
import type { TaskExecutionIntentSource } from '../../domain/executionIntent'
import { type TaskLaunchProvenance } from '../../domain/taskLaunchOrigin'

import type { SourceTerminationSnapshot } from '../../domain/sourceTermination'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import type { TaskLaunchGuard } from './taskLaunchGuard'
import type { TaskRoutePreparedWorkspace } from './taskRouteLaunch'

export interface RootLaunchMetadata {
  readonly provenance: TaskLaunchProvenance
  readonly launchOrigin: TaskLaunchOrigin
  readonly intentSource: TaskExecutionIntentSource
  readonly scheduledTaskId: string | null
  readonly webhookTriggerId: string | null
  readonly webhookFireId: string | null
  readonly eventSubscriptionId: string | null
  readonly eventDeliveryId: string | null
  readonly triggerContext: TriggerContext | null
  readonly sourceTerminationSnapshot: SourceTerminationSnapshot | null
}

export type RootTaskLaunchSubject = (
  | { readonly subject: Extract<TaskSubject, { kind: 'workflow' }>; readonly workflowName: string }
  | { readonly subject: Exclude<TaskSubject, { kind: 'workflow' }>; readonly workflowName?: string }
) & {
  readonly workflowVersion: number
  readonly workflowSnapshot: WorkflowDefinition
  /**
   * RFC-359 AC-1（plan §5hn 批次一）：这份快照是不是**平台自有的合成宿主**。
   *
   * 它决定要不要在**写时**冻结规范排版——`services/task.ts` 的 `startTask` 对
   * `workflow.builtin === true` 一直是这么做的，而启动内核此前直接
   * `JSON.stringify(subject.workflowSnapshot)` 落库、只靠**读时**投影补，
   * 于是启动响应体与库里那一行在两个引擎上不同
   * （`rfc359-w5hn-agent-launch-provider-parity` 照出来的）。
   *
   * **故意声明成必填**：可选会让「装配漏了一步」编译通过，而漏掉的后果是那条任务
   * 从此存着一份没有几何的快照——读时投影补得了页面，补不了导出与直接读库的下游。
   * 必填之后，任何新的启动路都要在类型层先回答这个问题。
   */
  readonly builtin: boolean
  readonly workgroup?: Readonly<{
    id: string
    name: string
    goal: string
    config: WorkgroupRuntimeConfig
    dynamicState: ReturnType<typeof initialDwState> | null
  }>
}

export interface RootTaskAdmissionRequest {
  readonly actor: Actor
  readonly task: TaskStartOptions
  readonly subject: RootTaskLaunchSubject
  readonly internal?: Readonly<{
    readonly catalogVisibility?: TaskCatalogVisibility
    readonly digitalEmployeeLaunch?: Readonly<{
      readonly actionRunId: string
      readonly caseId?: string
    }>
    readonly platformInputPaths?: readonly string[]
  }>
  /** Checked inside the admission transaction, in the original order. */
  readonly guard?: Pick<TaskLaunchGuard, 'assertCanCommit' | 'verifyCanCommit'>
  readonly taskId: string
  readonly intentId: string
  readonly refClosureJson: string | null
  readonly metadata: RootLaunchMetadata
  readonly gitCommitIdentity: GitCommitIdentity | null
  readonly startedAt: number
  /** The caller-owned workspace lease; its lane admission joins the same transaction. */
  readonly preparedWorkspace: TaskRoutePreparedWorkspace
  readonly persistedInputs: Readonly<Record<string, string>>
}

export interface RootTaskAdmission {
  /** Projects the launched task, then writes it in one serializable transaction; returns the created-event ref. */
  admit(
    request: RootTaskAdmissionRequest,
  ): Promise<Readonly<{ eventRef: CommittedEventRef | null; projection: Task }>>
  publishAfterCommit(eventRef: CommittedEventRef | null): Promise<boolean>
}
