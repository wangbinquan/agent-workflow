// RFC-359 W5-T21b: construct the complete provider runtime, then use its real
// launch, ownership, driver, read model and maintenance bindings on each engine.
// The caller owns the temporary Git directory. Both launchers borrow it using
// the same production lease used by development-automation host tasks.

import { WorkflowDefinitionSchema, type StartTask } from '@agent-workflow/shared'
import { composeAgentLaunchResourceOperations } from '@/modules/task-execution/composition/agentLaunchResources'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, mcps, workflows } from '@/db/schema'
import { actorOfDirectAuthority } from '@/auth/session'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { createTaskDagCollaborationOperations } from '@/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import { composeWorkgroupTurnsOperations } from '@/modules/resource-catalog/composition/workgroupTurns'
import { agentFromPersistenceRow } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { mcpFromPersistenceRow } from '@/modules/resource-catalog/infrastructure/mcpPersistence'
import { createPluginRepository } from '@/modules/resource-catalog/infrastructure/pluginRepository'
import { listSkills } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import {
  resolveTaskDriveConfig,
  type TaskDriveCompletionMode,
} from '@/modules/task-execution/application/drive/taskDriveTypes'
import type { TaskDriveRuntimeOptions } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import { borrowedPostgresqlWorkspace } from '@/modules/task-execution/composition/actionExecutionEnvironment'
import { createRootTaskLaunchKernel } from '@/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import { createTestHostTaskLaunchKernel } from './hostTaskLaunchKernel'
import type { ActionExecutionEnvironment } from '@/modules/task-execution/composition/actionExecutionRunners'
import { composeAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composeScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'
import type { BoundRunTaskOptions } from '@/modules/task-execution/composition/taskEngineRuntimeOptions'
import {
  composePostgresqlTaskExecutionProviderRuntime,
  composeSqliteTaskExecutionProviderRuntime,
  type SelectedPostgresqlTaskExecutionProviderRuntime,
  type SelectedSqliteTaskExecutionProviderRuntime,
} from '@/modules/task-execution/composition/providerRuntime'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import { createTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { composeRuntimeRegistryOperations } from '@/platform/runtime-registry/composition'
import { createTaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'
import { startTask } from '@/services/task'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createLogger } from '@/util/log'
import { admitTestDirectAuthority } from './identityAccessAuthority'
import type { ProviderHarness } from './eachProvider'
import { createTestRepositoryPublicationTransport } from './taskExecutionTestTopology'
import { sqliteMemoryInjectionQueries } from './memoryInjection'

/** Real catalog rows and owner decoders supply the validation inventory on either DB. */
export function createTestDynamicWorkflowOperations(
  db: ProviderNeutralDatabase,
): BoundRunTaskOptions['dynamicWorkflow'] {
  const plugins = createPluginRepository({ db }).repository
  return Object.freeze({
    persistence: composeDynamicWorkflowPersistence(db),
    validationContext: Object.freeze({
      async load() {
        const [agentRows, skills, mcpRows, pluginRows] = await Promise.all([
          db.select().from(agents),
          listSkills(db),
          db.select().from(mcps),
          plugins.list(),
        ])
        return {
          agents: agentRows.map(agentFromPersistenceRow),
          skills,
          mcps: mcpRows.map(mcpFromPersistenceRow),
          plugins: [...pluginRows],
        }
      },
    }),
  })
}

/** The tested workflow has no code-host or child-launch node.
 * Unexpected use fails explicitly; database and task execution are never mocked. */
function unusedCapability<T>(name: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`execution-chain fixture unexpectedly used ${name}`)
      },
    },
  ) as T
}

