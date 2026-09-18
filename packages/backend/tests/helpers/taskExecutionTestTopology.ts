import type { DbClient } from '../../src/db/client'
import { createTaskDagCollaborationOperations } from '../../src/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import { createCollaborationRuntimeMechanics } from '../../src/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import type { SchedulerDriverPort } from '../../src/modules/task-execution/public/commands'
import type { SchedulerRuntimeTopology } from '../../src/modules/task-execution/public/participants'
import { composeTaskExecutionRuntime } from '../../src/modules/task-execution/composition/taskExecutionRuntime'
import { createTaskExecutionPersistence } from '../../src/modules/task-execution/composition/taskExecutionPersistence'
import {
  composeLegacyTaskActivityParticipant,
  composeLegacyTaskStopRegistry,
  createTaskExecutionRuntimeParticipants,
} from '../../src/modules/task-execution/infrastructure/taskExecutionRuntimeParticipants'
import { createRuntimeSessionLeaseOperations } from '../../src/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { driveTaskEngineApplication } from '../../src/modules/task-execution/composition/taskEngineApplication'
import type { RunTaskOptions } from '../../src/services/execution/taskEngineRuntimeOptions'
import { createIdentityAccessRuntime } from '../../src/modules/identity-access/composition'
import { composeTaskExecutionResourceBinding } from '../../src/modules/resource-catalog/composition/taskExecution'
import { taskExecutionResourceDependencies } from '../../src/services/execution/taskExecutionResourceDependencies'
import { createTaskExecutionResourceBinding } from '../../src/services/execution/taskExecutionResources'
import { runGit } from '../../src/util/git'
import { sqliteMemoryInjectionQueries } from './memoryInjection'
import { composeRuntimeRegistryOperations } from '../../src/platform/runtime-registry/composition'
import { createWorkgroupClarifyAskGate } from '../../src/modules/collaboration/public/participants'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '../../src/modules/collaboration/composition/workgroupTaskRoomClarify'
import { composeWorkgroupTurnsOperations } from '../../src/modules/resource-catalog/composition/workgroupTurns'
import { composeWorkgroupHostLedgerParticipantFactory } from '../../src/modules/task-execution/composition/workgroupHostLedger'
import { composeWorkgroupLaunchResourceOperations } from '../../src/modules/task-execution/composition/workgroupLaunchResources'
import { createChildExecutionLaunchOperations } from '../../src/modules/task-execution/infrastructure/childExecutionLaunchOperations'
import { createDatabaseTaskDriverLifecyclePort } from '../../src/modules/task-execution/infrastructure/taskDriverLifecycle'
import { createTaskExecutionPersistence as createChildPersistence } from '../../src/modules/task-execution/composition/taskExecutionPersistence'
import { finishClaimedWebhookWorkspacePrune } from '../../src/platform/persistence/sqlite/systemWorkspaceGc'
import { composeResourceCatalogFor } from '../../src/modules/resource-catalog/composition/providerResourceCatalog'
import { composeDatabaseAgentResourceIntegrity } from '../../src/modules/resource-catalog/composition/agentResourceIntegrity'
import { createLogger } from '../../src/util/log'
import type { ProviderNeutralDatabase } from '../../src/db/query'
import { composeDynamicWorkflowPersistence } from '../../src/modules/task-execution/composition/dynamicWorkflowPersistence'
import { buildWorkflowValidationContext } from '../../src/services/workflow.validator'
import type { CodeHostConnectionsService } from '../../src/services/codeHost/connections'

type TaskDriveRequest = Parameters<SchedulerDriverPort['drive']>[0]

export function createTestRepositoryPublicationTransport(runNetwork: typeof runGit = runGit) {
  return Object.freeze({
    async open(input: { readonly remoteUrl: string }) {
      return {
        ok: true as const,
        session: {
          endpointUrl: input.remoteUrl,
          receipt: {
            credentialSource: 'legacy' as const,
            credentialRevision: null,
            endpointSource: 'local-fixture' as const,
            endpointBindingDigest: null,
          },
          runNetwork,
          close() {},
        },
      }
    },
  })
}

