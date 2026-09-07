// RFC-359 W5-T21b: construct the complete provider runtime, then use its real
// launch, ownership, driver, read model and maintenance bindings on each engine.
// The caller owns the temporary Git directory. Both launchers borrow it using
// the same production lease used by development-automation host tasks.

import { WorkflowDefinitionSchema, type StartTask } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { workflows } from '@/db/schema'
import { actorOfDirectAuthority } from '@/auth/session'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { createTaskDagCollaborationOperations } from '@/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import { composeWorkgroupTurnsOperations } from '@/modules/resource-catalog/composition/workgroupTurns'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import { resolveTaskDriveConfig } from '@/modules/task-execution/application/drive/taskDriveTypes'
import type { TaskDriveRuntimeOptions } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import { borrowedPostgresqlWorkspace } from '@/modules/task-execution/composition/actionExecutionEnvironment'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  composePostgresqlTaskExecutionProviderRuntime,
  composeSqliteTaskExecutionProviderRuntime,
  type SelectedPostgresqlTaskExecutionProviderRuntime,
  type SelectedSqliteTaskExecutionProviderRuntime,
} from '@/modules/task-execution/composition/providerRuntime'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import { createPostgresqlTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/postgresqlTaskDriverLifecycle'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { composeSqliteRuntimeRegistryOperations } from '@/platform/runtime-registry/composition'
import { createTaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'
import { startTask } from '@/services/task'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createLogger } from '@/util/log'
import { admitTestDirectAuthority } from './identityAccessAuthority'
import type { ProviderHarness } from './eachProvider'
import { createTestRepositoryPublicationTransport } from './taskExecutionTestTopology'
import { sqliteMemoryInjectionQueries } from './memoryInjection'

/** The tested workflow has no code-host, dynamic-workflow or child-launch node.
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
) {
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
          runtimeSessionLeases: createRuntimeSessionLeaseOperations(sqlite),
          runtimeRegistry: composeSqliteRuntimeRegistryOperations(sqlite),
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
      persistence: provider.persistence,
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
          awaitScheduler: true,
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
          submit: (request) => coordinator.submit({ ...request, completionMode: 'await-settle' }),
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
    persistence: provider.persistence,
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
