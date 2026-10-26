import type { HumanGateArtifactSnapshot } from '@/modules/collaboration/application/ports/humanGateOperationStore'
import type { HumanGateArtifactStore } from '@/modules/collaboration/application/ports/humanGateArtifactStore'
import { reviewStagedPath } from '@/platform/content/locations/review'
// Explicit converted-history fixture: files stay legacy, target rows retain their real refs.
import { and, eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRefColumns } from '@/platform/content/contentStore'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
import { FsHumanGateArtifactStore } from './fsHumanGateArtifactStore'
export function legacyReviewArtifacts(db: PersistenceDb, appHome: string): HumanGateArtifactStore {
  const files = new FsHumanGateArtifactStore(appHome)
  const physical = (artifact: HumanGateArtifactSnapshot) => ({
    ...artifact,
    stagedPath: reviewStagedPath(artifact.operationId, artifact.artifactKey),
  })
  return {
    planReviewArtifact: files.planReviewArtifact,
    async stageReviewArtifact(plan, body) {
      const receipt = files.stageReviewArtifact(plan, body)
      const final = contentRowColumns(
        legacyContentRef('review-body-path', 'local-file', plan.finalPath, {
          sha256: plan.sha256,
          size: plan.byteSize,
        }),
      )
      const staged = contentRefColumns.encode(
        legacyContentRef('review-body-path', 'local-file', plan.stagedPath, {
          sha256: plan.sha256,
          size: plan.byteSize,
        }),
      )
      const { collaborationGateArtifacts } = tablesOf(db)
      await db
        .update(collaborationGateArtifacts)
        .set({ ...final, stagedContentRefJson: staged.json, stagedInlineBytes: null })
        .where(
          and(
            eq(collaborationGateArtifacts.operationId, plan.operationId),
            eq(collaborationGateArtifacts.artifactKey, plan.artifactKey),
          ),
        )
      return receipt
    },
    finalizeReviewArtifact: (artifact) => files.finalizeReviewArtifact(physical(artifact)),
    cleanupReviewArtifact: (artifact) => files.cleanupReviewArtifact(physical(artifact)),
  }
}
