import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import { guardSqliteGenerationWrites } from '@/platform/persistence/sqliteGenerationFence'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('AF-D1 first mutation and committed marker cache', (h) => {
  test('snapshot read has no generation mutation and serializable configuration precedes its fence', async () => {
    const recording = h.recordStatements()
    await h.session.snapshotRead(async (tx) => {
      expect(await rawRows(tx, sql`SELECT 1 AS one`)).toEqual([{ one: 1 }])
    })
    expect(recording.statements.some((row) => /first_write|generations/.test(row.sql))).toBeFalse()
    const offset = recording.statements.length
    await h.session.serializable(async (tx) => {
      const { authLoginPolicy } = tablesOf(tx)
      await tx.update(authLoginPolicy).set({ updatedAt: 123 })
    })
    recording.stop()
    if (h.applicationBinding.provider === 'postgresql') {
      const statements = recording.statements.slice(offset).map((row) => row.sql.toLowerCase())
      expect(
        statements.findIndex((s) => s.startsWith('set transaction isolation level serializable')),
      ).toBeLessThan(statements.findIndex((s) => s.includes('select generation_id')))
    }
  })
  test('a rolled-back first write does not poison the next commit or a new runtime cache', async () => {
    const { authLoginPolicy } = tablesOf(h.db)
    const failure = new Error('abort first write')
    await expect(
      h.session.transaction(async (tx) => {
        await tx.update(authLoginPolicy).set({ updatedAt: 123 })
        throw failure
      }),
    ).rejects.toBe(failure)
    const recording = h.recordStatements()
    await h.db.update(authLoginPolicy).set({ updatedAt: 124 })
    const committed = recording.statements.length
    await h.db.update(authLoginPolicy).set({ updatedAt: 125 })
    if (h.applicationBinding.provider === 'postgresql') {
      expect(
        recording.statements
          .slice(0, committed)
          .filter((s) => s.sql.startsWith('UPDATE "agent_workflow_meta"."first_write"')),
      ).toHaveLength(1)
      expect(
        recording.statements.slice(committed).some((s) => s.sql.includes('first_write')),
      ).toBeFalse()
      const freshRuntime = { ...h.applicationBinding.runtime }
      const db = createPostgresqlDatabaseClient(freshRuntime)
      const offset = recording.statements.length
      await db.update(tablesOf(db).authLoginPolicy).set({ updatedAt: 126 })
      expect(
        recording.statements
          .slice(offset)
          .filter((s) => s.sql.startsWith('SELECT first_live_write_at')),
      ).toHaveLength(1)
      expect(
        recording.statements
          .slice(offset)
          .some((s) => s.sql.startsWith('UPDATE "agent_workflow_meta"."first_write"')),
      ).toBeFalse()
    }
    recording.stop()
  })
  test('the native test fixture rejects a business mutation after retirement on both providers', async () => {
    const binding = h.applicationBinding
    const meta =
      binding.provider === 'sqlite' ? 'aw_meta_generations' : 'agent_workflow_meta.generations'
    await h.executeFixtureDdl(`UPDATE ${meta} SET state='retired' WHERE state='active'`)
    const { authLoginPolicy } = tablesOf(h.db)
    await expect(
      Promise.resolve().then(() => h.db.update(authLoginPolicy).set({ updatedAt: 100 })),
    ).rejects.toThrow()
  })
})

test('SQLite caches only a committed first write and still fences every mutation', () => {
  const db = createSqliteBaseline({ generationId: 'dbg_af1_sqlite_fence' })
  const queries: string[] = []
  const original = db.query.bind(db)
  db.query = ((statement: string) => {
    queries.push(statement)
    return original(statement)
  }) as typeof db.query
  guardSqliteGenerationWrites(db)
  const marker = () =>
    original('SELECT first_live_write_at FROM aw_meta_first_write').get() as {
      first_live_write_at: number | null
    }
  try {
    db.exec('BEGIN')
    db.exec('UPDATE auth_login_policy SET updated_at=1')
    db.exec('ROLLBACK')
    expect(marker().first_live_write_at).toBeNull()
    db.exec('UPDATE auth_login_policy SET updated_at=2')
    expect(marker().first_live_write_at).not.toBeNull()
    const offset = queries.length
    db.exec('UPDATE auth_login_policy SET updated_at=3')
    expect(queries.slice(offset).some((s) => s.includes('first_write'))).toBeFalse()
    expect(queries.slice(offset).some((s) => s.includes('aw_meta_generations'))).toBeTrue()
    original("UPDATE aw_meta_generations SET state='retired'").run()
    expect(() => db.exec('UPDATE auth_login_policy SET updated_at=4')).toThrow(
      'sqlite-generation-fence-rejected',
    )
  } finally {
    db.close()
  }
})
