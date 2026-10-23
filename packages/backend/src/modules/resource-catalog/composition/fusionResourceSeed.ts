import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createFusionResourceSeedParticipant } from '../infrastructure/fusionResourceSeed'

export function composeFusionResourceSeedParticipant() {
  return { bind: (db: PersistenceDb) => createFusionResourceSeedParticipant(db) }
}
