import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { admitDaemonIdentity, actorOfDirectAuthority } from '@/auth/session'
// RFC-382: compose the real provider task bundle with recorded scheduler delivery and real database participants.
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/ownerIdentityQueries'
import {
  composeRepositoryWorkspaceStore,
  createFileWorkspacePresenceQueries,
  createFileFusionWorkspaceEffects,
} from '@/modules/source-control/composition'
import { composeRunObservationCalls } from '@/modules/run-observability/composition/runObservation'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeMemoryInjectionQueriesFor } from '@/modules/memory/composition'
import {
  composeLocalTaskRunRootSelection,
  composeTaskWorkspaceExcludeProfilesFor,
} from '@/modules/task-execution/composition/localTaskRunSelection'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import { composeDaemonResourceCatalogModules } from '@/bootstrap/daemonModules/resourceCatalog'
import {
  composeDaemonTaskExecutionModules,
  type DaemonTaskExecutionInput,
} from '@/bootstrap/daemonModules/taskExecution'
import { DAEMON_TASK_EXECUTION_ADAPTERS } from '@/bootstrap/daemonModules/adapters'
import type {
  TaskDriveRequest,
  SchedulerDriverPort,
} from '@/modules/task-execution/public/commands'
import type { ProviderDatabaseHarness } from './eachProvider'
import { composeRuntimeRegistryOperations } from './runtimeRegistryComposition'
import { createSqliteMemoryDistillEnqueuer } from './memoryDistill'
import { createTestRepositoryPublicationTransport } from './taskExecutionTestTopology'

