import { sha256Hex } from '@/util/hash'
import type { HumanGateArtifactStore } from './ports/humanGateArtifactStore'

export const planReviewArtifact: HumanGateArtifactStore['planReviewArtifact'] = (input) => ({
  operationId: input.operationId,
  artifactKey: input.artifactKey,
  stagedPath: `runs/.human-gate-staging/${sha256Hex(input.operationId).slice(0, 24)}/${sha256Hex(input.artifactKey).slice(0, 24)}.md`,
  finalPath: input.finalPath,
  sha256: sha256Hex(Buffer.from(input.body, 'utf8')),
  byteSize: Buffer.byteLength(input.body, 'utf8'),
})
