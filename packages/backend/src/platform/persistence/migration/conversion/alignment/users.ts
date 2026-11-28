import { userIds } from '../generic/references'
import {
  alignmentRule,
  copyAlignedRow,
  danglingReference,
  resolveDanglingReference,
} from './common'

export const usersRule = alignmentRule('users', [userIds.key], (row, ctx) => {
  if (danglingReference(row, 'created_by', userIds.key, ctx))
    resolveDanglingReference(row, 'created_by', ctx)
  else copyAlignedRow(row, ctx)
})
