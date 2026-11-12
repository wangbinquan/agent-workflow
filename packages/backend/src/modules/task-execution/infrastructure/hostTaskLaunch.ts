// RFC-419: host task launch adapters on the provider-selected root launch kernel, moved verbatim from composition
// (actionExecutionEnvironment.ts, digitalEmployeeExecution.ts): each maps an application port's narrow launch request
// (subject, builtin geometry, internal facts) onto the kernel request and borrows the caller's workspace.
import { WorkflowDefinitionSchema, type TaskStartOptions } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ActionHostTaskLaunch } from '../application/ports/actionExecution'
import type { DigitalEmployeeHostLaunch } from '../application/ports/digitalEmployeeExecution'
import type { RootTaskLaunchKernel } from '../application/launch/rootTaskLaunch'
import type { RootTaskLaunchSubject } from '../application/ports/rootTaskAdmission'
import type {
  TaskRoutePreparedWorkspace,
  TaskRouteWorkspaceParticipant,
} from '../application/ports/taskRouteLaunch'
import { admitTransferredWorkspace } from './transferredWorkspaceAdmission'

/** The launch actor (resolved lazily), its resource authority and the kernel; both adapters take the same three. */
export interface HostTaskLaunchDependencies {
  readonly resolveActor: () => Promise<Actor>
  readonly resourceAuthorityFor: (
    actor: Actor,
  ) => Parameters<RootTaskLaunchKernel['launch']>[0]['resourceAuthority']
  readonly launch: RootTaskLaunchKernel
}

/**
 * 借用工作区的 PostgreSQL 租约：目录属于调用方（development-automation / 数字员工），任务只借用它，
 * 回滚只释放租约，物理清理仍由物化它的一方负责。
 */
export function borrowedPostgresqlWorkspace(input: {
  readonly workspacePath: string
  readonly baselineSha: string
}): TaskRouteWorkspaceParticipant {
  return Object.freeze({
    async prepare(
      request: Parameters<TaskRouteWorkspaceParticipant['prepare']>[0],
    ): Promise<TaskRoutePreparedWorkspace> {
      let state: 'open' | 'committed' | 'rolled-back' = 'open'
      return Object.freeze({
        taskId: request.taskId,
        kind: 'single',
        spaceKind: 'internal',
        repoPath: input.workspacePath,
        repoUrl: null,
        cachedRepoId: null,
        repoGroupId: null,
        repoGroupName: null,
        worktreePath: input.workspacePath,
        baseBranch: input.baselineSha,
        branch: '',
        baseCommit: input.baselineSha,
        earlyError: null,
        repositories: [],
        nodePaths: [],
        admit: (transaction: PersistenceDb) =>
          admitTransferredWorkspace(transaction, {
            kind: 'borrowed',
            taskId: request.taskId,
            worktreePath: input.workspacePath,
            baseCommit: input.baselineSha,
            ownerRef: request.taskId,
          }),
        commit() {
          if (state !== 'open') throw new Error(`borrowed-workspace-already-${state}`)
          state = 'committed'
        },
        async rollback() {
          if (state !== 'open') throw new Error(`borrowed-workspace-already-${state}`)
          state = 'rolled-back'
          return { taskId: request.taskId, complete: true, failures: [] }
        },
      })
    },
  })
}

/** RFC-419 (moved verbatim from composition/actionExecutionEnvironment.ts): an agent / script action host task on the
 * provider-selected root launch kernel, synthesized host subject on the borrowed workspace. */
export async function launchActionHostTask(
  deps: HostTaskLaunchDependencies,
  input: ActionHostTaskLaunch,
): Promise<string> {
  const task: TaskStartOptions = {
    name: input.name,
    inputs: { ...input.inputs },
    ...(input.wallTimeMs === null ? {} : { maxDurationMs: input.wallTimeMs }),
  }
  const actor = await deps.resolveActor()
  const launched = await deps.launch.launch({
    actor,
    resourceAuthority: deps.resourceAuthorityFor(actor),
    invoker: { type: 'user', launchKind: 'direct-json' },
    task,
    subject: {
      subject: { kind: 'digital-employee', sourceId: null },
      workflowVersion: 1,
      // 平台自有的合成宿主：写时冻结规范排版（plan §5hn）。
      builtin: true,
      workflowSnapshot: WorkflowDefinitionSchema.parse(input.snapshot),
    },
    internal: {
      catalogVisibility: 'internal',
      digitalEmployeeLaunch: { actionRunId: input.actionRunId },
      platformInputPaths: input.platformInputPaths,
      workspace: borrowedPostgresqlWorkspace({
        workspacePath: input.workspacePath,
        baselineSha: input.baselineSha,
      }),
    },
  })
  return launched.id
}

/**
 * RFC-415 — one digital employee host task on the provider-selected root launch kernel, moved verbatim from the
 * execution core's launch tail: the subject (a user-selected workflow keeps its authored geometry; the synthesized host
 * snapshot is frozen at write time, plan §5hn), the lazily resolved actor, its resource authority, and the internal
 * facts — catalog-internal, the preallocated execution identity, the Reaction round / case and, for a repository scene,
 * the platform input mounts and the borrowed workspace lease.
 */
export async function launchDigitalEmployeeHost(
  deps: HostTaskLaunchDependencies,
  request: DigitalEmployeeHostLaunch,
): Promise<{ readonly id: string }> {
  const subject: RootTaskLaunchSubject =
    request.subject.kind === 'workflow'
      ? {
          subject: { kind: 'workflow', sourceId: request.subject.workflowId },
          workflowName: request.subject.workflowName,
          workflowVersion: request.subject.workflowVersion,
          workflowSnapshot: request.subject.workflowSnapshot,
          // 用户选定的既有工作流：保留作者几何，不重排（plan §5hn）。
          builtin: false,
        }
      : {
          subject: { kind: 'digital-employee', sourceId: null },
          workflowVersion: 1,
          workflowSnapshot: request.subject.workflowSnapshot,
          // 合成的宿主快照：写时冻结规范排版（plan §5hn）。
          builtin: true,
        }
  const launchActor = await deps.resolveActor()
  const launched = await deps.launch.launch({
    actor: launchActor,
    resourceAuthority: deps.resourceAuthorityFor(launchActor),
    invoker: { type: 'user', launchKind: 'direct-json' },
    task: request.task,
    subject,
    internal: {
      catalogVisibility: 'internal',
      preallocatedTaskId: request.taskId,
      digitalEmployeeLaunch: {
        actionRunId: request.roundRef,
        caseId: request.caseId,
      },
      ...(request.repository !== null
        ? {
            platformInputPaths: request.repository.platformInputPaths,
            workspace: borrowedPostgresqlWorkspace({
              workspacePath: request.repository.workspacePath,
              baselineSha: request.repository.baselineSha,
            }),
          }
        : {}),
    },
  })
  return { id: launched.id }
}
