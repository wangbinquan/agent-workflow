// RFC-486 (RFC-294 W4-E1 remainder): the root task launch kernel — launch metadata, guard checks and the preflight /
// prepare / uploads / admission / rollback / submit steps handed to `launchTask`. Persistence lives behind the admission and
// upload ports (infrastructure); this file holds no database handle.

import {
  UPLOAD_INPUTS_DIR,
  type GitCommitIdentity,
  type Task,
  type TaskCatalogVisibility,
  type TaskStartOptions,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { launchTask } from './launchTask'
import type { TaskLaunchConfigurationQueries } from '../ports/taskLaunchConfiguration'
import { definitionAnchorId } from '../../domain/taskSubject'
import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import {
  assertTriggerPreflight,
  triggerSourceFromContext,
} from '@/modules/resource-catalog/public/queries'
import { attachWorkspaceCleanupToMultipartError, bufferUploadParts } from '../launchUploads'
import { layoutBuiltinWorkflowSnapshot } from '../../domain/builtinWorkflowLayout'
import { ValidationError } from '@/util/errors'
import type { TaskDriveCoordinator } from '../drive/taskDriveTypes'
import type { WorkspaceCleanupReport } from '../ports/preparedWorkspace'
import type { TaskExecutionResourceAuthority } from '../ports/taskExecutionResourceSnapshots'
import {
  deriveTaskLaunchOrigin,
  taskLaunchAdmissionIssue,
  type DirectTaskInitiator,
  type TaskLaunchProvenance,
} from '../../domain/taskLaunchOrigin'
import type { collectUploadInputDefs } from '../../domain/uploads'
import { validateUploadPlan } from '../../domain/uploads'
import type { ExecutionInvoker, TaskRouteMultipartFilePart } from '../../public/commands'
import type { SourceTerminationSnapshot } from '../../domain/sourceTermination'

import type {
  RootLaunchMetadata,
  RootTaskAdmission,
  RootTaskLaunchSubject,
} from '../ports/rootTaskAdmission'
import type { TaskLaunchGuard } from '../ports/taskLaunchGuard'
import type { TaskLaunchUploads } from '../ports/taskLaunchUploads'
import type {
  TaskRoutePreparedWorkspace,
  TaskRouteWorkspaceParticipant,
} from '../ports/taskRouteLaunch'

export interface RootTaskLaunchDependencies {
  readonly launchConfiguration?: TaskLaunchConfigurationQueries
  /** RFC-486: the admission transaction and the post-commit publication (infrastructure adapter). */
  readonly admission: RootTaskAdmission
  /** RFC-486: lands buffered uploads in the prepared worktree (infrastructure adapter). */
  readonly uploads: TaskLaunchUploads
  /** RFC-486 / RFC-301: the closed manual / api initiator; only the inbound adapter observes the actor source. */
  readonly directTaskInitiator: (actor: Actor) => DirectTaskInitiator
  readonly gitCommitIdentity: Readonly<{
    execute(userId: string): Promise<GitCommitIdentity>
  }>
  readonly workspace: TaskRouteWorkspaceParticipant
  readonly coordinator: TaskDriveCoordinator
  readonly id?: () => string
  readonly now?: () => number
}

function rootLaunchMetadata(
  actor: Actor,
  invoker: ExecutionInvoker,
  initiatorOf: (actor: Actor) => DirectTaskInitiator,
): RootLaunchMetadata {
  if (invoker.type === 'node') {
    throw new ValidationError(
      'execution-invoker-unsupported',
      'root task launch does not accept a node invoker',
    )
  }
  const provenance: TaskLaunchProvenance =
    invoker.type === 'user'
      ? {
          kind: invoker.launchKind,
          initiator: initiatorOf(actor),
        }
      : invoker.type === 'scheduled'
        ? { kind: 'schedule' }
        : invoker.type === 'event'
          ? { kind: 'event' }
          : { kind: 'webhook' }
  const triggerContext =
    invoker.type === 'event' || invoker.type === 'webhook' ? invoker.triggerContext : null
  const metadata: RootLaunchMetadata = {
    provenance,
    launchOrigin: deriveTaskLaunchOrigin(provenance),
    intentSource: invoker.type === 'user' ? 'rest' : 'scheduler',
    scheduledTaskId: invoker.type === 'scheduled' ? invoker.scheduledTaskId : null,
    webhookTriggerId: invoker.type === 'webhook' ? invoker.webhookTriggerId : null,
    webhookFireId: invoker.type === 'webhook' ? invoker.webhookFireId : null,
    eventSubscriptionId: invoker.type === 'event' ? invoker.eventSubscriptionId : null,
    eventDeliveryId: invoker.type === 'event' ? invoker.eventDeliveryId : null,
    triggerContext,
    sourceTerminationSnapshot:
      invoker.type === 'event' || invoker.type === 'webhook'
        ? (invoker.sourceTerminationSnapshot ?? null)
        : null,
  }
  const issue = taskLaunchAdmissionIssue(provenance, {
    ...(metadata.scheduledTaskId === null ? {} : { scheduledTaskId: metadata.scheduledTaskId }),
    ...(metadata.webhookTriggerId === null ? {} : { webhookTriggerId: metadata.webhookTriggerId }),
    ...(metadata.webhookFireId === null ? {} : { webhookFireId: metadata.webhookFireId }),
    ...(metadata.eventSubscriptionId === null
      ? {}
      : { eventSubscriptionId: metadata.eventSubscriptionId }),
    ...(metadata.eventDeliveryId === null ? {} : { eventDeliveryId: metadata.eventDeliveryId }),
    hasTriggerContext: metadata.triggerContext !== null,
  })
  if (issue !== null) throw new ValidationError(issue.code, issue.message)
  return metadata
}

function sameSourceTerminationSnapshot(
  left: SourceTerminationSnapshot,
  right: SourceTerminationSnapshot,
): boolean {
  return (
    left.binding === right.binding &&
    left.launchRevision === right.launchRevision &&
    left.fence === right.fence &&
    left.effectRevision === right.effectRevision
  )
}

function assertProtectedLaunchGuard(
  invoker: ExecutionInvoker,
  guard: TaskLaunchGuard | undefined,
): void {
  if (guard === undefined) return
  if (invoker.type !== 'event' && invoker.type !== 'webhook') {
    throw new ValidationError(
      'protected-launch-invoker-invalid',
      'an MR launch guard requires an event or webhook invoker',
    )
  }
  if (
    invoker.sourceTerminationSnapshot === undefined ||
    !sameSourceTerminationSnapshot(invoker.sourceTerminationSnapshot, guard.snapshot)
  ) {
    throw new ValidationError(
      'protected-launch-snapshot-mismatch',
      'the launch invoker must carry the exact protected MR snapshot',
    )
  }
}

export interface RootTaskLaunchRequest {
  readonly actor: Actor
  readonly resourceAuthority: TaskExecutionResourceAuthority
  readonly invoker: ExecutionInvoker
  readonly guard?: TaskLaunchGuard
  readonly task: TaskStartOptions
  readonly subject: RootTaskLaunchSubject
  readonly uploads?: Readonly<{
    parts: readonly TaskRouteMultipartFilePart[]
    definitions: ReturnType<typeof collectUploadInputDefs>
    limits: Parameters<typeof validateUploadPlan>[0]['limits']
  }>
  /**
   * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）—— **延后仓库准备**。
   *
   * 由启动路各自决定：JSON body 启动与定时 / webhook 触发开（失败要留下一行可重试的
   * 任务），multipart 与代理 / 工作组直启不开（前者要把上传物写进工作树，后者按 G7
   * 保持同步语义）。带上传时本标志**一律忽略**——上传物必须落进真工作树。
   *
   * 关掉时逐字维持既有行为：物化在落行之前，失败抛给调用方。
   */
  readonly deferRepoPreparation?: boolean
  /**
   * Provider-private facts for non-HTTP launches that still use this exact
   * TaskExecution transaction. The alternate workspace is a real caller-owned
   * lease; TaskExecution remains the sole writer of task and launch-intent rows.
   */
  readonly internal?: Readonly<{
    readonly catalogVisibility?: TaskCatalogVisibility
    readonly digitalEmployeeLaunch?: Readonly<{
      readonly actionRunId: string
      readonly caseId?: string
    }>
    readonly platformInputPaths?: readonly string[]
    readonly workspace?: TaskRouteWorkspaceParticipant
    /**
     * RFC-368 —— 数字员工 Reaction 的执行身份在 admission 事务里就**预分配**好了，
     * 这里拿它当 taskId，而不是由内核现铸。于是「任务已建、ref 还没写回」那一格不存在：
     * 崩溃重放拿回同一个 id，调用方先查这个 id 的任务是否已在，已在就不再 launch。
     * 不传时行为与改造前逐字相同（`nextId()`）。
     */
    readonly preallocatedTaskId?: string
  }>
}

export interface RootTaskLaunchKernel {
  launch(input: RootTaskLaunchRequest): Promise<Task>
}

async function rollbackWorkspace(
  workspace: TaskRoutePreparedWorkspace,
): Promise<WorkspaceCleanupReport> {
  try {
    return await workspace.rollback()
  } catch (error) {
    return {
      taskId: workspace.taskId,
      complete: false,
      failures: [
        {
          stage: 'owned-root-remove',
          taskId: workspace.taskId,
          path: workspace.worktreePath,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }
}

function createRootLaunch(
  dependencies: RootTaskLaunchDependencies,
): (input: RootTaskLaunchRequest) => Promise<Task> {
  const nextId = dependencies.id ?? ulid
  const now = dependencies.now ?? Date.now
  return async (request: RootTaskLaunchRequest): Promise<Task> => {
    // RFC-359 AC-1（plan §5hn 批次一）：平台自有的合成宿主快照**在入口规范化一次**，
    // 之后落库与返回投影用的是**同一份**。
    //
    // 分两处各排一次是错的：库里那行与启动响应体会不一致（我第一版就是那么写的，
    // 只改了 insert，响应体照旧是没几何的那份——把「两个引擎不一致」换成了
    // 「同一个引擎里行与响应不一致」，更糟）。
    const input: RootTaskLaunchRequest = request.subject.builtin
      ? {
          ...request,
          subject: {
            ...request.subject,
            workflowSnapshot: layoutBuiltinWorkflowSnapshot(request.subject.workflowSnapshot),
          },
        }
      : request
    const guard = input.guard
    const preflight = async () => {
      if (input.resourceAuthority.actor !== input.actor) {
        throw new ValidationError(
          'task-launch-authority-mismatch',
          'task launch must use the exact admitted actor and authority pair',
        )
      }
      const metadata = rootLaunchMetadata(
        input.actor,
        input.invoker,
        dependencies.directTaskInitiator,
      )
      assertProtectedLaunchGuard(input.invoker, guard)
      guard?.assertCanCommit()
      await guard?.verifyCanCommit()

      const taskId = input.internal?.preallocatedTaskId ?? nextId()
      const intentId = nextId()
      const refClosureJson = await input.resourceAuthority.resources.freezeCallClosure(
        input.resourceAuthority,
        {
          id: definitionAnchorId(input.subject.subject),
          definition: input.subject.workflowSnapshot,
        },
      )
      assertTriggerPreflight({
        root: input.subject.workflowSnapshot,
        closureJson: refClosureJson,
        source: triggerSourceFromContext(metadata.triggerContext ?? undefined),
      })
      // System tasks retain the same empty Git metadata snapshot as SQLite root launches.
      const gitCommitIdentity =
        input.actor.user.id === SYSTEM_USER_ID
          ? null
          : await dependencies.gitCommitIdentity.execute(input.actor.user.id)
      let bufferedUploads: Awaited<ReturnType<typeof bufferUploadParts>> | undefined
      if (input.uploads !== undefined) {
        bufferedUploads = await bufferUploadParts(input.uploads.parts, input.uploads.definitions)
        validateUploadPlan({
          defs: input.uploads.definitions,
          files: bufferedUploads,
          limits: input.uploads.limits,
        })
      }

      // 带上传时**绝不**延后：上传物要写进真工作树（RFC-287 G7 原文把 multipart 与
      // preCreated 两条一起排除在外）。这一格由内核自己兜住，调用方不必各自记得。
      const deferPreparation = input.deferRepoPreparation === true && input.uploads === undefined
      return {
        taskId,
        intentId,
        refClosureJson,
        metadata,
        gitCommitIdentity,
        bufferedUploads,
        deferPreparation,
      }
    }
    type LaunchContext = Awaited<ReturnType<typeof preflight>>
    const prepare = async ({ taskId, gitCommitIdentity, deferPreparation }: LaunchContext) => {
      return await (input.internal?.workspace ?? dependencies.workspace).prepare({
        actor: input.actor,
        authority: input.resourceAuthority.authority,
        taskId,
        task: input.task,
        gitCommitIdentity,
        ...(deferPreparation ? { defer: true } : {}),
        ...(guard === undefined ? {} : { sourceTerminationSignal: guard.signal }),
      })
    }
    const applyUploads = async (
      { taskId, bufferedUploads }: LaunchContext,
      preparedWorkspace: TaskRoutePreparedWorkspace,
      persistedInputs: Record<string, string>,
    ) => {
      if (
        input.uploads !== undefined &&
        bufferedUploads !== undefined &&
        preparedWorkspace.earlyError === null
      ) {
        const landed = await dependencies.uploads.apply({
          taskId,
          plan: {
            worktreePath: preparedWorkspace.worktreePath,
            ...(preparedWorkspace.kind === 'group' ? { inputsSubdir: UPLOAD_INPUTS_DIR } : {}),
            defs: input.uploads.definitions,
            files: bufferedUploads,
            limits: input.uploads.limits,
          },
        })
        for (const [key, paths] of landed.packedByKey.entries()) {
          persistedInputs[key] = paths.join('\n')
        }
      }
    }
    const admit = async (
      { taskId, intentId, refClosureJson, metadata, gitCommitIdentity }: LaunchContext,
      preparedWorkspace: TaskRoutePreparedWorkspace,
      persistedInputs: Record<string, string>,
    ) => {
      const startedAt = now()
      const { eventRef, projection } = await dependencies.admission.admit({
        actor: input.actor,
        task: input.task,
        subject: input.subject,
        ...(input.internal === undefined ? {} : { internal: input.internal }),
        ...(guard === undefined ? {} : { guard }),
        taskId,
        intentId,
        refClosureJson,
        metadata,
        gitCommitIdentity,
        startedAt,
        preparedWorkspace,
        persistedInputs,
      })
      const failed = preparedWorkspace.earlyError !== null
      return { taskId, intentId, failed, eventRef, projection }
    }
    return await launchTask({
      preflight,
      prepare,
      initialInputs: () => ({ ...input.task.inputs }),
      applyUploads,
      admit,
      rollback: rollbackWorkspace,
      uploadFailure: attachWorkspaceCleanupToMultipartError,
      publish: ({ eventRef }) => dependencies.admission.publishAfterCommit(eventRef),
      submit: ({ taskId, intentId }) =>
        dependencies.coordinator.submit({ taskId, intentId, completionMode: 'background' }),
      guard,
    })
  }
}

export function createRootTaskLaunchKernel(
  dependencies: RootTaskLaunchDependencies,
): RootTaskLaunchKernel {
  const launch = createRootLaunch(dependencies)
  return Object.freeze({ launch })
}
