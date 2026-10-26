import { canonicalSchemaJson } from '../../../schema/canonical'
import type { SourceTableDisposition } from '../../sourceTypes'
import type { ConversionRule } from '../rule'
import { rowBlock } from '../blockCodes'
import type { SourcePhase } from '../types'
import { genericIdentities, identityHighWaterRecord, identityMaxima } from './identityHighWater'

export function metadataRule(
  declaration: SourceTableDisposition,
  phase: SourcePhase,
): ConversionRule {
  const table = declaration.table
  return {
    ref: { id: `generic/metadata/${phase}/${table}`, version: 1 },
    owner: 'persistence-migration',
    claims: [table],
    sourcePhase: phase,
    produces: [],
    lookups: table === 'sqlite_sequence' ? [identityMaxima.key] : [],
    unit: { kind: 'raw-chunk', table },
    convert(unit, ctx) {
      for (const row of unit.rows.get(table) ?? []) {
        const evidence = {
          sourceTable: declaration.physicalTable,
          sourcePhase: phase,
          sourceKey: row.encodedKey,
          sourceVersion: ctx.sourceVersion,
          raw: canonicalSchemaJson(row.raw),
        }
        if (table === 'sqlite_sequence') {
          const name = row.values.name
          const seq = row.values.seq
          const identity =
            typeof name === 'string'
              ? ctx.target.tables.flatMap((definition) =>
                  Object.values(definition.columns)
                    .filter((column) => definition.id === name && column.codec === 'identity')
                    .map((column) => ({ table: definition.id, column: column.name })),
                )[0]
              : undefined
          const integer =
            typeof seq === 'bigint' || (typeof seq === 'number' && Number.isSafeInteger(seq))
          if (!integer) {
            ctx.out.block(rowBlock('v2-identity-sequence-invalid', row, evidence, ['seq']))
            continue
          }
          if (identity) {
            const maximum = genericIdentities.some((entry) => entry.table === identity.table)
              ? ctx.lookup(identityMaxima.key).require(identity.table).maximum
              : null
            ctx.out.record(
              identityHighWaterRecord(identity.table, identity.column, maximum, ctx, String(seq)),
              row,
            )
          }
          // Retired identity owners have no target allocator, but their sequence evidence survives.
          ctx.out.record({ kind: 'source-metadata', table, payload: evidence }, row)
        } else if (table === 'database_generations') {
          const id = row.values.generation_id ?? row.values.id
          if (typeof id !== 'string' || !id) {
            ctx.out.block(
              rowBlock('v2-source-generation-invalid', row, evidence, ['generation_id']),
            )
            continue
          }
          ctx.out.record({ kind: 'source-generation', generationId: id, evidence }, row)
        } else {
          ctx.out.record({ kind: 'source-journal', entries: evidence }, row)
        }
      }
    },
  }
}
