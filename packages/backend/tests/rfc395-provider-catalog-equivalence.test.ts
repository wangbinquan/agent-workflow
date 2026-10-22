// RFC-395 I-a: compare compiled DDL with migration replay in both provider lanes; enumerate every SQLite drift entry.
import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { buildLogicalSchemaContract, persistenceSchema } from '@/bootstrap/persistenceSchema'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { migratePostgresqlSchema } from '@/platform/persistence/postgresqlMigrator'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { compilePostgresqlPlan } from '@/platform/persistence/schema/postgresqlPlan'
import { describeEachProvider, resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
import { migrateSqlite } from '@/platform/persistence/sqliteMigrator'
import { sqliteManifest, manifestDifferences } from './helpers/rfc395SqliteManifest'
const ledger = JSON.parse(
  readFileSync(resolve(import.meta.dir, 'fixtures/rfc395-sqlite-drift.json'), 'utf8'),
) as { differences: ReturnType<typeof manifestDifferences> }
// Catalog identity covers both application and migration-metadata schemas,
// excluding database-local OIDs, sequence current values and migration receipt rows.
// Receipt table structure is compared; the two installation paths publish different step receipts.
// Physical column order, type, collation, nullability, defaults and identity flags are compared.
// The PostgreSQL lane must expose any history drift rather than normalize it away.
interface CatalogRow {
  readonly kind: string
  readonly relation: string
  readonly name: string
  readonly definition: string
}
async function catalog(db: SQL): Promise<CatalogRow[]> {
  const rows = await db.unsafe(`
    SELECT 'column' AS kind, n.nspname || '.' || c.relname AS relation, a.attname AS name,
      a.attnum::text || '|' || format_type(a.atttypid,a.atttypmod) || '|' || a.attnotnull::text || '|' || a.attidentity::text || '|' || a.attgenerated::text || '|' ||
      coalesce(pg_get_expr(d.adbin,d.adrelid),'') || '|' || coalesce(co.collname,'') AS definition
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE n.nspname IN ('agent_workflow','agent_workflow_meta') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint',n.nspname || '.' || c.relname,con.conname,pg_get_constraintdef(con.oid,true)
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('agent_workflow','agent_workflow_meta')
    UNION ALL
    SELECT 'index',schemaname || '.' || tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('agent_workflow','agent_workflow_meta')
    UNION ALL
    SELECT 'sequence',schemaname || '.' || sequencename,sequencename,
      data_type || '|' || start_value || '|' || min_value || '|' || max_value || '|' || increment_by || '|' || cycle
    FROM pg_sequences WHERE schemaname IN ('agent_workflow','agent_workflow_meta')
    UNION ALL
    SELECT 'function',n.nspname,p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('agent_workflow','agent_workflow_meta')
    UNION ALL
    SELECT 'trigger',n.nspname || '.' || c.relname,t.tgname,pg_get_triggerdef(t.oid,true)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('agent_workflow','agent_workflow_meta') AND NOT t.tgisinternal
    ORDER BY kind,relation,name,definition`)
  return Array.from(rows) as CatalogRow[]
}
describeEachProvider('RFC-395 I-a compiled and migration-replay catalog equivalence', (harness) => {
  test('every physical catalog difference is accounted for', async () => {
    if (harness.capabilities.provider === 'sqlite') {
      const compiled = new Database(':memory:')
      const replay = new Database(':memory:')
      try {
        for (const statement of compileSqlitePlan(persistenceSchema).statements)
          compiled.exec(statement.sql)
        replay.exec('PRAGMA foreign_keys = OFF')
        migrateSqlite(replay, { migrationsFolder: resolve(import.meta.dir, '../db/migrations') })
        const actual = sqliteManifest(compiled)
        const differences = manifestDifferences(sqliteManifest(replay), actual)
        expect(differences).toEqual(ledger.differences)
        expect(differences.filter((d) => d.kind === 'column-order')).toHaveLength(42)
        expect(
          differences.filter((d) => d.kind === 'foreignKeys').flatMap((d) => d.replay as unknown[]),
        ).toHaveLength(8)
        expect(
          differences
            .filter((d) => d.kind === 'protections')
            .flatMap((d) => d.replay as string[])
            .filter((s) => s.startsWith('TRIGGER ')),
        ).toHaveLength(7)
        expect(
          differences.filter((entry) => entry.table === 'tasks' && entry.kind === 'column:name'),
        ).toHaveLength(1)
        const partialFullUnique = differences.filter(
          (entry) =>
            entry.kind === 'uniqueRepresentations' &&
            (entry.replay as { partial: number }[]).some((index) => index.partial === 1) &&
            (entry.declared as { partial: number }[]).some((index) => index.partial === 0),
        )
        expect(partialFullUnique.map((entry) => entry.table).sort()).toEqual([
          'code_work_observations',
          'intent_turn_events',
        ])
      } finally {
        compiled.close()
        replay.close()
      }

      return
    }
    const envName = resolvePostgresqlTestUrlEnv(process.env)
    if (!envName)
      throw new Error('PostgreSQL lane requires AW_TEST_POSTGRESQL_URL or RFC357_DATABASE_URL')
    const url = new URL(process.env[envName]!)
    const admin = new SQL(url.toString(), { max: 1 })
    const names = ['plan', 'history'].map(
      (suffix) => `rfc395_${randomUUID().replaceAll('-', '')}_${suffix}`,
    )
    const databases: SQL[] = []
    try {
      for (const name of names) {
        await admin.unsafe(`CREATE DATABASE "${name}"`)
        const child = new URL(url)
        child.pathname = `/${name}`
        databases.push(new SQL(child.toString(), { max: 1 }))
      }
      const compiled = databases[0]!
      const replay = databases[1]!
      for (const db of databases) await db.unsafe('SET search_path TO agent_workflow, public')
      for (const statement of compilePostgresqlPlan(persistenceSchema).statements)
        await compiled.unsafe(statement.sql)
      const headContract = buildLogicalSchemaContract()
      const history = await loadPostgresqlMigrationHistory({ headContract })
      const historyUrl = new URL(url)
      historyUrl.pathname = `/${names[1]!}`
      const runtime = createPostgresqlDatabaseRuntime({
        generationId: 'dbg_rfc395_catalog',
        config: {
          provider: 'postgresql',
          urlEnv: 'RFC395_HISTORY_DATABASE_URL',
          poolMax: 2,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 60_000,
          idleTimeoutMs: 30_000,
        },
        env: { RFC395_HISTORY_DATABASE_URL: historyUrl.toString() },
      })
      try {
        // Published history installs the immutable root, then uses the production
        // upgrader. SQL artifacts are not an independent raw-replay protocol.
        await migratePostgresqlSchema({ headContract, runtime, plan: history.root.plan })
        await migratePostgresqlSchema({ headContract, runtime, history })
      } finally {
        await runtime.close()
      }
      const compiledCatalog = await catalog(compiled)
      // Guard against a vacuous match: every active table must exist in the compared catalog.
      expect(
        [
          ...new Set(
            compiledCatalog
              .filter((row) => row.kind === 'column' && row.relation.startsWith('agent_workflow.'))
              .map((row) => row.relation.slice('agent_workflow.'.length)),
          ),
        ].sort(),
      ).toEqual(
        headContract.tables
          .filter((table) => table.disposition !== 'ARCHIVE_THEN_OMIT')
          .map((table) => table.id)
          .sort(),
      )
      expect(compiledCatalog).toEqual(await catalog(replay))
    } finally {
      for (const db of databases) await db.close()
      for (const name of names) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await admin.close()
    }
  }, 180_000)
})
