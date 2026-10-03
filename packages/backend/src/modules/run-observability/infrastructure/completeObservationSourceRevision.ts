import { createHash } from 'node:crypto'
import { completeWorkingTraversal } from '../application/completeWorkingTraversal'
import type { CompleteWorkingRows } from '../ports/completeWorkingRows'

/** Bind all original EOF and visibility receipts without materializing the original population. */
export async function completeObservationSourceRevision(input: {
  readonly rows: CompleteWorkingRows
  readonly namespace: string
  readonly taskSource: unknown
  readonly snapshotId: string
  readonly signal?: AbortSignal
}) {
  const digest = createHash('sha256').update(
    JSON.stringify([input.snapshotId, input.taskSource]) + '\n',
  )
  for await (const row of completeWorkingTraversal(input.rows, input.namespace, input.signal))
    digest.update(JSON.stringify([row.key, row.document]) + '\n')
  return digest.digest('hex')
}
