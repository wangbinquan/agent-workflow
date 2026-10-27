// RFC-395 T18 PGF: reference DDL batches retain the exact sequential catalog and rollback scope.
import { setDefaultTimeout, expect, test } from 'bun:test'
import type {
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { executePostgresqlReferenceStatements } from '@/platform/persistence/postgresql/referenceStatements'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { compileEpoch1PostgresqlCatalog } from '@/platform/persistence/migration/supportedSources'
import { collectEpoch1PostgresqlCatalog } from '@/platform/persistence/migration/sourceCatalog'
import { postgresqlHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { describeEachProvider, resolveTestProviders } from './helpers/eachProvider'
import { withR2TargetHarness } from './helpers/rfc395R2Harness'

// Slowest case took 4.65 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

test('reference compilation has bounded batches and preserves statement order and literal bytes', async () => {
  const statements = Array.from({ length: 257 }, (_, index) => `SELECT ${index}`)
  statements[0] = "SELECT 'quote', $$body$$, $aw_reference$nested$aw_reference$"
  const queries: string[] = []
  const connection: Pick<PostgresqlReservedConnection, 'unsafe'> = {
    unsafe(statement): SqlRows {
      queries.push(statement)
      return Object.assign(Promise.resolve([]), { values: async () => [] })
    },
  }
  await executePostgresqlReferenceStatements(connection, statements)
  expect(queries).toHaveLength(3)
  for (const [index, statement] of statements.entries())
    expect(queries[Math.floor(index / 128)]).toContain(statement)
  expect(queries[0]!.indexOf('SELECT 1')).toBeLessThan(queries[0]!.indexOf('SELECT 2'))
  const before = queries.length
  await executePostgresqlReferenceStatements(connection, [])
  expect(queries).toHaveLength(before)
})

describeEachProvider(
  'RFC-395 PostgreSQL reference batch parity',
  (harness) =>
    withR2TargetHarness(harness, (h) => {
      test('frozen head catalog equals the sequential compiler; a failed batch rolls back all earlier DDL', async () => {
        const connection = await h.pool.reserve()
        try {
          const version = (await loadFrozenEpoch1History()).postgresql.head
          const batched = await compileEpoch1PostgresqlCatalog(connection, version)
          await connection.unsafe('BEGIN')
          let sequential
          try {
            await connection.unsafe('SET LOCAL search_path TO agent_workflow, public')
            for (const statement of version.plan.statements) await connection.unsafe(statement.sql)
            sequential = await collectEpoch1PostgresqlCatalog(
              postgresqlHistoryConnection(connection),
            )
          } finally {
            await connection.unsafe('ROLLBACK')
          }
          expect(batched.catalog).toEqual(sequential)
          await connection.unsafe('BEGIN')
          try {
            await expect(
              executePostgresqlReferenceStatements(connection, [
                'CREATE SCHEMA agent_workflow',
                'CREATE TABLE agent_workflow.original (id text)',
                ...Array.from(
                  { length: 126 },
                  (_, index) => `INSERT INTO agent_workflow.original VALUES ('${index}')`,
                ),
                'CREATE TABLE agent_workflow.original (id text)',
              ]),
            ).rejects.toThrow()
          } finally {
            await connection.unsafe('ROLLBACK')
          }
          expect(
            await connection.unsafe(
              "SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_workflow','agent_workflow_meta')",
            ),
          ).toHaveLength(0)
        } finally {
          connection.release()
        }
      })
    }),
  { providers: resolveTestProviders(process.env).filter((provider) => provider === 'postgresql') },
)
