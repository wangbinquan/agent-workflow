import { createFileReviewArtifactContent } from './local/fileReviewArtifactContent'
import { and, eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ContentStore } from '@/platform/content/contentStore'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  createContentHumanGateArtifactStore,
  readHumanGateArtifactContent,
} from './humanGateOperationJournal'
import type { ReviewArtifactSelection } from '../application/ports/reviewArtifactSelection'
export { createContentHumanGateArtifactStore } from './humanGateOperationJournal'
export function createContentReviewArtifacts(input: {
  db: PersistenceDb
  content: ContentStore
}): ReviewArtifactSelection {
  return {
    store: createContentHumanGateArtifactStore(input),
    content: {
      async read(reference) {
        const { collaborationGateArtifacts, collaborationGateOperations } = tablesOf(input.db)
        const rows = await input.db
          .select({ artifact: collaborationGateArtifacts })
          .from(collaborationGateArtifacts)
          .innerJoin(
            collaborationGateOperations,
            eq(collaborationGateOperations.id, collaborationGateArtifacts.operationId),
          )
          .where(and(eq(collaborationGateArtifacts.finalContentKey, reference)))
          .limit(1)
        if (!rows[0]) return null
        return {
          body: await readHumanGateArtifactContent(input.content, rows[0].artifact),
          label: reference,
        }
      },
    },
  }
}

/** Local history and repair documents retain their epoch-1 file locations. */
export function createLocalReviewArtifacts(input: {
  db: PersistenceDb
  content: ContentStore
  appHome: string
}): ReviewArtifactSelection {
  return {
    store: createContentHumanGateArtifactStore(input),
    content: createFileReviewArtifactContent(input.appHome),
  }
}
