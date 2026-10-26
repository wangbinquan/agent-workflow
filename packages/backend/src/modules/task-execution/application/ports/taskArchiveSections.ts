// RFC-395 II-b W0: T/N implement their archive sections; Q consumes. Dormant.
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type {
  TaskArchiveCollaborationSection,
  TaskArchiveNodeRunSection,
  TaskArchiveTaskSection,
} from '@/platform/contracts/taskArchive'

/** Q supplies the same snapshot transaction and complete tree to all three writers. */
export interface TaskArchiveTaskSectionReader {
  load(tx: PersistenceTx, taskIds: readonly string[]): Promise<TaskArchiveTaskSection>
}
export interface TaskArchiveNodeRunSectionReader {
  load(tx: PersistenceTx, taskIds: readonly string[]): Promise<TaskArchiveNodeRunSection>
}

/** The coordinator supplies its snapshot; bootstrap binds the collaboration owner. */
export interface TaskArchiveCollaborationSectionsPort {
  load(tx: PersistenceTx, taskIds: readonly string[]): Promise<TaskArchiveCollaborationSection>
}
