// RFC-370 v3 V6 — assemble the hosted task archive content binding. Assembly
// only: archive sources and the index live in task-execution infrastructure.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedObjectPublications } from '@/modules/system-operations/public/participants'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  CrewStationStreamObjectStorage,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { createHostedTaskArchiveContent } from '../infrastructure/crewstation/taskArchiveContent'
import { createHostedTaskArchiveSources } from '../infrastructure/crewstation/taskArchiveSources'

export function composeCrewStationTaskArchive(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  readonly publications: HostedObjectPublications
  readonly helper: WorkspaceHelper
  readonly locate: (reference: string) => { taskId: string }
  readonly reference: (taskId: string, path: string) => string
  readonly workspaces: {
    find(taskId: string): Promise<unknown | null>
    abandon(taskId: string): Promise<void>
  }
  readonly openFile: (reference: string) => Promise<ReadableStream<Uint8Array>>
  readonly reviewFiles: (
    taskId: string,
  ) => Promise<readonly { reference: string; object: HostedStoredObject }[]>
  readonly eventFiles?: (
    taskId: string,
  ) => Promise<readonly { path: string; object: HostedStoredObject }[]>
}) {
  return createHostedTaskArchiveContent({
    ...input,
    sources: createHostedTaskArchiveSources(input),
  })
}
