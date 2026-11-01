import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { executePostgresqlReferenceStatements } from '@/platform/persistence/postgresql/referenceStatements'
import { frozenValues } from './rfc395V2/contentFixtures'
import { plainDumpChunks, rfc398Postgresql, pgQuote } from './rfc398Postgresql'
import { autoUpgradeFixture } from './rfc398AutoUpgrade'
import type { ReleasedPostgresqlSource } from '@/platform/persistence/migration/epoch1/releasedPostgresql'

/**
 * Rows a native epoch-1 PostgreSQL daemon writes at boot rather than through its schema plan
 * (RFC-341 committed-event family cutovers). Taken verbatim from the captured real v0.19.2
 * install so the synthetic source satisfies the same epoch-2 required seeds as production.
 */
const NATIVE_BOOT_TABLES = ['committed_event_family_cutovers'] as const
function nativeBootRows() {
  const dump = gunzipSync(
    readFileSync(
      join(
        import.meta.dirname,
        '../fixtures/release-upgrade/rfc349-finalize/v0.19.2/before/postgres.sql.gz',
      ),
    ),
  ).toString()
  return NATIVE_BOOT_TABLES.map((table) => {
    const block = plainDumpChunks(dump).find(
      (chunk) => chunk.kind === 'copy' && chunk.target.startsWith(`agent_workflow.${table} (`),
    )
    if (block?.kind !== 'copy' || !block.rows.length)
      throw new Error(`captured v0.19.2 install has no ${table} boot rows`)
    return block
  })
}

/** Real native epoch-1 PG source; every process reuses the same source URL environment. */
export async function postgresqlAutoUpgradeFixture(release?: ReleasedPostgresqlSource) {
  const pg = await rfc398Postgresql()
  try {
    const source = await pg.create()
    const history = (await loadFrozenEpoch1History()).postgresql
    const runtime = pg.runtime(source.database)
    const connection = await runtime.providerPool().reserve()
    try {
      await executePostgresqlReferenceStatements(
        connection,
        (release ?? history.head).plan.statements.map((s) => s.sql),
      )
    } finally {
      connection.release()
    }
    // A native epoch-1 install keeps exactly one row: every frozen version shares the RFC-349
    // baseline id, and the row carries the installed (head) contract and plan digests.
    const installed = release ?? history.head
    await source.sql.unsafe(
      'INSERT INTO agent_workflow_meta.schema_migrations (baseline_id,contract_digest,plan_digest,applied_at) VALUES ($1,$2,$3,$4)',
      [installed.plan.baselineId, installed.contract.digest, installed.plan.digest, 123],
    )
    for (const [table, overrides] of [
      [
        'users',
        { id: '__system__', username: '__system__', display_name: 'System', created_by: null },
      ],
      ['auth_login_policy', { id: 'global' }],
      [
        'employee_os_writer_state',
        {
          id: 'global',
          active_generation: 0,
          mode: 'pre-cutover',
          legacy_admissions_enabled: true,
          legacy_open_mission_count: 0,
        },
      ],
    ] as const) {
      const row = frozenValues(table, overrides)
      const columns = (release ?? history.head).contract.tables
        .find((t) => t.id === table)!
        .columns.map((c) => c.name)
      await source.sql.unsafe(
        `INSERT INTO agent_workflow.${pgQuote(table)} (${columns.map(pgQuote).join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
        columns.map((c) => row[c]),
      )
    }
    for (const block of nativeBootRows())
      if (
        installed.contract.tables.some((t) => block.target.startsWith(`agent_workflow.${t.id} (`))
      )
        // Untyped literals take the column type, exactly as the captured COPY text did.
        await source.sql.unsafe(
          `INSERT INTO ${block.target} VALUES ${block.rows
            .map(
              (row) =>
                `(${row.map((v) => (v === null ? 'NULL' : `'${v.replaceAll("'", "''")}'`)).join(',')})`,
            )
            .join(',')}`,
        )
    await source.sql.unsafe(
      'INSERT INTO agent_workflow.maintenance_state (key,value,updated_at) VALUES ($1,$2,$3)',
      ['rfc398-source', 'preserved', 123],
    )
    writeFileSync(
      join(pg.root, 'config.json'),
      JSON.stringify({
        database: { provider: 'postgresql', urlEnv: 'RFC398_URL' },
        defaultRuntime: 'opencode',
      }),
    )
    const f = await autoUpgradeFixture({ home: pg.root, env: { RFC398_URL: source.url } })
    const allocations = () => {
      const root = join(pg.root, 'database-migrations/auto-upgrade/allocations')
      return existsSync(root)
        ? readdirSync(root)
            .filter((name) => /^\d+\.json$/.test(name))
            .map(
              (name) =>
                JSON.parse(readFileSync(join(root, name), 'utf8')) as {
                  n: number
                  kind: string
                  database: string
                  sessionOperationId: string
                  runId: string
                  profileRef: string
                },
            )
        : []
    }
    return {
      ...f,
      pg,
      source,
      allocations,
      async close() {
        await f.close()
        for (const row of allocations()) pg.databases.add(row.database)
        await pg.close()
      },
    }
  } catch (error) {
    await pg.close()
    throw error
  }
}
