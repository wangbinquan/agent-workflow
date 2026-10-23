import { legacyReviewStagedPath } from '@/platform/content/legacyReview'
import { sha256Hex } from '@/util/hash'
import type { HumanGateArtifactStore } from './ports/humanGateArtifactStore'

export const planReviewArtifact: HumanGateArtifactStore['planReviewArtifact'] = (input) => ({
  operationId: input.operationId,
  artifactKey: input.artifactKey,
  stagedPath: legacyReviewStagedPath(input.operationId, input.artifactKey),
  finalPath: input.finalPath,
  sha256: sha256Hex(Buffer.from(input.body, 'utf8')),
  byteSize: Buffer.byteLength(input.body, 'utf8'),
})