export function createTaskExecutionTestIdentity(db: DbClient) {
  const identityAccess = createIdentityAccessRuntime({ db })
  return Object.freeze({
    identityAccess,
    resources: Object.freeze({
      delegatedRequests: identityAccess.delegatedRequests,
      taskExecutionResources: createTaskExecutionResourceBinding(
        db,
        composeTaskExecutionResourceBinding(taskExecutionResourceDependencies),
      ),
    }),
  })
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ⑤）：子任务铸造机的工作组资源面。
 * 与 `server.ts` 回退路同形——走**同一份** `composeWorkgroupLaunchResourceOperations`，
 * 别在测试里手拼 ACL 读法（批次二 ① 实撞过：手拼的那版认不出委派 actor，PG 上 500）。
 */
export function composeTestChildLaunchWorkgroup(db: ProviderNeutralDatabase) {
  return composeWorkgroupLaunchResourceOperations({
    db,
    integrity: composeDatabaseAgentResourceIntegrity({
      db,
      authorization: composeResourceCatalogFor({ db }).authorization,
    }).launch,
  })
}

/**
 * RFC-359 AC-1（第 12 刀）：单进程部署形态的那几格端口。
 *
 * 参与者合一之后，「谁在跑 / 怎么认领 / 怎么请它停」由装配方交；测试拓扑按**生产同形**取——
 * 与 `composeSqliteTaskExecutionProviderRuntime` 逐字相同的进程级单例认领 + 进程内注册表。
 */
export function singleProcessDeploymentPorts(db: DbClient) {
  const log = createLogger('task')
  return {
    taskDagCollaboration: createTaskDagCollaborationOperations(db),
    processConcurrencyScope: db,
    log,
    lifecycle: createDatabaseTaskDriverLifecyclePort({
      db,
      log,
      finalizeWorkspace: async (taskId: string) => {
        await finishClaimedWebhookWorkspacePrune(db, taskId)
      },
    }),
    activity: composeLegacyTaskActivityParticipant(),
    stop: composeLegacyTaskStopRegistry(),
  }
}

/** Shared direct-runtime helper: test schedulers use the same admitted owner. */
export function composeTaskExecutionTestRuntime(
  db: DbClient,
  options: Readonly<{ codeHostConnections?: CodeHostConnectionsService }> = {},
) {
  const identity = createTaskExecutionTestIdentity(db)
  const persistence = createTaskExecutionPersistence(db)
  return composeTaskExecutionRuntime({
    readModels: persistence.reads,
    participants: createTaskExecutionRuntimeParticipants({
      db,
      ...singleProcessDeploymentPorts(db),
      childLaunchWorkgroup: composeTestChildLaunchWorkgroup(db),
      identityAccess: identity.resources,
      memoryInjectionQueries: sqliteMemoryInjectionQueries(db),
      collaborationRuntime: createCollaborationRuntimeMechanics(db),
      persistence,
      workgroupTurns: composeWorkgroupTurnsOperations(
        db,
        composeWorkgroupHostLedgerParticipantFactory({
          collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
        }),
        createWorkgroupClarifyAskGate(db),
      ),
      runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
      runtimeRegistry: composeRuntimeRegistryOperations(db),
      dynamicWorkflow: {
        persistence: composeDynamicWorkflowPersistence(db),
        validationContext: { load: () => buildWorkflowValidationContext(db) },
      },
      ...(options.codeHostConnections === undefined
        ? {}
        : { codeHostConnections: options.codeHostConnections }),
      repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
    }),
  })
}

export interface RecordingSchedulerDriver {
  readonly driver: SchedulerDriverPort
  readonly kicks: TaskDriveRequest[]
  readonly cancellations: Array<Parameters<SchedulerDriverPort['cancelChild']>[0]>
  readonly resumptions: Array<Parameters<SchedulerDriverPort['resumeChild']>[0]>
  readonly activeChecks: string[]
}

export function createRecordingSchedulerDriver(
  active: (taskId: string) => boolean = () => false,
): RecordingSchedulerDriver {
  const kicks: TaskDriveRequest[] = []
  const cancellations: RecordingSchedulerDriver['cancellations'] = []
  const resumptions: RecordingSchedulerDriver['resumptions'] = []
  const activeChecks: string[] = []
  return {
    kicks,
    cancellations,
    resumptions,
    activeChecks,
    driver: {
      async drive(request) {
        kicks.push(request)
      },
      async cancelChild(input) {
        cancellations.push(input)
      },
      async resumeChild(input) {
        resumptions.push(input)
      },
      isTaskActive(taskId) {
        activeChecks.push(taskId)
        return active(taskId)
      },
    },
  }
}

export function createNoopSchedulerDriver(): SchedulerDriverPort {
  return {
    async drive() {},
    async cancelChild() {},
    async resumeChild() {},
    isTaskActive: () => false,
  }
}

export function createPoisonSchedulerDriver(
  label = 'unexpected scheduler driver call',
): SchedulerDriverPort {
  const fail = (): never => {
    throw new TypeError(label)
  }
  return {
    drive: async () => fail(),
    cancelChild: async () => fail(),
    resumeChild: async () => fail(),
    isTaskActive: fail,
  }
}

/**
 * RFC-331 test-only instance factory. Every direct task fixture chooses its
 * driver deliberately; production never imports this module and has no
 * implicit no-op/fallback path.
 */
export function createTaskExecutionTestTopology(input: {
  readonly db: DbClient
  readonly driver: 'real' | 'noop' | 'poison' | SchedulerDriverPort
}): SchedulerRuntimeTopology {
  const topology = composeTaskExecutionTestRuntime(input.db).topology
  const schedulerDriver =
    input.driver === 'real'
      ? topology.schedulerDriver
      : input.driver === 'noop'
        ? createNoopSchedulerDriver()
        : input.driver === 'poison'
          ? createPoisonSchedulerDriver()
          : input.driver
  return { ...topology, schedulerDriver }
}

/** Direct scheduler fixtures explicitly select the real instance topology. */
export function runTaskWithRealTestTopology(
  options: RunTaskOptions & { readonly db: DbClient },
): Promise<void> {
  const identity =
    options.identityAccess === undefined ? createTaskExecutionTestIdentity(options.db) : undefined
  const identityAccess = options.identityAccess ?? identity?.resources
  if (identityAccess === undefined) throw new Error('task-execution-test-identity-missing')
  const memoryInjectionQueries =
    options.memoryInjectionQueries ?? sqliteMemoryInjectionQueries(options.db)
  const persistence = options.persistence ?? createTaskExecutionPersistence(options.db)
  const runtimeSessionLeases =
    options.runtimeSessionLeases ?? createRuntimeSessionLeaseOperations(options.db)
  const runtimeRegistry = options.runtimeRegistry ?? composeRuntimeRegistryOperations(options.db)
  const repositoryPublicationTransport =
    options.repositoryPublicationTransport ?? createTestRepositoryPublicationTransport()
  const dynamicWorkflow =
    options.dynamicWorkflow ??
    Object.freeze({
      persistence: composeDynamicWorkflowPersistence(options.db),
      validationContext: { load: () => buildWorkflowValidationContext(options.db) },
    })
  const runtime = composeTaskExecutionRuntime({
    readModels: persistence.reads,
    participants: createTaskExecutionRuntimeParticipants({
      db: options.db,
      ...singleProcessDeploymentPorts(options.db),
      childLaunchWorkgroup: composeTestChildLaunchWorkgroup(options.db),
      identityAccess,
      memoryInjectionQueries,
      collaborationRuntime: createCollaborationRuntimeMechanics(options.db),
      persistence,
      workgroupTurns: composeWorkgroupTurnsOperations(
        options.db,
        composeWorkgroupHostLedgerParticipantFactory({
          collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
        }),
        createWorkgroupClarifyAskGate(options.db),
      ),
      runtimeSessionLeases,
      runtimeRegistry,
      dynamicWorkflow,
      repositoryPublicationTransport,
    }),
  })
  return driveTaskEngineApplication(
    {
      ...options,
      identityAccess,
      memoryInjectionQueries,
      persistence,
      runtimeSessionLeases,
      runtimeRegistry,
      taskDagCollaboration:
        options.taskDagCollaboration ?? createTaskDagCollaborationOperations(options.db),
      collaborationRuntime:
        options.collaborationRuntime ?? createCollaborationRuntimeMechanics(options.db),
      workgroupTurns:
        options.workgroupTurns ??
        composeWorkgroupTurnsOperations(
          options.db,
          composeWorkgroupHostLedgerParticipantFactory({
            collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
          }),
          createWorkgroupClarifyAskGate(options.db),
        ),
      childLaunch:
        options.childLaunch ??
        createChildExecutionLaunchOperations({
          db: options.db,
          persistence: createChildPersistence(options.db),
          lifecycle: createDatabaseTaskDriverLifecyclePort({
            db: options.db,
            log: createLogger('task'),
            finalizeWorkspace: async (taskId) => {
              await finishClaimedWebhookWorkspacePrune(options.db, taskId)
            },
          }),
          workgroup: composeTestChildLaunchWorkgroup(options.db),
        }),
      dynamicWorkflow,
      processConcurrencyScope: options.processConcurrencyScope ?? options.db,
      repositoryPublicationTransport,
    },
    runtime.topology,
    runtime,
  )
}
