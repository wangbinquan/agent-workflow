// RFC-359 W5-T21b: construct the complete provider runtime, then use its real
// launch, ownership, driver, read model and maintenance bindings on each engine.
// The caller owns the temporary Git directory. Both launchers borrow it using
// the same production lease used by development-automation host tasks.

import { WorkflowDefinitionSchema, type StartTask } from '@agent-workflow/shared'
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
import type { ActionExecutionEnvironment } from '@/modules/task-execution/composition/actionExecutionRunners'
import {
  composeAgentActionExecution,
  composePostgresqlAgentActionExecution,
} from '@/modules/task-execution/composition/agentActionExecution'
import {
  composeScriptActionExecution,
  composePostgresqlScriptActionExecution,
} from '@/modules/task-execution/composition/scriptActionExecution'
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
import { createPostgresqlTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/postgresqlTaskDriverLifecycle'
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
  options: { readonly completionMode?: TaskDriveCompletionMode } = {},
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
          executionFor: () => unavailable('agent/workgroup route launch'),
        },
        routes: () => ({
          collaboration: unusedCapability('collaboration route'),
          startDepsFor: () => unavailable('task route launch'),
          multipart: unusedCapability('multipart upload'),
          resourceAuthorityFor: () => launchResources,
          assertWorkflowLaunchable: async () => unavailable('workflow route validation'),
          appHome,
        }),
        lifecycleRepair: {
          appHome,
          deps: {
            db: sqlite,
            ...runConfig,
            schedulerDriver: {
              drive: (request) => provider.runtime.schedulerDriver.drive(request),
            },
          },
        },
        fusion: { appHome },
        trigger: { executionFor: () => unavailable('trigger launch') },
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
        const deps = {
          db: sqlite,
          startDeps: {
            db: sqlite,
            ...runConfig,
            schedulerDriver: provider.runtime.schedulerDriver,
            taskRecoveryOperations: provider.recovery,
            identityAccess,
            launchResources,
            actorUserId: actor.user.id,
            awaitScheduler: completionMode === 'await-settle',
          },
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
          resources: unusedCapability('agent route resources'),
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
    lifecycle: createPostgresqlTaskDriverLifecyclePort({
      db: postgresql,
      module: provider.executionModule,
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
        actor,
        resourceAuthorityFor: () => launchResources,
        launch: provider.routeLaunch.workflow,
        cancelTask: (taskId: string) =>
          provider.cancellation.cancel({ taskId, cause: { kind: 'user' } }),
        readModels: provider.readModels,
        agents: options.agents,
        terminalPollMs: options.terminalPollMs,
      }
      return {
        agentLauncher: composePostgresqlAgentActionExecution({
          ...deps,
          onTerminal: options.onAgentTerminal,
        }),
        scriptLauncher: composePostgresqlScriptActionExecution({
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
          workflowVersion: workflow.version,
          workflowSnapshot: WorkflowDefinitionSchema.parse(JSON.parse(workflow.definition)),
        },
      })
    },
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
