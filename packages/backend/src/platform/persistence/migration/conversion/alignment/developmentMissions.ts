import { rowBlock } from '../blockCodes'
import { missionIds } from '../generic/references'
import { LEGACY_MISSION_UNFINISHED, legacyMissionUnfinished } from '../../archives/writerDrain'
import {
  alignmentRule,
  copyAlignedRow,
  danglingReference,
  resolveDanglingReference,
} from './common'

export const developmentMissionsRule = alignmentRule(
  'development_missions',
  [missionIds.key],
  (row, ctx) => {
    // RFC-626 §3.4 row 13: the new version admits no legacy mission and has no draining state,
    // so an unfinished one would never end; the automatic upgrade sets it aside, and its
    // dependent rows follow when the target is finalized. The writer-state record lists it
    // (`archives/writerDrain.ts`, same test).
    const unfinished = ctx.resolution === 'automatic' ? legacyMissionUnfinished(row.values) : null
    if (unfinished !== null) {
      ctx.out.block(
        rowBlock(
          LEGACY_MISSION_UNFINISHED,
          row,
          { terminalAt: unfinished, source: row.canonical },
          ['terminal_at'],
        ),
      )
      return
    }
    if (danglingReference(row, 'reopened_from_mission_id', missionIds.key, ctx))
      resolveDanglingReference(row, 'reopened_from_mission_id', ctx)
    else copyAlignedRow(row, ctx)
  },
)
