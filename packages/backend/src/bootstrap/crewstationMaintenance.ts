import { PostgresqlDatabaseConfigSchema, type DatabaseConfig } from '@agent-workflow/shared'
import { composeCrewStationDatabaseBackups } from '@/modules/system-operations/composition/crewstationDatabaseBackups'
import { composeCrewStationObjectPublications } from '@/modules/system-operations/composition/crewstationObjectPublications'
import { z } from 'zod'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import {
  composeCrewStationReviewArtifacts,
  composeCrewStationReviewObjectSweep,
} from '@/modules/collaboration/composition/crewstationReviewArtifacts'
import {
  composeCrewStationIntentArtifacts,
  composeCrewStationIntentPluginRetention,
} from '@/modules/intent/composition/crewstationArtifacts'
import { composeCrewStationResourceArtifacts } from '@/modules/resource-catalog/composition/crewstationArtifacts'
import { composeCrewStationIntentScratchStore } from '@/modules/intent/composition/crewstationScratch'
import { composeCrewStationWorkspaceOwner } from '@/modules/source-control/composition/crewstationWorkspace'
import {
  HOSTED_TASK_CONTRACT_VERSION,
  composeCrewStationWorkerFence,
  readCrewStationEnvironment,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { composeCrewStationTaskArchive } from '@/modules/task-execution/composition/crewstationArchive'
import { composeCrewStationNodeEventArchive } from '@/modules/task-execution/composition/crewstationNodeEventArchive'
import { composeCrewStationTaskObjectSweep } from '@/modules/task-execution/composition/crewstationObjectSweep'
import { composeCrewStationIntentScratchRelease } from '@/modules/task-execution/composition/crewstationExecution'
import type {
  MaintenanceWorkerEffectsDescriptor,
  MaintenanceWorkerEffectsFactory,
} from '@/platform/background/maintenanceWorkerEffects'
import { createCrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { createCrewStationObjectStorage } from '@/platform/crewstation/objectStorage'
import { createCrewStationPlatformApi } from '@/platform/crewstation/platformApi'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { composeCrewStationDatabaseWriteBarrier } from '@/modules/system-operations/composition/crewstationDeployment'

const Configuration = z
  .object({
    version: z.literal(1),
    database: PostgresqlDatabaseConfigSchema,
    generationId: z.string().min(1),
    fence: z
      .object({
        epoch: z.number().int().positive(),
        leaseId: z.string().min(1),
        instanceId: z.string().min(1),
      })
      .strict(),
  })
  .strict()

/** Evaluated by the supervisor at each actual worker spawn, after main has
 * acquired execution authority. Only non-secret configuration crosses threads. */
declare const AW_COMPILED_BUILD: boolean | undefined

/** Symbolic name the hosted Worker entry registers (see maintenanceWorkerEntry.ts). */
export const CREWSTATION_MAINTENANCE_EFFECTS_MODULE = 'aw:crewstation-maintenance'

// Same rule as the platform entry: a compiled binary opens a separately
// bundled Worker by its relative entry name (scripts/build-binary.ts lists it).
const HOSTED_MAINTENANCE_WORKER_ENTRY =
  typeof AW_COMPILED_BUILD === 'boolean' && AW_COMPILED_BUILD
    ? './bootstrap/maintenanceWorkerEntry.ts'
    : new URL('./maintenanceWorkerEntry.ts', import.meta.url).href

export function composeCrewStationMaintenanceDescriptor(input: {
  readonly database: DatabaseConfig
  readonly generationId: string
  readonly fence: CrewStationMutationFence
}): MaintenanceWorkerEffectsDescriptor {
  return {
    moduleSpecifier: CREWSTATION_MAINTENANCE_EFFECTS_MODULE,
    exportName: 'createCrewStationMaintenanceEffects',
    workerEntry: HOSTED_MAINTENANCE_WORKER_ENTRY,
    capabilities: [
      'taskArchive',
      'resourcePackageRecovery',
      'pluginGenerationGc',
      'intentArtifactContent',
      'intentScratch',
      'workspaceMaintenance',
      'databaseWrites',
      'eventsArchive',
      'databaseBackups',
      'objectPublications',
    ],
    get configurationJson() {
      return JSON.stringify(
        Configuration.parse({
          version: 1,
          database: input.database,
          generationId: input.generationId,
          fence: input.fence.current(),
        }),
      )
    },
  }
}

export const createCrewStationMaintenanceEffects: MaintenanceWorkerEffectsFactory = async (
  context,
) => {
  const configuration = Configuration.parse(JSON.parse(context.configurationJson))
  const environment = readCrewStationEnvironment(process.env)
  if (!environment.objectsUrl || !environment.objectSpaceId)
    throw new Error('CS_OBJECTS_URL and CS_OBJECT_SPACE_ID are required for hosted maintenance')
  const runtime = createPostgresqlDatabaseRuntime({
    config: { ...configuration.database, poolMax: Math.min(2, configuration.database.poolMax) },
    generationId: configuration.generationId,
  })
  try {
    const writeBarrier = composeCrewStationDatabaseWriteBarrier()
    const fence = composeCrewStationWorkerFence(
      createPostgresqlDatabaseClient(runtime),
      configuration.fence,
    )
    const databaseWrites = {
      async assertHeld(tx: Parameters<CrewStationMutationFence['assertHeld']>[0]) {
        await writeBarrier.beforeWrite(tx)
        await fence.assertHeld(tx, configuration.fence)
      },
    }
    const db = createPostgresqlDatabaseClient(runtime, { beforeWrite: databaseWrites.assertHeld })
    const platform = createCrewStationPlatformApi({ baseUrl: environment.platformApiUrl })
    const api = createCrewStationBusinessExecution(platform)
    const objects = createCrewStationObjectStorage({ baseUrl: environment.objectsUrl, fence })
    const objectPublications = composeCrewStationObjectPublications({
      db,
      fence,
      objects,
      sealer: createSecretBoxFromKey(environment.secretKey),
    })
    const publications = objectPublications.publications
    const workspace = composeCrewStationWorkspaceOwner({
      db,
      api,
      fence,
      secretBox: createSecretBoxFromKey(environment.secretKey),
      installation: `${environment.project}/${environment.service}`,
      taskContractVersion: HOSTED_TASK_CONTRACT_VERSION,
    })
    const helper = workspace.commands
    const maintenanceExecution = composeCrewStationIntentScratchRelease({
      db,
      api,
      fence,
      helper,
      workspaces: workspace.workspaces,
    })
    const workspaceEffects = workspace.bind()
    const resources = composeCrewStationResourceArtifacts({
      db,
      fence,
      objects,
      publications,
      helper,
      reference: workspace.reference,
      openFile: workspace.openFile,
      retainedReferences: composeCrewStationIntentPluginRetention(db),
    })
    const reviews = composeCrewStationReviewArtifacts({ db, objects, publications })
    const eventsArchive = composeCrewStationNodeEventArchive({ db, objects, fence, publications })
    return {
      // RFC-370 v3 V6: the one hosted object recovery/GC job, with every owner sweep.
      objectPublications: objectPublications.maintenance([
        composeCrewStationTaskObjectSweep({ db, fence, publications }),
        composeCrewStationReviewObjectSweep({ db, publications }),
      ]),
      databaseBackups: composeCrewStationDatabaseBackups({
        db,
        runtime,
        fence,
        objects,
        publications,
        installation: `${environment.project}/${environment.service}`,
        objectSpaceId: environment.objectSpaceId,
        secretKey: environment.secretKey,
      }).maintenance,
      ...resources.maintenance,
      databaseWrites,
      eventsArchive,
      workspaceMaintenance: {
        filesystem: (isMaterializingTask) => ({
          ...workspaceEffects.workspaceMaintenanceFilesystem,
          isMaterializingTask,
        }),
        preparation: workspaceEffects.repositoryPreparationEffects,
        scratch: workspaceEffects.scratchWorkspaceEffects,
      },
      intentArtifactContent: composeCrewStationIntentArtifacts(resources.intent).artifactContent,
      intentScratch: composeCrewStationIntentScratchStore({
        db,
        remove: maintenanceExecution.removeIntentScratch,
      }),
      taskArchive: composeCrewStationTaskArchive({
        db,
        fence,
        objects,
        publications,
        helper,
        locate: workspace.locate,
        reference: workspace.reference,
        workspaces: workspace.workspaces,
        openFile: workspace.openFile,
        reviewFiles: reviews.archiveFiles,
        eventFiles: eventsArchive.files,
      }),
      dispose: () => runtime.close(),
    }
  } catch (error) {
    await runtime.close()
    throw error
  }
}
