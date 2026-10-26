import { missionIds } from '../generic/references'
import { alignmentRule, blockDanglingReference, copyAlignedRow, danglingReference } from './common'

export const developmentMissionsRule = alignmentRule(
  'development_missions',
  [missionIds.key],
  (row, ctx) => {
    if (danglingReference(row, 'reopened_from_mission_id', missionIds.key, ctx))
      blockDanglingReference(row, 'reopened_from_mission_id', ctx)
    else copyAlignedRow(row, ctx)
  },
)
