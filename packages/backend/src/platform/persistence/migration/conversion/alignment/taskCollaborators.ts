import { userIds } from '../generic/references'
import { alignmentRule, blockDanglingReference, copyAlignedRow, danglingReference } from './common'

export const taskCollaboratorsRule = alignmentRule(
  'task_collaborators',
  [userIds.key],
  (row, ctx) => {
    if (danglingReference(row, 'added_by', userIds.key, ctx))
      blockDanglingReference(row, 'added_by', ctx)
    else copyAlignedRow(row, ctx)
  },
)
