import type { ConversionRule } from '../conversion/rule'
import { rowBlock } from '../conversion/blockCodes'

const table = 'committed_event_family_cutovers'
export const familyCutoversRule: ConversionRule = {
  ref: { id: 'history/family-cutovers', version: 1 },
  owner: 'platform/persistence/migration/archives',
  claims: [table],
  produces: [{ table }],
  lookups: [],
  unit: { kind: 'source-chunk', table },
  convert(unit, ctx) {
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
