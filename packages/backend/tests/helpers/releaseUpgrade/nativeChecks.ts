// RFC-398 §7.4 E1/E2: only applied edges require receipts; values derive from edge seed expectations.
import { readSeed, SEEDS } from '../../../../../scripts/release-upgrade/lib/seed-ledger'
import { join } from 'node:path'
import { persistenceHistory } from '@/bootstrap/persistenceHead'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import type { BuiltRelease } from './build'
import { equal, invariant, sortedRows, type Row, type Snapshot } from './data'

export function checkNativeHistory(built: BuiltRelease, target: Snapshot): void {
  const installed = built.release.epoch2!.version
  const history = persistenceHistory()
  const applied = history.filter((v) => v.contract.version > installed)
  const receipts = target.get('aw_meta_schema_history') ?? []
  const expected = applied.map((v) => ({
    version: v.contract.version,
    contract_digest: v.contract.contract.digest,
    sqlite_plan_digest: v.sqlite.digest,
    postgresql_plan_digest: v.postgresql.digest,
  }))
  equal(
    receipts
      .filter((r) => Number(r.version) > installed)
      .map((r) =>
        Object.fromEntries(
          Object.keys(
            expected[0] ?? {
              version: 0,
              contract_digest: '',
              sqlite_plan_digest: '',
              postgresql_plan_digest: '',
            },
          ).map((k) => [k, r[k]]),
        ),
      )
      .sort((a, b) => Number(a.version) - Number(b.version)),
    expected,
    'E1 applied history receipts',
  )
  equal(
    Math.max(...receipts.map((r) => Number(r.version))),
    history.at(-1)!.contract.version,
    'E1 native history head',
  )
  const oldTransforms = new Set(
    (built.before.get('aw_meta_schema_transform_receipts') ?? []).map((r) => r.receipt_id),
  )
  equal(
    (target.get('aw_meta_schema_transform_receipts') ?? [])
      .filter((r) => !oldTransforms.has(r.receipt_id))
      .map((r) => ({ receipt_id: r.receipt_id, edge_digest: r.edge_digest }))
      .sort((a, b) => String(a.receipt_id).localeCompare(String(b.receipt_id))),
    applied
      .flatMap((v) =>
        v.contract.edge?.kind === 'data-transform'
          ? [
              {
                receipt_id: v.contract.edge.receiptId,
                edge_digest: digestSchemaContract(v.contract.edge),
              },
            ]
          : [],
      )
      .sort((a, b) => a.receipt_id.localeCompare(b.receipt_id)),
    'E1 data-transform receipts only',
  )
  const changed = new Map<string, Row[]>()
  for (const version of applied) {
    const seed = readSeed(
      join(SEEDS, 'epoch2', `${String(version.contract.version).padStart(4, '0')}.json`),
      2,
      `${String(version.contract.version).padStart(4, '0')}_${version.contract.slug}`,
    )
    const edge = version.contract.edge
    invariant(edge, 'native applied version has no edge')
    // Full table expectations are deliberately explicit. Do not infer transformed
    // values from the new SQL or from the candidate's output.
    const expectations = seed.historyExpectations
    invariant(
      expectations && expectations.length > 0,
      `E2 missing edge expectations for ${version.contract.version}`,
    )
    for (const expectation of expectations) changed.set(expectation.table, expectation.rows)
    if ('tableId' in edge)
      invariant(changed.has(edge.tableId), `E2 edge table omitted: ${edge.tableId}`)
  }
  for (const [table, rows] of built.before) {
    if (
      table.startsWith('aw_meta_') ||
      table === '__drizzle_migrations' ||
      table === 'sqlite_sequence'
    )
      continue
    equal(
      sortedRows(target.get(table) ?? []),
      sortedRows(changed.get(table) ?? rows),
      `E2 ${table}`,
    )
  }
  for (const [table, rows] of changed)
    if (!built.before.has(table))
      equal(sortedRows(target.get(table) ?? []), sortedRows(rows), `E2 new ${table}`)
  equal(target.get('aw_meta_migration_operations') ?? [], [], 'E2 no epoch conversion operations')
}
