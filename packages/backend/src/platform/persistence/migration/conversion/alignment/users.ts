import { userIds } from '../generic/references'
import { alignmentRule, blockDanglingReference, copyAlignedRow, danglingReference } from './common'

export const usersRule = alignmentRule('users', [userIds.key], (row, ctx) => {
  if (danglingReference(row, 'created_by', userIds.key, ctx))
    blockDanglingReference(row, 'created_by', ctx)
  else copyAlignedRow(row, ctx)
})
