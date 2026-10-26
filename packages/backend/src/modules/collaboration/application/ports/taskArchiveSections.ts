// RFC-395 II-b W0: C implements the collaboration archive section; Q consumes. Dormant.
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { TaskArchiveCollaborationSection } from '@/platform/contracts/taskArchive'

/** Use Q's shared snapshot transaction; preserve occurrence/ordinal, independent
 * attributions and legacy_answers_json, even when answers and drafts are absent.
 */
export interface TaskArchiveCollaborationSectionReader {
  load(tx: PersistenceTx, taskIds: readonly string[]): Promise<TaskArchiveCollaborationSection>
}
