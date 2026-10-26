import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createContentBackupHorizon } from '../infrastructure/local/contentBackupHorizon'

export function composeContentBackupHorizon(db: PersistenceDb, appHome: string) {
  return createContentBackupHorizon(db, appHome)
}
