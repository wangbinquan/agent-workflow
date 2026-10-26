import { z } from 'zod'
import { legacyContentRef, type ContentRef } from '@/platform/content/contentRef'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { sha256Hex } from '@/util/hash'

export const storedObject = z.object({
  id: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
})
const reviewReceipt = z.strictObject({
  kind: z.literal('cs-review-object-v2'),
  operationId: z.string(),
  artifactKey: z.string(),
  stagedPath: z.string(),
  finalPath: z.string(),
  key: z.string(),
  object: storedObject,
})

export function hostedObjectRef(
  id: string,
  sha256: string,
  size: number,
  mediaType: string | null = null,
): ContentRef<string> {
  storedObject.parse({ id, sha256, size })
  return legacyContentRef('hosted-object-id', 'object', id, { sha256, size, mediaType })
}

export function hostedReviewReceipt(row: SourceRow): z.infer<typeof reviewReceipt> | null {
  const raw = row.values.receipt_json
  if (raw === null) return null
  if (typeof raw !== 'string') throw new Error('v2-review-receipt-invalid')
  const parsed: unknown = JSON.parse(raw)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('kind' in parsed) ||
    parsed.kind !== 'cs-review-object-v2'
  )
    return null
  const receipt = reviewReceipt.parse(parsed)
  if (
    receipt.operationId !== row.values.operation_id ||
    receipt.artifactKey !== row.values.artifact_key ||
    receipt.stagedPath !== row.values.staged_path ||
    receipt.finalPath !== row.values.final_path ||
    receipt.key !== `${receipt.operationId}/${sha256Hex(receipt.artifactKey)}` ||
    receipt.object.sha256 !== row.values.sha256 ||
    receipt.object.size !== row.values.byte_size
  )
    throw new Error('v2-review-receipt-mismatch')
  return receipt
}
