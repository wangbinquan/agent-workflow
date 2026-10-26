import type { RowValidator } from '../rule'
import { canonicalValue } from '../migrationKey'

export const activeClaimValidators: readonly RowValidator[] = [
  'task_execution_owners',
  'runtime_session_leases',
  'development_mr_claims',
].map((table) => ({
  ref: { id: `generic/active-claims/${table}`, version: 1 },
  table,
  validate(row, ctx) {
    const active =
      table === 'task_execution_owners'
        ? row.values.state === 'claimed'
        : table === 'development_mr_claims'
          ? row.values.state === 'active'
          : row.values.lease_node_run_id !== null
    if (active)
      ctx.out.record({
        kind: 'source-metadata',
        table,
        payload: {
          kind: 'active-claim',
          sourceKey: row.encodedKey,
          sourcePhase: row.phase,
          values: Object.fromEntries(
            Object.entries(row.values).map(([key, value]) => [key, canonicalValue(value)]),
          ),
        },
      })
    return []
  },
}))