function unused<T>(name: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`RFC-382 unexpected outbound dependency: ${name}`)
      },
    },
  ) as T
}
export function taskBundleInput(
  harness: Pick<ProviderDatabaseHarness, 'db' | 'applicationBinding'>,
  appHome: string,
  mode: 'local-sync' | 'selected' = 'local-sync',
) {
  const db = harness.db
  const binding = harness.applicationBinding
  const adapters =
    binding.provider === 'sqlite'
      ? DAEMON_TASK_EXECUTION_ADAPTERS.sqlite({ db: binding.db })
      : DAEMON_TASK_EXECUTION_ADAPTERS.postgresql({ db: binding.db, runtime: binding.runtime })
  let config: Config = { ...DEFAULT_CONFIG }
  const configuration = composeTaskLaunchConfiguration(
    mode === 'local-sync'
      ? { kind: 'local-sync', queries: { read: () => config } }
      : { kind: 'selected', queries: { read: async () => config } },
  )
  const identityAccess = createIdentityAccessRuntime({ db })
  const runtimeRegistry = composeRuntimeRegistryOperations(db)
  const resourceCatalog = composeDaemonResourceCatalogModules({
    db,
    skillContentRoot: appHome,
    runtimeProfiles: { get: (name) => runtimeRegistry.getRuntime(name) },
    mcpRuntime: { prepareDelete: async () => {}, reconcileDurableIntents: async () => {} },
  })
  const nodeRunPrompts = composeNodeRunPromptOperations(undefined, join(appHome, 'runs'))
  const portArtifacts = composePortArtifactOperations(undefined, appHome)
  const driven: TaskDriveRequest[] = []
  const listeners = new Set<() => void>()
  const schedulerDriver: SchedulerDriverPort = {
    async drive(request) {
      driven.push(request)
      for (const notify of listeners) notify()
    },
    cancelChild: async () => {},
    resumeChild: async () => {},
    isTaskActive: () => false,
  }
  const distill = createSqliteMemoryDistillEnqueuer(db)
  const distillRequests: Parameters<typeof distill.enqueue>[0][] = []
  const input: DaemonTaskExecutionInput = {
    db,
    appHome,
    configPath: join(appHome, 'config.json'),
    adapters,
    taskLaunchConfiguration: configuration,
    core: {
      identityAccess,
      async daemonActor(errorCode = 'digital-employee-host-identity-not-admitted') {
        const identity = await admitDaemonIdentity(identityAccess)
        if (identity === null) throw new Error(errorCode)
        return actorOfDirectAuthority(identity)
      },
      runtimeRegistry,
      repositoryWorkspaceStore: composeRepositoryWorkspaceStore(db),
    },
    observation: {
      workspacePresence: createFileWorkspacePresenceQueries(),
      observationCalls: composeRunObservationCalls(db),
      runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
    },
    resources: {
      ...resourceCatalog,
      agentResourceIntegrity: resourceCatalog.agentResourceIntegrity,
      owners: composeOwnerIdentityQueries(db),
    },
    memory: {
      memoryInjectionQueries: composeMemoryInjectionQueriesFor(db),
      memoryOperations: {
        distillCommands: {
          async enqueue(request) {
            distillRequests.push(request)
            return distill.enqueue(request)
          },
        },
      },
    },
    repository: {
      codeHostConnections: unused('code-host'),
      repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
    },
    selection: {
      taskRunBinding: composeLocalTaskRunRootSelection({ nodeRunPrompts, portArtifacts }).drive,
      workspaceExcludeProfilesFor: composeTaskWorkspaceExcludeProfilesFor(),
      nodeRunPrompts,
      portArtifacts,
      fusionWorkspaces: createFileFusionWorkspaceEffects({ appHome }),
    },
    finalizeWorkspace: async () => {},
    testSeams: { schedulerDriver },
  }
  return {
    input,
    schedulerDriver,
    driven,
    distillRequests,
    identityAccess,
    resourceCatalog,
    update(value: Partial<Config>) {
      config = { ...config, ...value }
    },
    compose: () => composeDaemonTaskExecutionModules(input),
    async waitForDrive(count: number) {
      if (driven.length >= count) return
      await new Promise<void>((resolve) => {
        const notify = () => {
          if (driven.length >= count) {
            listeners.delete(notify)
            resolve()
          }
        }
        listeners.add(notify)
      })
    },
  }
}
export const emptyWorkflow = { $schema_version: 5, inputs: [], nodes: [], edges: [] } as const
export async function seedBundleTask(
  harness: ProviderDatabaseHarness,
  appHome: string,
  status: 'running' | 'pending' | 'interrupted' = 'running',
  intent = true,
) {
  const id = ulid(),
    workflowId = ulid(),
    intentId = ulid()
  const slot = JSON.stringify([
    { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: 1 },
  ])
  const { workflows, tasks, taskExecutionIntents } = tablesOf(harness.db)
  await insertOne(harness.db, workflows, {
    id: workflowId,
    name: workflowId,
    definition: JSON.stringify(emptyWorkflow),
    version: 1,
    schemaVersion: 5,
    visibility: 'public',
  })
  await insertOne(harness.db, tasks, {
    id,
    name: id,
    workflowId,
    workflowSnapshot: JSON.stringify(emptyWorkflow),
    workflowVersion: 1,
    repoPath: appHome,
    worktreePath: appHome,
    baseBranch: 'main',
    branch: id,
    status,
    errorSummary: status === 'interrupted' ? 'daemon-restart' : null,
    inputs: '{}',
    startedAt: Date.now() - 600_000,
    runningSince: status === 'running' ? Date.now() - 600_000 : null,
    executionLineageId: id,
    lineageSlotPathJson: slot,
    spaceKind: 'internal',
  })
  if (intent)
    await insertOne(harness.db, taskExecutionIntents, {
      id: intentId,
      taskId: id,
      kind: 'launch',
      state: 'pending',
      source: 'rest',
      requestHash: id,
      payloadJson: '{}',
      executionLineageId: id,
      continuationSlotKey: `${id}:root`,
      slotPathJson: slot,
      operationGeneration: 0,
      expectedTaskRevision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  return {
    taskId: id,
    intentId,
    workflowId,
    async row() {
      return (await harness.db.select().from(tasks).where(eq(tasks.id, id)))[0]!
    },
  }
}
