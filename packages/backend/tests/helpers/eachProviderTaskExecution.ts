// RFC-359 W5-T21b: real launch, ownership, driver and persistence on each engine.
// The caller owns the temporary Git directory. Both launchers borrow it using
// the same production lease used by development-automation host tasks.

import { WorkflowDefinitionSchema, type StartTask } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
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
import { composeTaskExecutionRuntime } from '@/modules/task-execution/composition/taskExecutionRuntime'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import { createPostgresqlTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/postgresqlTaskDriverLifecycle'
import { createPostgresqlTaskExecutionRuntimeParticipants } from '@/modules/task-execution/infrastructure/postgresqlTaskExecutionRuntimeParticipants'
import { createPostgresqlRootTaskLaunchKernel } from '@/modules/task-execution/infrastructure/postgresqlTaskRouteLaunchOperations'
import { createTaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'
import { startTask } from '@/services/task'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createLogger } from '@/util/log'
import { admitTestDirectAuthority } from './identityAccessAuthority'
import type { ProviderHarness } from './eachProvider'
import {
  composeTaskExecutionTestRuntime,
  createTestRepositoryPublicationTransport,
} from './taskExecutionTestTopology'

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

  if (harness.capabilities.isolation === 'exclusive') {
    const sqlite = db as unknown as DbClient
    const runtime = composeTaskExecutionTestRuntime(sqlite)
    return {
      persistence,
      async launch(
        task: StartTask,
        workspace: { readonly workspacePath: string; readonly baselineSha: string },
      ) {
        return await startTask(task, {
          db: sqlite,
          ...runConfig,
          schedulerDriver: runtime.schedulerDriver,
          taskRecoveryOperations: persistence.recoveryAdministration,
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
      isActive: runtime.schedulerDriver.isTaskActive,
      shutdown: () => identityAccess.shutdown(),
    }
  }

  const postgresql = db as unknown as PostgresqlDatabaseClient
  const log = createLogger('rfc359-execution-chain')
  const participants = createPostgresqlTaskExecutionRuntimeParticipants(postgresql, {
    persistence,
    taskDagCollaboration: createTaskDagCollaborationOperations(db),
    collaborationRuntime: createCollaborationRuntimeMechanics(db),
    workgroupTurns: composeWorkgroupTurnsOperations(
      db,
      composeWorkgroupHostLedgerParticipantFactory({
        collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
      }),
      createWorkgroupClarifyAskGate(db),
    ),
    childLaunchWorkgroup: unusedCapability('child workgroup launch'),
    identityAccess: {
      delegatedRequests: identityAccess.delegatedRequests,
      taskExecutionResources: resources,
    },
    repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
    codeHostConnections: unusedCapability('code-host connection'),
    processConcurrencyScope: {},
    daemonGeneration: `rfc359-execution-chain-${ulid()}`,
    finalizeWorkspace: async () => {},
    log,
  })
  const runtime = composeTaskExecutionRuntime({ participants, readModels: persistence.reads })
  const coordinator = new DefaultTaskDriveCoordinator({
    runtime: resolveTaskDriveConfig(runConfig),
    lifecycle: createPostgresqlTaskDriverLifecyclePort({
      db: postgresql,
      module: participants.executionModule,
      persistence,
      log,
      finalizeWorkspace: async () => {},
    }),
    repositoryPreparation: skipRepositoryPreparation,
    engineOrchestrator: {
      async drive(context) {
        await runtime.schedulerDriver.drive({
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
    persistence,
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
      const kernel = createPostgresqlRootTaskLaunchKernel({
        db: postgresql,
        gitCommitIdentity: identityAccess.getUserGitCommitIdentity,
        workspace: borrowedPostgresqlWorkspace(workspace),
        coordinator: {
          // Await the real driver and release protocol, without polling or
          // rewriting task status. Production HTTP uses background completion.
          submit: (request) => coordinator.submit({ ...request, completionMode: 'await-settle' }),
        },
      })
      return await kernel.launch({
        actor,
        resourceAuthority: launchResources,
        invoker: { type: 'user', launchKind: 'direct-json' },
        task,
        subject: {
          workflowId: workflow.id,
          workflowName: workflow.name,
          workflowVersion: workflow.version,
          workflowSnapshot: WorkflowDefinitionSchema.parse(JSON.parse(workflow.definition)),
        },
      })
    },
    isActive: participants.activity.isActive,
    shutdown: () => identityAccess.shutdown(),
  }
}