export async function createEachProviderTaskExecution(
  harness: ProviderHarness,
  runConfig: TaskDriveRuntimeOptions,
  userId: string,
  options: {
    readonly completionMode?: TaskDriveCompletionMode
    /**
     * RFC-359 AC-1（第 9 刀第 1 步）：SQLite 的路由壳在调用 `retryNode` / `resumeTask`
     * **之前**就展开这个对象，所以缺省那个「一调用就炸」的桩会让 retry / resume 两个动词
     * 在 SQLite lane 上根本驱动不起来（对拍拿不到真实答案）。要驱动它们的用例把真的交进来；
     * 其余用例保持原样——不该被调用到的依赖仍然当场炸，而不是静默走假路径。
     */
  } = {},
) {
  const completionMode = options.completionMode ?? 'await-settle'
  const { db } = harness
  const identityAccess = createIdentityAccessRuntime({ db })
  const admitted = await admitTestDirectAuthority(identityAccess.directAuthority, {
    source: 'session',
    userId,
  })
  if (admitted === null) throw new Error('execution-chain fixture identity unavailable')
  const actor = actorOfDirectAuthority(admitted)
  const resources = createTaskExecutionResourceBinding(
    db,
    composeTaskExecutionResourceBinding(taskExecutionResourceDependencies),
  )
  const launchResources = Object.freeze({
    actor,
    authority: identityAccess.directAuthority.authorityForLegacyProjection(actor),
    resources,
  })
  const persistence = createTaskExecutionPersistence(db)
  const dynamicWorkflow = createTestDynamicWorkflowOperations(db)
  const appHome = runConfig.appHome
  const configPath = join(appHome, 'config.json')
  const collaborationRuntime = createCollaborationRuntimeMechanics(db)
  const workgroupClarify = composeWorkgroupTaskRoomClarifyParticipantFactory()
  const workgroupTurns = composeWorkgroupTurnsOperations(
    db,
    composeWorkgroupHostLedgerParticipantFactory({ collaboration: workgroupClarify }),
    createWorkgroupClarifyAskGate(db),
  )
  const runtimeIdentity = {
    delegatedRequests: identityAccess.delegatedRequests,
    taskExecutionResources: resources,
  }
  const rootResumeRuntime = () => ({ runConfig, actorUserId: actor.user.id })
  const unavailable = (name: string): never => {
    throw new Error(`execution-chain fixture unexpectedly invoked ${name}`)
  }

  /**
   * RFC-359 AC-1（plan §5hh）—— **用启动内核启动一次，两个引擎都走这一条**。
   *
   * 为什么要有它：下面按引擎分叉的 `launch` 各走各的机制（SQLite = `startTask` +
   * `preCreatedWorktree`，PostgreSQL = 启动内核 + 借用工作区租约），于是
   * 「内核 + SQLite 库」这个组合**全仓没有任何地方在跑**（plan §5hg 的表）。
   * 而把两份 action 执行装配面合一时取的正是内核那半——合并之后**生产 SQLite 就会走它**。
   * 先让这个组合在测试里真跑起来，合并才从赌变成接线。
   *
   * 协调器用记录式桩：本用例要证的是**启动事务本身**在这个引擎上成立
   * （开事务、插 task 行、借用工作区的租约 commit、返回 id），
   * 「任务被真正驱动到 done」由 `rfc359-w5-t21b-execution-chain` 覆盖，不在这里重复。
   */
  async function launchViaKernel(
    task: StartTask,
    workspace: { readonly workspacePath: string; readonly baselineSha: string },
  ): Promise<{ readonly taskId: string; readonly submitted: readonly string[] }> {
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, task.workflowId))
      .limit(1)
    if (workflow === undefined) throw new Error('kernel-launch fixture workflow missing')
    const submitted: string[] = []
    const kernel = createRootTaskLaunchKernel({
      db,
      gitCommitIdentity: identityAccess.getUserGitCommitIdentity,
      // 借用工作区的启动走 `internal.workspace`，这个物化面不会被调用到。
      workspace: { prepare: () => unavailable('kernel workspace.prepare') },
      coordinator: {
        async submit(request: { readonly taskId: string }) {
          submitted.push(request.taskId)
        },
      },
    } as unknown as Parameters<typeof createRootTaskLaunchKernel>[0])
    const launched = await kernel.launch({
      actor,
      resourceAuthority: launchResources,
      invoker: { type: 'user', launchKind: 'direct-json' },
      task,
      internal: { workspace: borrowedPostgresqlWorkspace(workspace) },
      subject: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowVersion: workflow.version,
        workflowSnapshot: WorkflowDefinitionSchema.parse(JSON.parse(workflow.definition)),
      },
    } as unknown as Parameters<typeof kernel.launch>[0])
    return { taskId: launched.id, submitted }
  }

  if (harness.capabilities.isolation === 'exclusive') {
    const sqlite = db as unknown as DbClient
    const provider: SelectedSqliteTaskExecutionProviderRuntime =
      composeSqliteTaskExecutionProviderRuntime(sqlite, {
        runtime: {
          identityAccess: runtimeIdentity,
          memoryInjectionQueries: sqliteMemoryInjectionQueries(sqlite),
          collaborationRuntime,
          workgroupTurns,
          dynamicWorkflow,
          runtimeSessionLeases: createRuntimeSessionLeaseOperations(sqlite),
          runtimeRegistry: composeRuntimeRegistryOperations(sqlite),
          repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
          codeHostConnections: unusedCapability('code-host connection'),
        },
        routeLaunch: {
          configPath,
          // RFC-359 AC-1（plan §5hn 批次一）：单代理启动臂现在也要根内核的那套依赖。
          // 本 harness 不经路由启动 agent（它直接用 `launch` / `launchViaKernel`），
          // 所以这几格给到不会被调用到的最小形状——真被调用会当场炸，而不是静默走假路径。
          gitCommitIdentity: identityAccess.getUserGitCommitIdentity,
          agent: {
            // RFC-359 AC-1（第 13 刀下）：`resources` 交**生产那一份**——`syncWorkflow` 合一之后
            // 它的静态校验门就是这里的 `validateHostWorkflow`（两个引擎同一份、只收中立句柄）。
            // 此前这一格是「一碰就炸」的桩，于是本 harness 上的 sync 一调用就撞桩。
            resources: composeAgentLaunchResourceOperations({ db }),
            integrity: unusedCapability('agent route launch integrity'),
          },
          routeWorkspace: { appHome },
          resourceAuthorityFor: () => launchResources,
          coordinator: { submit: () => unavailable('agent route coordinator') },
          workgroup: unusedCapability('workgroup route launch resources'),
        },
        // RFC-359 AC-1（第 13 刀下）：`startDepsFor` 整格消失——`syncWorkflow` 是这条路上
        // 最后一个要 legacy `StartTaskDeps` 的路由动词，合一之后路由层不再持有它。
        routes: () => ({
          collaboration: unusedCapability('collaboration route'),
          multipart: unusedCapability('multipart upload'),
          resourceAuthorityFor: () => launchResources,
          owners: composeOwnerIdentityQueries(db),
          assertWorkflowLaunchable: async () => unavailable('workflow route validation'),
          appHome,
        }),
        lifecycleRepair: {},
        fusion: { appHome },
        rootResumeRuntime,
        repositoryPreparationRetry: {
          retry: async () => unavailable('repository preparation retry'),
        },
      })
    return {
      provider,
      actor,
      identityAccess,
      launchResources,
      persistence: provider.persistence,
      composeLegacyMissionLaunchers(options: LegacyMissionActionLauncherOptions) {
        // RFC-359 AC-1（plan §5hi）：SQLite 这一支也走启动内核，和 PG 同一个装配面
        // （生产侧对应 `cli/start.ts` / `server.ts`）。协调器是真的——本 harness 的
        // `rfc359-w14-legacy-mission-execution` 要把任务驱到终态，不能用记录式桩。
        const deps = {
          db: sqlite,
          resolveActor: async () => actor,
          resourceAuthorityFor: () => launchResources,
          launch: createTestHostTaskLaunchKernel({
            db: sqlite,
            appHome,
            gitCommitIdentity: identityAccess.getUserGitCommitIdentity,
            coordinatorDeps: {
              db: sqlite,
              ...runConfig,
              schedulerDriver: provider.runtime.schedulerDriver,
            },
            persistence: provider.persistence,
            completionMode,
          }),
          cancelTask: (taskId: string) =>
            provider.cancellation.cancel({ taskId, cause: { kind: 'user' } }),
          readModels: provider.readModels,
          agents: options.agents,
          terminalPollMs: options.terminalPollMs,
        }
        return {
          agentLauncher: composeAgentActionExecution({
            ...deps,
            onTerminal: options.onAgentTerminal,
          }),
          scriptLauncher: composeScriptActionExecution({
            ...deps,
            onTerminal: options.onScriptTerminal,
          }),
        }
      },
      async launch(
        task: StartTask,
        workspace: { readonly workspacePath: string; readonly baselineSha: string },
      ) {
        return await startTask(task, {
          db: sqlite,
          ...runConfig,
          schedulerDriver: provider.runtime.schedulerDriver,
          taskRecoveryOperations: provider.recovery,
          identityAccess,
          launchResources,
          actorUserId: actor.user.id,
          launchProvenance: { kind: 'direct-json', initiator: 'api' },
          awaitScheduler: completionMode === 'await-settle',
          internalSource: {
            kind: 'local-path',
            repoPath: workspace.workspacePath,
            baseBranch: workspace.baselineSha,
          },
          preCreatedWorktree: {
            taskId: ulid(),
            worktreePath: workspace.workspacePath,
            branch: '',
            baseCommit: workspace.baselineSha,
            cleanup: { kind: 'borrowed' },
          },
        })
      },
      launchViaKernel,
      isActive: provider.runtime.schedulerDriver.isTaskActive,
      overview: () => provider.overview.load({ actor, since: 0 }),
      shutdown: () => identityAccess.shutdown(),
    }
  }

  const postgresql = db as unknown as PostgresqlDatabaseClient
  const log = createLogger('rfc359-execution-chain')
  const provider: SelectedPostgresqlTaskExecutionProviderRuntime =
    composePostgresqlTaskExecutionProviderRuntime(postgresql, {
      runtime: {
        persistence,
        taskDagCollaboration: createTaskDagCollaborationOperations(db),
        collaborationRuntime,
        workgroupTurns,
        dynamicWorkflow,
        identityAccess: runtimeIdentity,
        repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
        codeHostConnections: unusedCapability('code-host connection'),
        processConcurrencyScope: {},
        daemonGeneration: `rfc359-execution-chain-${ulid()}`,
        finalizeWorkspace: async () => {},
        log,
      },
      routeLaunch: {
        configPath,
        gitCommitIdentity: identityAccess.getUserGitCommitIdentity,
        resourceAuthorityFor: () => launchResources,
        coordinator: {
          submit: (request) => coordinator.submit({ ...request, completionMode }),
        },
        agent: {
          // RFC-359 AC-1（第 13 刀下）：与 SQLite 泳道**同一份**——`syncWorkflow` 的静态校验门。
          resources: composeAgentLaunchResourceOperations({ db }),
          integrity: unusedCapability('agent route integrity'),
        },
        workgroup: unusedCapability('workgroup route resources'),
      },
      routeWorkspace: { appHome },
      routes: () => ({
        collaboration: unusedCapability('collaboration route'),
        users: unusedCapability('task user directory'),
        owners: unusedCapability('task owner directory'),
        membershipEvents: unusedCapability('task member events'),
        deletionEvents: unusedCapability('task deletion events'),
        appHome,
      }),
      lifecycleRepair: {},
      fusion: { appHome },
      rootResumeRuntime,
      workgroupTaskRoom: { collaboration: workgroupClarify },
    })
  const coordinator = new DefaultTaskDriveCoordinator({
    runtime: resolveTaskDriveConfig(runConfig),
    lifecycle: createTaskDriverLifecyclePort({
      db: postgresql,
      module: provider.executionModule,
      claim: (intentId) => provider.executionModule.claimPersisted({ intentId }),
      persistence,
      log,
      finalizeWorkspace: async () => {},
    }),
    repositoryPreparation: skipRepositoryPreparation,
    engineOrchestrator: {
      async drive(context) {
        await provider.runtime.schedulerDriver.drive({
          taskId: context.taskId,
          appHome: context.runtime.appHome,
          ...context.runtime.runtime,
          signal: context.signal,
          executionContext: context.execution,
        })
      },
    },
    failureReporter: {
      async report({ taskId, error, execution }) {
        await persistence.runtimeLifecycle.trySet({
          taskId,
          to: 'failed',
          allowedFrom: ['pending', 'running'],
          extra: {
            finishedAt: Date.now(),
            errorSummary: 'task drive failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          executionContext: execution,
          now: Date.now(),
          reason: 'task-drive',
        })
      },
    },
  })
  return {
    provider,
    actor,
    identityAccess,
    launchResources,
    persistence: provider.persistence,
    composeLegacyMissionLaunchers(options: LegacyMissionActionLauncherOptions) {
      const deps = {
        db: postgresql,
        resolveActor: async () => actor,
        resourceAuthorityFor: () => launchResources,
        launch: provider.routeLaunch.workflow,
        cancelTask: (taskId: string) =>
          provider.cancellation.cancel({ taskId, cause: { kind: 'user' } }),
        readModels: provider.readModels,
        agents: options.agents,
        terminalPollMs: options.terminalPollMs,
      }
      return {
        agentLauncher: composeAgentActionExecution({
          ...deps,
          onTerminal: options.onAgentTerminal,
        }),
        scriptLauncher: composeScriptActionExecution({
          ...deps,
          onTerminal: options.onScriptTerminal,
        }),
      }
    },
    async launch(
      task: StartTask,
      workspace: { readonly workspacePath: string; readonly baselineSha: string },
    ) {
      const [workflow] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, task.workflowId))
        .limit(1)
      if (workflow === undefined) throw new Error('execution-chain fixture workflow missing')
      return await provider.routeLaunch.workflow.launch({
        actor,
        resourceAuthority: launchResources,
        invoker: { type: 'user', launchKind: 'direct-json' },
        task,
        internal: { workspace: borrowedPostgresqlWorkspace(workspace) },
        subject: {
          workflowId: workflow.id,
          workflowName: workflow.name,
          // fixture 用的是普通工作流行，不是平台合成宿主。
          builtin: false,
          workflowVersion: workflow.version,
          workflowSnapshot: WorkflowDefinitionSchema.parse(JSON.parse(workflow.definition)),
        },
      })
    },
    launchViaKernel,
    isActive: provider.participants.activity.isActive,
    overview: () => provider.overview.load({ actor, since: 0 }),
    shutdown: () => identityAccess.shutdown(),
  }
}

export interface LegacyMissionActionLauncherOptions {
  readonly agents: ActionExecutionEnvironment['agents']
  readonly onAgentTerminal: (executionRef: string) => void | Promise<void>
  readonly onScriptTerminal: (executionRef: string) => void | Promise<void>
  readonly terminalPollMs?: number
}
