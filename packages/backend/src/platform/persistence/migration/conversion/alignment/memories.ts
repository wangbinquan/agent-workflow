import { memoryIds } from '../generic/references'
import { valuesByColumnName } from '../generic/preserved'
import { alignmentRule, copyAlignedRow, danglingReference, resolveAlignment } from './common'

export const memoriesRule = alignmentRule('memories', [memoryIds.key], (row, ctx) => {
  const dangling = ['supersedes_id', 'superseded_by_id'].filter((column) =>
    danglingReference(row, column, memoryIds.key, ctx),
  )
  if (!dangling.length) {
    copyAlignedRow(row, ctx)
    return
  }
  resolveAlignment(
    row,
    {
      ...valuesByColumnName(row, ctx),
      ...Object.fromEntries(dangling.map((column) => [column, null])),
    },
    'v2-memory-supersession-detached',
    {
      pointers: Object.fromEntries(
        dangling.map((column) => [column, row.values[column] as string]),
      ),
    },
    ctx,
  )
})
