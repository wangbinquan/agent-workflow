// RFC-395 II-pre：既有启动夹具改走生产根启动内核 / workflow 参与者；这里只装配依赖与工作区租约。
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  WorkflowDefinitionSchema,
  type StartTask,
  type Task,
  type GitCommitIdentity,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { buildActor, SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import {
  createIdentityAccessRuntime,
  composeIdentityAccess,
} from '@/modules/identity-access/composition'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import {
  materializeSpaceWithProvider,
  cleanupMaterializedSpaceLease,
  type MaterializedSpace,
  type ResolvedRepoSource,
} from '@/modules/source-control/infrastructure/workspaceMaterializer'
import { composeSqliteRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { materializingSpaces } from '@/platform/workspace/materializingSpaces'
import {
  createTaskExecutionLaunchParticipant,
  type RootTaskLaunchRequest,
  type TaskRouteWorkspaceParticipant,
} from '@/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import { createTaskRouteWorkspaceParticipant } from '@/modules/task-execution/infrastructure/taskRouteWorkspaceParticipant'
import { admitTransferredWorkspace } from '@/modules/task-execution/infrastructure/transferredWorkspaceAdmission'
import { loadFrozenSpaceLayout } from '@/modules/task-execution/infrastructure/frozenWorkspaceLayout'
import { composeAgentLaunchResourceOperations } from '@/modules/task-execution/composition/agentLaunchResources'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createChildExecutionLaunchOperations } from '@/modules/task-execution/infrastructure/childExecutionLaunchOperations'
import type { ChildWorkflowLaunchRequest } from '@/modules/task-execution/application/ports/childExecutionLaunchOperations'
import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import { createTaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'
import { getWorkflow } from '@/services/workflow'
import {
  getTask,
  composeTestTaskDriveFactory,
  composeDeferredRepositoryPreparationStep,
  runtimeConfigOpts,
  type TaskContinuationDependencies,
} from '@/services/task'
import type { TaskLaunchProvenance } from '@/modules/task-execution/domain/taskLaunchOrigin'
import type { TaskDriveCoordinator } from '@/modules/task-execution/application/drive/taskDriveTypes'
import { createTestHostTaskLaunchKernel } from './hostTaskLaunchKernel'
import { createTestTaskDriveCoordinator } from './legacyTaskDrive'
import { Paths } from '@/util/paths'
import { NotFoundError } from '@/util/errors'
import type { WorktreeCleanupProvenance } from '@/util/git'

export interface TestTaskLaunchOptions extends TaskContinuationDependencies {
  readonly sourceTerminationLaunchSignal?: AbortSignal
  readonly actor?: Actor
  readonly invoker?: RootTaskLaunchRequest['invoker']
  readonly launchProvenance?: TaskLaunchProvenance
  readonly deferRepoPreparation?: boolean
  readonly catalogVisibility?: 'public' | 'internal'
  readonly platformInputPaths?: readonly string[]
  readonly digitalEmployeeLaunch?: { actionRunId: string; caseId?: string; snapshotJson?: string }
  readonly materializedSpace?: MaterializedSpace
  readonly preResolvedSource?: ResolvedRepoSource
  readonly identityAccess?: ReturnType<typeof createIdentityAccessRuntime>
  readonly gitCommitIdentity?: GitCommitIdentity | null
  readonly coordinator?: TaskDriveCoordinator
  readonly preCreatedWorktree?: {
    taskId: string
    worktreePath: string
    branch: string
    baseCommit: string | null
    cleanup:
      | { kind: 'borrowed' }
      | { kind: 'linked-worktree'; provenance: WorktreeCleanupProvenance }
  }
  readonly callLaunch?: {
    parentTaskId: string
    parentNodeRunId: string
    invocationDepth: number
    launchActorUserId: string
    frozenSnapshotJson: string | null
    refClosureJson: string | null
  }
}

async function fixtureActor(options: TestTaskLaunchOptions): Promise<Actor> {
  if (options.launchResources !== undefined) return options.launchResources.actor
  if (options.actor !== undefined) return options.actor
  const id = options.actorUserId ?? options.callLaunch?.launchActorUserId ?? SYSTEM_USER_ID
  const { users } = tablesOf(options.db)
  const row = (await options.db.select().from(users).where(eq(users.id, id)))[0]
  if (row === undefined) throw new Error(`launch fixture user missing: ${id}`)
  return buildActor({
    user: {
      ...row,
      role: row.role as Actor['user']['role'],
      status: row.status as Actor['user']['status'],
    },
    source:
      options.launchProvenance?.kind === 'direct-json' &&
      options.launchProvenance.initiator === 'api'
        ? 'daemon'
        : 'session',
  })
}

function transferredWorkspace(
  options: TestTaskLaunchOptions,
  appHome: string,
): TaskRouteWorkspaceParticipant {
  return {
    async prepare(request) {
      const preset = options.preCreatedWorktree
      const space =
        options.materializedSpace ??
        (preset === undefined
          ? await materializeSpaceWithProvider(
              request.task,
              {
                appHome,
                repositoryWorkspace:
                  options.repositoryWorkspace ?? composeSqliteRepositoryWorkspaceStore(options.db),
                loadFrozenSpaceLayout: (id) => loadFrozenSpaceLayout(options.db, id),
                internalSource: options.internalSource,
                gitCommitIdentity: request.gitCommitIdentity,
                workspaceCleanupHook: options.workspaceCleanupHook,
              },
              request.taskId,
            )
          : undefined)
      if (space === undefined) {
        const source = options.preResolvedSource ?? options.internalSource
        if (preset === undefined || source === undefined)
          throw new Error('fixture workspace missing')
        return {
          taskId: request.taskId,
          kind: 'single',
          spaceKind: 'internal',
          repoPath: source.repoPath,
          repoUrl: options.preResolvedSource?.repoUrl ?? null,
          cachedRepoId: options.preResolvedSource?.cachedRepoId ?? null,
          repoGroupId: null,
          repoGroupName: null,
          worktreePath: preset.worktreePath,
          baseBranch: source.baseBranch ?? '',
          branch: preset.branch,
          baseCommit: preset.baseCommit,
          earlyError: null,
          repositories: [],
          nodePaths: [],
          admit: (tx) =>
            admitTransferredWorkspace(tx, {
              kind: 'borrowed',
              taskId: request.taskId,
              worktreePath: preset.worktreePath,
              baseCommit: preset.baseCommit,
              ownerRef: request.taskId,
            }),
          commit() {},
          async rollback() {
            return { taskId: request.taskId, complete: true, failures: [] }
          },
        }
      }
      const first = space.resolvedSources[0]
      return {
        taskId: request.taskId,
        kind:
          space.kind === 'scratch'
            ? 'scratch'
            : space.kind === 'group'
              ? 'group'
              : space.repos.length > 1
                ? 'multi'
                : 'single',
        spaceKind: space.spaceKind === 'inherited' ? 'internal' : space.spaceKind,
        repoPath: first?.repoPath ?? space.worktreePath,
        repoUrl: first?.repoUrl ?? null,
        cachedRepoId: first?.cachedRepoId ?? null,
        repoGroupId: request.task.repoGroupId ?? null,
        repoGroupName: null,
        worktreePath: space.worktreePath,
        baseBranch: first?.baseBranch ?? '',
        branch: space.branch,
        baseCommit: space.baseCommit,
        earlyError: space.earlyError,
        repositories: space.repos.map((repo) => ({
          ...repo,
          workingBranch: request.task.workingBranch ?? null,
          workspaceProfileVersion: repo.workspaceProfileVersion ?? null,
          workspaceProfileDigest: repo.workspaceProfileDigest ?? null,
          submoduleInitOk: repo.submoduleInitOk ?? null,
          submoduleInitError: repo.submoduleInitError ?? null,
          hasSubmodules: repo.hasSubmodules ?? null,
        })),
        nodePaths: space.nodePaths,
        admit: (tx) =>
          admitTransferredWorkspace(tx, {
            kind: 'borrowed',
            taskId: request.taskId,
            worktreePath: space.worktreePath,
            baseCommit: space.baseCommit,
            ownerRef: request.taskId,
          }),
        commit() {
          space.cleanup.state = 'committed'
          materializingSpaces.delete(request.taskId)
        },
        async rollback() {
          try {
            return await cleanupMaterializedSpaceLease(space.cleanup, options.workspaceCleanupHook)
          } finally {
            materializingSpaces.delete(request.taskId)
          }
        },
      }
    },
  }
}

export async function launchTestTask(
  task: StartTask,
  options: TestTaskLaunchOptions,
): Promise<Task> {
  const { db } = options
  const appHome = options.appHome ?? Paths.root
  const identity = options.identityAccess ?? createIdentityAccessRuntime({ db })
  const actor = await fixtureActor(options)
  const authority = options.launchResources ?? {
    actor,
    authority: composeIdentityAccess(db).contexts.fromAuthenticatedPrincipal(
      { userId: actor.user.id, source: actor.source },
      'http',
    ).authority,
    resources: createTaskExecutionResourceBinding(
      db,
      composeTaskExecutionResourceBinding(taskExecutionResourceDependencies),
    ),
  }
  const persistence = createTaskExecutionPersistence(db)
  if (options.callLaunch !== undefined) {
    const call = options.callLaunch
    if (options.materializedSpace === undefined) throw new Error('child fixture workspace missing')
    const factory = composeTestTaskDriveFactory({ deps: options, appHome, persistence })
    const launch = createChildExecutionLaunchOperations({
      db,
      persistence,
      coordinatorFactory: {
        session: factory.session,
        coordinatorFor(profile) {
          if (options.coordinator !== undefined) return options.coordinator
          const drive = factory.coordinatorFor(profile)
          return {
            submit: (request) =>
              drive.submit({
                ...request,
                completionMode: options.awaitScheduler === true ? 'await-settle' : 'background',
              }),
          }
        },
      },
      workgroup: undefined as never,
    })
    await launch.launchWorkflow({
      actor,
      parentTaskId: call.parentTaskId,
      parentNodeRunId: call.parentNodeRunId,
      invocationDepth: call.invocationDepth,
      materializedSpace: options.materializedSpace,
      workflowId: task.workflowId,
      frozenWorkflowVersion: 1,
      payload: task,
      frozenSnapshotJson: call.frozenSnapshotJson ?? '{}',
      refClosureJson: call.refClosureJson,
      runtime: { runConfig: { appHome, ...runtimeConfigOpts(options) } },
      schedulerDriver: options.schedulerDriver as ChildWorkflowLaunchRequest['schedulerDriver'],
    } satisfies ChildWorkflowLaunchRequest)
    return (await getTask(db, options.materializedSpace.taskId))!
  }
  const repositoryPreparation =
    options.repositoryPreparation ??
    composeRepositoryPreparation({
      db,
      appHome,
      secretBox: options.secretBox,
      cloneTimeoutMs: options.cloneTimeoutMs,
    })
  const workspace =
    options.internalSource !== undefined ||
    options.materializedSpace !== undefined ||
    options.preCreatedWorktree !== undefined
      ? transferredWorkspace(options, appHome)
      : createTaskRouteWorkspaceParticipant({
          db,
          appHome,
          sourceContexts: identity.taskPreparationContext,
          repositoryPreparation,
          secretBox: options.secretBox,
          cloneTimeoutMs: options.cloneTimeoutMs,
          workspaceCleanupHook: options.workspaceCleanupHook,
        })
  const preparation = composeDeferredRepositoryPreparationStep({
    deps: {
      ...options,
      repositoryPreparation,
      loadFrozenSpaceLayout: (id) => loadFrozenSpaceLayout(db, id),
    },
    appHome,
  })
  const drive = createTestTaskDriveCoordinator({
    deps: options,
    appHome,
    persistence,
    repositoryPreparation: preparation,
  })
  const completionMode = options.awaitScheduler === true ? 'await-settle' : 'background'
  const coordinator = options.coordinator ?? {
    submit: (request: Parameters<TaskDriveCoordinator['submit']>[0]) =>
      drive.submit({ ...request, completionMode }),
  }
  const dependencies = {
    db,
    workspace,
    coordinator,
    gitCommitIdentity:
      options.gitCommitIdentity == null
        ? identity.getUserGitCommitIdentity
        : { execute: async () => options.gitCommitIdentity! },
    launchConfiguration: options.launchConfiguration,
  }
  const invoker = options.invoker ?? {
    type: 'user' as const,
    launchKind:
      options.launchProvenance?.kind === 'direct-multipart'
        ? ('direct-multipart' as const)
        : ('direct-json' as const),
  }
  let launched: Task
  if (
    options.internalSource !== undefined ||
    options.materializedSpace !== undefined ||
    options.preCreatedWorktree !== undefined ||
    options.digitalEmployeeLaunch !== undefined
  ) {
    const workflow = await getWorkflow(db, task.workflowId)
    if (workflow === null)
      throw new NotFoundError('workflow-not-found', `workflow '${task.workflowId}' not found`)
    const kernel = createTestHostTaskLaunchKernel({
      db,
      appHome,
      gitCommitIdentity: dependencies.gitCommitIdentity,
      coordinatorDeps: options,
      persistence,
      completionMode,
      workspace,
      coordinator,
    })
    launched = await kernel.launch({
      actor,
      resourceAuthority: authority,
      invoker,
      task,
      subject: {
        subject: { kind: 'workflow' as const, sourceId: workflow.id },
        workflowName: workflow.name,
        workflowVersion: workflow.version,
        builtin: workflow.builtin === true,
        workflowSnapshot:
          options.digitalEmployeeLaunch?.snapshotJson === undefined
            ? workflow.definition
            : WorkflowDefinitionSchema.parse(
                JSON.parse(options.digitalEmployeeLaunch.snapshotJson),
              ),
      },
      internal: {
        workspace,
        catalogVisibility: options.catalogVisibility,
        platformInputPaths: options.platformInputPaths,
        digitalEmployeeLaunch: options.digitalEmployeeLaunch,
        preallocatedTaskId: options.materializedSpace?.taskId ?? options.preCreatedWorktree?.taskId,
      },
    })
  } else {
    const participant = createTaskExecutionLaunchParticipant({
      ...dependencies,
      configPath: options.configPath ?? `${appHome}/config.json`,
      agent: {
        resources: composeAgentLaunchResourceOperations({ db }),
        integrity: undefined as never,
      },
      workgroup: undefined as never,
    })
    launched = await participant.launch({
      actor,
      resources: authority,
      invoker,
      target: { kind: 'workflow', refId: task.workflowId, payload: task },
      deferRepoPreparation: options.deferRepoPreparation,
    })
  }
  return options.awaitScheduler === true ? (await getTask(db, launched.id))! : launched
}

export function launchTestTaskWithLocalRepo(
  input: StartTask & { repoPath: string; baseBranch: string },
  options: TestTaskLaunchOptions,
): Promise<Task> {
  const { repoPath, baseBranch, ...task } = input
  return launchTestTask(task as StartTask, {
    ...options,
    internalSource: { kind: 'local-path', repoPath, baseBranch },
  })
}
