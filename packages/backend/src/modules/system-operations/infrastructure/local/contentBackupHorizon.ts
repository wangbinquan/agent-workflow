import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createHostedBackupReleaseHorizon } from '../crewstation/backupReleaseHorizon'
export function createContentBackupHorizon(db: PersistenceDb, appHome: string) {
  const hosted = createHostedBackupReleaseHorizon({ db })
  return {
    async protects(lifetime: { createdAt: number; releasedAt: number }) {
      if (await hosted.protects(lifetime)) return true
      const root = join(appHome, 'backups')
      if (!existsSync(root)) return false
      // Local archives have no immutable release window. A copied file's mtime is
      // not evidence of snapshot time; retain content until those archives expire.
      return readdirSync(root).some((name) => {
        const file = statSync(join(root, name))
        return file.isFile() && /\.(?:tar\.gz|tgz|sqlite)$/.test(name)
      })
    },
  }
}
