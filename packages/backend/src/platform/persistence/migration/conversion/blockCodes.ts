import type { ConversionBlock, JsonValue, SourceRow } from './types'

export const BLOCK_CODES = {
  sourceCodec: 'v2-source-codec',
  undecidedSourceCodec: 'v2-undecided-source-codec',
  sourceCensus: 'v2-source-census',
  sourceUnavailable: 'v2-source-unavailable',
  unclaimedTable: 'v2-unclaimed-table',
  unclassifiedRow: 'v2-unclassified-row',
  orphanGroup: 'v2-orphan-group',
  groupMemberBlocked: 'v2-group-member-blocked',
  missingDisposition: 'v2-missing-row-disposition',
  rowBlocked: 'v2-row-blocked',
  targetColumn: 'v2-target-column',
  targetCodec: 'v2-target-codec',
  targetNull: 'v2-target-null',
  targetCheck: 'v2-target-check',
  targetUnique: 'v2-target-unique',
  targetDocument: 'v2-target-document',
  unknownTaskStatus: 'v2-unknown-task-status',
  missingLookup: 'v2-missing-lookup',
} as const
export class ConversionContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ConversionContractError'
  }
}
export function rowBlock(
  code: string,
  row: SourceRow,
  detail: JsonValue,
  missingFields: readonly string[] = [],
): ConversionBlock {
  const id = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null
  return {
    code,
    scope: 'row',
    sourceTable: row.table,
    sourceKey: row.encodedKey,
    sourcePhase: row.phase,
    taskId: id(row.values.task_id) ?? (row.table === 'tasks' ? id(row.values.id) : null),
    runId: row.table === 'node_runs' ? id(row.values.id) : null,
    missingFields,
    detail,
  }
}
