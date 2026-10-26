import { reviewStagedPath } from '@/platform/content/locations/review'
import { sha256Hex } from '@/util/hash'
import type { HumanGateArtifactStore } from './ports/humanGateArtifactStore'

export const planReviewArtifact: HumanGateArtifactStore['planReviewArtifact'] = (input) => ({
  operationId: input.operationId,
  artifactKey: input.artifactKey,
  stagedPath: reviewStagedPath(input.operationId, input.artifactKey),
  finalPath: input.finalPath,
  sha256: sha256Hex(Buffer.from(input.body, 'utf8')),
  byteSize: Buffer.byteLength(input.body, 'utf8'),
})
