// RFC-555: the continuation logic lives in the designated integration adapter
// (`application/adapters/integration-adapter.ts`); this file only binds Mission persistence to the database.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { missionCodeHostEventContinuation } from '../application/adapters/integration-adapter'
import { createMissionPersistence } from './missionStore'

/** 两个 provider 同一份（RFC-359 W4-D10）。 */
export function createMissionCodeHostEventContinuation(
  db: PersistenceDb,
): ReturnType<typeof missionCodeHostEventContinuation> {
  return missionCodeHostEventContinuation(createMissionPersistence(db))
}
