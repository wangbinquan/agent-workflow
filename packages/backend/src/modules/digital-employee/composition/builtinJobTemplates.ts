import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createBuiltinEmployeeJobs } from '../application/builtinEmployeeJobs'
import { createDigitalEmployeeAuthoringPersistence } from '../infrastructure/authoringStore'

/** Code-owned default jobs use the same publish validation as authored jobs (RFC-505: the use case lives in application). */
export function composeBuiltinEmployeeJobs(
  db: PersistenceDb,
  publish: (input: { id: string; actorUserId: null }) => Promise<{ id: string; revision: number }>,
) {
  return createBuiltinEmployeeJobs({
    store: createDigitalEmployeeAuthoringPersistence(db),
    publish,
    now: () => Date.now(),
  })
}
