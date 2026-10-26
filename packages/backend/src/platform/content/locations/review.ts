import { join } from 'node:path'
import { sha256Hex } from '@/util/hash'
import { legacyContentRef, type ContentMetadata, type ContentRef } from '../contentRef'

export function decodeReviewBody(
  path: string,
  metadata: Partial<ContentMetadata> = {},
): ContentRef<string> {
  return legacyContentRef('review-body', 'local-file', path, {
    mediaType: 'text/markdown',
    ...metadata,
  })
}
export function reviewBodyPath(input: {
  taskId: string
  reviewNodeId: string
  sourcePortName: string
  versionIndex: number
  itemIndex?: number | null
  operationId?: string
}): string {
  const round = input.operationId === undefined ? '' : `/round_${input.operationId}`
  const item = input.itemIndex == null ? '' : `/item_${input.itemIndex}`
  return `runs/${input.taskId}/review/${input.reviewNodeId}/${input.sourcePortName}${round}${item}/v${input.versionIndex}.md`
}
export function reviewStagedPath(operationId: string, artifactKey: string): string {
  return `runs/.human-gate-staging/${sha256Hex(operationId).slice(0, 24)}/${sha256Hex(artifactKey).slice(0, 24)}.md`
}
export function reviewAbsolutePath(appHome: string, reference: string): string {
  return join(appHome, ...decodeReviewBody(reference).location.value.split('/'))
}
export function reviewTask(reference: string): string | null {
  return /^runs\/([^/]+)\//.exec(reference)?.[1] ?? null
}

export { encodeLegacyContent as encodeLegacyReviewBody } from '../contentRef'
