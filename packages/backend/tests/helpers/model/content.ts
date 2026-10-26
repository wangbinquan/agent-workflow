import type { ContentStore } from '@/platform/content/contentStore'
import { join } from 'node:path'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createContentStore,
  databaseContentPolicy,
  createLocalFileContentTransport,
} from '@/platform/content/infrastructure/contentStore'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
export function fixtureContentStore(db: PersistenceDb, appHome?: string) {
  return createContentStore({
    db,
    policy: databaseContentPolicy,
    ...(appHome === undefined
      ? {}
      : {
          transports: {
            'local-file': createLocalFileContentTransport(join(appHome, 'content'), appHome),
          },
        }),
  })
}
export function readReviewFixture(
  db: PersistenceDb,
  appHome: string,
  row: { id: string } | string,
  content?: ContentStore,
): Promise<string> {
  return new DatabaseCommittedReviewArtifactReader(
    db,
    createFileReviewArtifactContent(appHome),
    content ?? fixtureContentStore(db, appHome),
  ).read(typeof row === 'string' ? row : 'doc-content:' + row.id)
}
