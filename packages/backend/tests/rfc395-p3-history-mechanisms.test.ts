import { sqliteHistoryTransaction } from '@/platform/persistence/sqlite/historySession'
// RFC-395 P3-A: canonical history projection and native Statement identity regressions.
import { expect, test } from 'bun:test'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { createSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import { compileContract, registryFromContract } from '@/platform/persistence/schema/contract'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { projectLogicalSchemaContract } from '@/platform/persistence/schema/logicalContract'
import { guardSqliteGenerationWrites } from '@/platform/persistence/sqliteGenerationFence'

test('canonical JSON preserves logical column order and resolved unique NULL semantics', () => {
  const contract = compileContract(persistenceSchema)
  const serialized = JSON.parse(canonicalSchemaJson(contract)) as typeof contract
  expect(
    serialized.tables.some((table) =>
      Object.values(table.columns).some((column) => column.uniqueNulls !== undefined),
    ),
  ).toBe(true)
  expect(
    serialized.tables.some(
      (table) =>
        JSON.stringify(Object.values(table.columns).map((column) => column.name)) !==
        JSON.stringify('columnOrder' in table ? table.columnOrder : undefined),
    ),
  ).toBe(true)
  const projected = projectLogicalSchemaContract(registryFromContract(serialized))
  expect(projected).toEqual(projectLogicalSchemaContract(persistenceSchema))
})

test('the generation fence decorates the cached native Statement once and retains native getters and finalization', () => {
  const database = createSqliteBaseline({ generationId: 'p3-statement-identity' })
  try {
    const text = 'SELECT generation_id FROM aw_meta_generations'
    const native = database.query(text)
    const originalNativeHandle = native.native
    guardSqliteGenerationWrites(database, 'p3-statement-identity')
    expect(database.query(text)).toBe(native)
    const get = native.get
    expect(database.query(text)).toBe(native)
    expect(native.get).toBe(get)
    expect(native.native).toBe(originalNativeHandle)
    expect(native.columnNames).toEqual(['generation_id'])
    expect(get()).toEqual({ generation_id: 'p3-statement-identity' })
    expect([...native.iterate()]).toEqual([{ generation_id: 'p3-statement-identity' }])
    native.finalize()
    expect(Reflect.get(native, 'isFinalized')).toBe(true)
  } finally {
    database.close()
  }
})

test('history transactions restore caller FK and legacy rename settings after success and rollback', async () => {
  const database = createSqliteBaseline()
  try {
    for (const mode of [0, 1]) {
      database.exec(`PRAGMA legacy_alter_table = ${mode}`)
      await sqliteHistoryTransaction(database, async () => {
        expect(database.query('PRAGMA legacy_alter_table').get()).toEqual({ legacy_alter_table: 0 })
      })
      expect(database.query('PRAGMA legacy_alter_table').get()).toEqual({
        legacy_alter_table: mode,
      })
      await expect(
        sqliteHistoryTransaction(database, async () => {
          database.exec('CREATE TABLE history_rollback_probe (id INTEGER)')
          throw new Error('rollback-probe')
        }),
      ).rejects.toThrow('rollback-probe')
      expect(database.inTransaction).toBe(false)
      expect(database.query('PRAGMA legacy_alter_table').get()).toEqual({
        legacy_alter_table: mode,
      })
      expect(database.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      expect(
        database
          .query("SELECT name FROM sqlite_schema WHERE name = 'history_rollback_probe'")
          .all(),
      ).toEqual([])
    }
  } finally {
    database.close()
  }
})
