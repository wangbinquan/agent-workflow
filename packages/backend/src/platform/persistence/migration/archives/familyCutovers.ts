import type { ConversionRule } from '../conversion/rule'
import { rowBlock } from '../conversion/blockCodes'
import { checkSeedPresence, seedPresence } from '../conversion/generic/seedPresence'

const table = 'committed_event_family_cutovers'
/** RFC-626 §3.4 row 14: the decision recorded for a route the upgrade switched to dispatchable. */
export const FAMILY_CUTOVER_SWITCHED = 'v2-family-cutover-not-dispatchable-kept'
/** RFC-626 §3.4 row 14: `change_ref` of a mode switch the automatic upgrade made. */
export const AUTOMATIC_UPGRADE_CHANGE_REF = 'rfc626:automatic-upgrade'
/** The next epoch, or null when the stored one is not an integer the target can hold. */
function nextEpoch(epoch: unknown): number | bigint | null {
  if (typeof epoch === 'bigint') return epoch + 1n
  return typeof epoch === 'number' && Number.isSafeInteger(epoch) ? epoch + 1 : null
}
export const familyCutoversRule: ConversionRule = {
  ref: { id: 'history/family-cutovers', version: 1 },
  owner: 'platform/persistence/migration/archives',
  claims: [table],
  produces: [{ table }],
  lookups: [seedPresence.key],
  unit: { kind: 'source-chunk', table },
  convert(unit, ctx) {
    // RFC-626 §3.3: the cutover row of every event family is a seed of the target schema.
    checkSeedPresence(table, ctx)
    for (const row of unit.rows.get(table)!) {
      ctx.out.record(
        {
          kind: 'family-cutover-source',
          payload: {
            sourceGeneration: ctx.sourceGenerationId,
            sourceContract: ctx.preflight.contract!.digest,
            sourceKey: row.encodedKey,
            original: row.canonical,
          },
        },
        row,
      )
      const epoch = row.values.mode === 'dispatchable' ? null : nextEpoch(row.values.epoch)
      if (ctx.resolution === 'automatic' && epoch !== null) {
        // RFC-626 §3.4 row 14: the route is a seed of the target and cannot be set aside. It is
        // kept as one mode switch: delivery only takes events produced in the route's current
        // epoch (`deliveryPersistence.ts`), so events recorded under the old mode are not
        // delivered after the upgrade and new ones are.
        ctx.out.record(
          {
            kind: 'decision',
            code: FAMILY_CUTOVER_SWITCHED,
            payload: {
              automatic: 'kept',
              sourceTable: table,
              sourceKey: row.encodedKey,
              mode: row.values.mode as string | null,
              epoch: String(row.values.epoch),
              changeRef: row.values.change_ref as string | null,
              changedAt: typeof row.values.changed_at === 'number' ? row.values.changed_at : null,
            },
          },
          row,
        )
        ctx.out.row(
          table,
          {
            ...Object.fromEntries(
              Object.entries(row.values).filter(([column]) => column !== 'mode'),
            ),
            epoch,
            changed_at: ctx.planTime,
            change_ref: AUTOMATIC_UPGRADE_CHANGE_REF,
          },
          row,
        )
        continue
      }
      if (row.values.mode !== 'dispatchable') {
        ctx.out.block(
          rowBlock(
            'v2-family-cutover-not-dispatchable',
            row,
            { mode: row.values.mode as string | null },
            ['mode'],
          ),
        )
        continue
      }
      ctx.out.row(
        table,
        Object.fromEntries(Object.entries(row.values).filter(([column]) => column !== 'mode')),
        row,
      )
    }
  },
}
