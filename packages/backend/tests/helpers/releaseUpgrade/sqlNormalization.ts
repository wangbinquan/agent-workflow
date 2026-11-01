// RFC-398 §7.4: ONLY values minted by a pending released SQL migration may be
// normalized. Seeded values (including timestamps/generations) remain exact.
// Rules cite packages/backend/db/migrations, whose bytes the builder replays.
import type { LogicalTableContract } from '@/platform/persistence/schema/contractTypes'
import type { CanonicalLogicalValue } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import type { BuiltRelease } from './build'
import { equal, invariant, type Row, type Snapshot } from './data'

export function normalizeSqlValue(
  built: BuiltRelease,
  table: string,
  expected: Row,
  column: string,
  value: unknown,
): unknown {
  const pending = (migration: number) => built.release.epoch1!.sqlite.length <= migration
  let kind: 'time' | 'hex32' | 'hex64' | undefined
  // 0018 inserts __system__; 0110 and 0192 install singleton policy/writer rows.
  if (
    (table === 'users' &&
      expected.id === '__system__' &&
      pending(18) &&
      ['created_at', 'updated_at'].includes(column)) ||
    (table === 'auth_login_policy' && pending(110) && column === 'updated_at') ||
    (table === 'employee_os_writer_state' && pending(192) && column === 'updated_at') ||
    // 0106 backfills runtime state from tasks, stamping the SQL execution time.
    (table === 'workgroup_task_state' && pending(106) && column === 'updated_at') ||
    // 0144 archives retired runtime fields with the SQL execution time.
    (table === 'rfc276_legacy_runtime_archive' && pending(144) && column === 'archived_at') ||
    // 0188 INSERT OR IGNORE stamps only NEW users:presence grants.
    (table === 'user_permission_grants' &&
      pending(188) &&
      column === 'granted_at' &&
      expected.permission === 'users:presence' &&
      !(built.before.get(table) ?? []).some(
        (r) => r.user_id === expected.user_id && r.permission === expected.permission,
      )) ||
    // 0129 revokes only previously unrevoked PATs; preexisting revocations stay exact.
    (table === 'user_pats' &&
      pending(129) &&
      column === 'revoked_at' &&
      (built.before.get(table) ?? []).some((r) => r.id === expected.id && r.revoked_at === null))
  )
    kind = 'time'
  // 0208 mints one 128-bit generation shared by the two connection projections,
  // and a 256-bit endpoint binding. All copied business fields remain exact.
  if (pending(208)) {
    if (
      ['code_host_connections', 'repository_transport_connections'].includes(table) &&
      column === 'connection_generation'
    )
      kind = 'hex32'
    if (table === 'repository_transport_connections' && column === 'endpoint_binding_digest')
      kind = 'hex64'
  }
  if (kind === 'time') {
    const ms = Number(value)
    invariant(
      (typeof value === 'number' || typeof value === 'bigint') &&
        Number.isSafeInteger(ms) &&
        ms % 1000 === 0 &&
        ms >= Math.floor(built.startedAt / 1000) * 1000 &&
        ms <= Date.now(),
      `S3 ${table}.${column}: released SQL timestamp outside this build/upgrade`,
    )
    return 0
  }
  if (kind) {
    const length = kind === 'hex32' ? 32 : 64
    invariant(
      typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value),
      `S3 ${table}.${column}: released SQL randomblob encoding`,
    )
    return '0'.repeat(length)
  }
  return value
}

export function normalizeSqlRow(built: BuiltRelease, table: string, expected: Row, row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      normalizeSqlValue(built, table, expected, column, value),
    ]),
  )
}

export function normalizeSqlLogicalValues(
  built: BuiltRelease,
  table: LogicalTableContract,
  expected: Row,
  values: readonly CanonicalLogicalValue[],
): unknown[] {
  return values.map((cell, i) => {
    const value =
      cell.type === 'integer' ? BigInt(cell.value) : cell.type === 'null' ? null : cell.value
    const normalized = normalizeSqlValue(built, table.id, expected, table.columns[i]!.name, value)
    return normalized === value ? cell : { ...cell, value: String(normalized) }
  })
}

/** 0208 copies the freshly minted connection generation into the transport row.
 * Normalizing random bytes must still preserve that independently known relation.
 */
export function checkSqlGeneratedRelationships(current: Snapshot, target: Snapshot): void {
  for (const source of current.get('repository_transport_connections') ?? []) {
    const connection = (current.get('code_host_connections') ?? []).find(
      (row) => row.provider === source.provider,
    )
    if (!connection || connection.connection_generation !== source.connection_generation) continue
    const values = ['code_host_connections', 'repository_transport_connections'].map((table) => {
      const rows = (target.get(table) ?? []).filter((row) => row.provider === source.provider)
      equal(rows.length, 1, `S3 ${table} generated connection identity`)
      return rows[0]!.connection_generation
    })
    equal(values[0], values[1], 'S3 released SQL shared connection generation')
  }
}
