// RFC-528: the standalone profile's maintenance-worker part. A standalone worker has no effects descriptor, so it builds
// each family below over its own database client — the factories and arguments the worker graph used to fall back to.
// `bootstrap/standalone.ts` states the daemon's standalone selections; a worker thread does not load it.
import { join } from 'node:path'
import { createLocalRuntimeContent } from './contentRuntime'
import type { StandaloneMaintenanceWorkerEffects } from './maintenanceWorkerEffects'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
import { createFileTaskArchiveContent } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { composeLocalResourcePackageArtifactRecovery } from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import { createPluginGenerationFilesystemGcPort } from '@/modules/resource-catalog/composition/pluginGenerationGc'
import {
  composeLocalRepositoryPreparationEffects,
  composeLocalScratchWorkspaceEffects,
} from '@/modules/source-control/composition/repositoryPreparation'
import { createNodeWorkspaceMaintenanceFilesystem } from '@/modules/source-control/composition'
import { invalidateCallGraphIndex } from '@/modules/workspace-insight/composition'
import { composeLocalIntentArtifactContent } from '@/modules/intent/composition/apply'
import { composeLocalIntentScratch } from '@/modules/intent/composition/maintenance'

export const standaloneMaintenanceWorkerEffects: StandaloneMaintenanceWorkerEffects = Object.freeze(
  {
    contentStore: ({ db, appHome }) => createLocalRuntimeContent(db, appHome),
    taskArchive: () => ({ content: createFileTaskArchiveContent() }),
    resourcePackageRecovery: ({ db, appHome, log }, recoveryEffectsFactory) =>
      composeLocalResourcePackageArtifactRecovery({
        db,
        appHome,
        pluginsDir: join(appHome, 'plugins'),
        recoveryEffectsFactory,
        log,
      }),
    workspaceMaintenance: ({ db, appHome }) => {
      // The task ports are thin stores over the database client, as in the preparation the graph builds.
      const preparationInput = { taskPorts: composeSourceControlTaskPorts(db), db, appHome }
      return Object.freeze({
        scratch: composeLocalScratchWorkspaceEffects(preparationInput),
        preparation: composeLocalRepositoryPreparationEffects(preparationInput),
        filesystem: (isMaterializingTask: (taskId: string) => boolean) =>
          createNodeWorkspaceMaintenanceFilesystem({
            appHome,
            isMaterializingTask,
            invalidateWorkspacePath: invalidateCallGraphIndex,
          }),
      })
    },
    pluginGenerationGc: ({ appHome }) =>
      createPluginGenerationFilesystemGcPort(join(appHome, 'plugins')),
    intentScratch: ({ appHome }) => composeLocalIntentScratch({ appHome }),
    intentArtifactContent: ({ appHome }) =>
      composeLocalIntentArtifactContent({ appHome, pluginsDir: join(appHome, 'plugins') }),
  },
)
