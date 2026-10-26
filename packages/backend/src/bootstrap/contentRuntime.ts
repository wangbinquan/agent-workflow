import { join } from 'node:path'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createContentStore,
  createLocalFileContentTransport,
  contentExclusive,
} from '@/platform/content/composition'
export function createLocalRuntimeContent(db: PersistenceDb, appHome: string) {
  return createContentStore({
    db,
    exclusive: contentExclusive(appHome),
    policy: { inlineMaxBytes: 64 * 1024, externalKind: 'local-file' },
    transports: {
      'local-file': createLocalFileContentTransport(join(appHome, 'content'), appHome),
    },
  })
}
