import type { OracleRunRow } from './rows'

/** The caller attests the comparison universe, independently of the columns it loaded. */
export type OracleSnapshotScope =
  | { readonly kind: 'task' }
  | { readonly kind: 'rows' }
  | {
      readonly kind: 'node'
      readonly taskId: string
      readonly nodeId: string
      readonly iteration?: number
    }

const scopes = new WeakMap<readonly OracleRunRow[], OracleSnapshotScope>()

export function bindOracleSnapshotScope(
  rows: readonly OracleRunRow[],
  scope: OracleSnapshotScope,
): void {
  if (scope.kind === 'node')
    for (const row of rows) {
      if (
        row.taskId !== scope.taskId ||
        row.nodeId !== scope.nodeId ||
        (scope.iteration !== undefined && row.iteration !== scope.iteration)
      )
        throw new Error('oracle-snapshot-scope-mismatch')
    }
  scopes.set(rows, scope)
}

export function requireSupersessionScope(row: OracleRunRow, rows: readonly OracleRunRow[]): void {
  const scope = scopes.get(rows)
  // Direct complete-row helpers retain their existing complete-task contract.
  if (scope === undefined || scope.kind === 'task') return
  // Rule (a) only needs every row of this node/iteration (across frames and shards).
  // Rule (b) follows the parent into another node: that needs the complete task.
  if (scope.kind === 'node' && row.parentNodeRunId === null) return
  throw new Error(`oracle-snapshot-incomplete-supersession:${row.id}`)
}

export function requireTaskLabelScope(rows: readonly OracleRunRow[], label: 'role' | 'slot'): void {
  const scope = scopes.get(rows)
  if (scope !== undefined && scope.kind !== 'task')
    throw new Error(`oracle-snapshot-incomplete-${label}`)
}

export const ORACLE_ROW_FIELDS = [
  'id',
  'taskId',
  'nodeId',
  'seq',
  'status',
  'retryIndex',
  'iteration',
  'parentNodeRunId',
  'containerRunId',
  'shardKey',
  'shardValueHash',
  'reviewIteration',
  'wgRound',
  'rerunCause',
  'wrapperProgressJson',
  'consumedUpstreamRunsJson',
  'childTaskId',
  'startedAt',
  'mergeState',
  'supersededByReview',
] as const satisfies readonly (keyof OracleRunRow)[]

// Missing-field getters are shared by all projections. Complete rows remain plain
// validated copies; no per-row accessors or second copy are needed.
const missingFields = Object.defineProperties(
  {},
  Object.fromEntries(
    ORACLE_ROW_FIELDS.map((field) => [
      field,
      {
        get(this: Partial<OracleRunRow>) {
          const id = Object.getOwnPropertyDescriptor(this, 'id')?.value ?? '?'
          throw new Error(`oracle-snapshot-field-missing:${id}:${field}`)
        },
      },
    ]),
  ),
)

/** A declared projection never invents NULL/zero facts. Missing facts throw when needed. */
export function bindOracleRow(input: Partial<OracleRunRow>, complete: boolean): OracleRunRow {
  const source = { ...input }
  if (complete) {
    for (const field of ORACLE_ROW_FIELDS)
      if (source[field] === undefined)
        throw new Error(`oracle-snapshot-field-missing:${source.id ?? '?'}:${field}`)
  } else {
    // Explicit undefined is just as unbound as an omitted column.
    for (const field of ORACLE_ROW_FIELDS) if (source[field] === undefined) delete source[field]
    Object.setPrototypeOf(source, missingFields)
  }
  return source as OracleRunRow
}
