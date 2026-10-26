import { canonicalSchemaJson } from '../../../schema/canonical'
import type { SourceTableDisposition } from '../../sourceTypes'
import type { ConversionRule } from '../rule'
import type { ArchivePayload, SourcePhase } from '../types'

export function archiveRule(
  declaration: SourceTableDisposition,
  phase: SourcePhase,
  kind: ArchivePayload['kind'],
): ConversionRule {
  const table = declaration.table
  return {
    ref: { id: `generic/archive/${phase}/${table}`, version: 1 },
    owner: 'persistence-migration',
    claims: [table],
    sourcePhase: phase,
    produces: [],
    lookups: [],
    unit: { kind: 'raw-chunk', table },
    convert(unit, ctx) {
      const rows = unit.rows.get(table) ?? []
      const archive = ctx.out.archive({
        kind,
        sourceTable: table,
        format: 'raw-chunk@1',
        bytes: Buffer.from(
          canonicalSchemaJson({
            version: 1,
            sourceVersion: ctx.sourceVersion,
            sourceGenerationId: ctx.sourceGenerationId,
            sourcePhase: phase,
            physicalTable: declaration.physicalTable,
            decision: declaration.reason,
            rows: rows.map((row) => row.raw!),
          }),
        ),
        rows: rows.length,
      })
      for (const row of rows)
        ctx.out.exception({
          sourceTable: table,
          sourceKey: row.encodedKey,
          sourcePhase: phase,
          class: 'archived',
          kind: 'archived',
          targets: [],
          archive,
          decision: {
            code: `v2-archive-${kind}`,
            detail: { reason: declaration.reason, physicalTable: declaration.physicalTable },
          },
        })
    },
  }
}

export function blockedTableRule(
  declaration: SourceTableDisposition,
  phase: SourcePhase,
): ConversionRule {
  const table = declaration.table
  return {
    ref: { id: `generic/blocked/${phase}/${table}`, version: 1 },
    owner: 'persistence-migration',
    claims: [table],
    sourcePhase: phase,
    produces: [],
    lookups: [],
    unit: { kind: 'raw-chunk', table },
    convert(_unit, ctx) {
      ctx.out.block({
        code: 'v2-unknown-table-without-decision',
        scope: 'table',
        sourceTable: table,
        sourcePhase: phase,
        sourceKey: null,
        taskId: null,
        runId: null,
        missingFields: [],
        detail: {
          physicalTable: declaration.physicalTable,
          rows: declaration.rows,
          reason: declaration.reason,
        },
      })
    },
  }
}
