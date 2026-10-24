// RFC-395 II-b package O3: exercise archive mechanics through the injected Task-owned store.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createTaskNodeEventArchiveStore } from '@/modules/task-execution/composition'
import { archiveEventsWithStore } from '@/platform/persistence/sqlite/systemEventsArchive'

export function archiveEvents(
  db: PersistenceDb,
  ...args: Parameters<typeof archiveEventsWithStore> extends [unknown, ...infer Args] ? Args : never
) {
  return archiveEventsWithStore(createTaskNodeEventArchiveStore(db), ...args)
}
