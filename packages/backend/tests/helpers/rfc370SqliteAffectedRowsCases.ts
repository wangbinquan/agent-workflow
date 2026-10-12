// Locks RFC-370's CI repair: Bun 1.4.0 counts trigger/cascade side writes in
// Statement.run().changes. Both original DB factories must expose only the
// direct SQL row count without relaxing business affectedRows() predicates.

import { describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createInMemoryDb,
  instrumentSlowStatements,
  openDb,
  type DbClient,
} from '../../src/db/client'
import { affectedRows } from '../../src/platform/persistence/databaseTransaction'

const MIGRATIONS = resolve(import.meta.dir, '..', '..', 'db', 'migrations')
type Factory = 'snapshot' | 'file'

function withDatabase(
  factory: Factory,
  body: (db: DbClient, sqlite: Database) => void,
  observe?: (ms: number, sql?: string, cpuMs?: number) => void,
): void {
  const dir = factory === 'file' ? mkdtempSync(join(tmpdir(), 'rfc370-direct-rows-')) : undefined
  let sqlite: Database | undefined
  try {
    const db =
      factory === 'snapshot'
        ? createInMemoryDb(MIGRATIONS)
        : openDb({
            path: join(dir!, 'db.sqlite'),
            migrationsFolder: MIGRATIONS,
            slowQueryMs: 0,
            observeStatementMs: observe,
          })
    sqlite = (db as unknown as { $client: Database }).$client
    if (factory === 'snapshot' && observe !== undefined) {
      instrumentSlowStatements(sqlite, 0, undefined, observe)
    }
    sqlite.exec(`
      CREATE TABLE _rfc370_rows (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE _rfc370_children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES _rfc370_rows(id) ON DELETE CASCADE
      );
      CREATE TABLE _rfc370_effects (kind TEXT NOT NULL, parent_id INTEGER NOT NULL);
      CREATE TABLE _rfc370_observer (id INTEGER PRIMARY KEY);
      INSERT INTO _rfc370_rows VALUES (1, 0), (2, 0);
      INSERT INTO _rfc370_children VALUES (10, 1), (20, 1);
      CREATE TRIGGER _rfc370_insert AFTER INSERT ON _rfc370_rows BEGIN
        INSERT INTO _rfc370_effects VALUES ('insert', NEW.id);
      END;
      CREATE TRIGGER _rfc370_update AFTER UPDATE ON _rfc370_rows BEGIN
        INSERT INTO _rfc370_effects VALUES ('update', NEW.id);
      END;
      CREATE TRIGGER _rfc370_delete AFTER DELETE ON _rfc370_rows BEGIN
        INSERT INTO _rfc370_effects VALUES ('delete', OLD.id);
      END;
    `)
    body(db, sqlite)
  } finally {
    // Force close finalizes even caller-owned prepare() statements. Removal
    // retries native Windows handle release but still throws if it cannot finish.
    try {
      sqlite?.close(true)
    } finally {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  }
}

function effects(sqlite: Database): unknown[][] {
  return sqlite.query('SELECT kind, parent_id FROM _rfc370_effects ORDER BY rowid').values()
}

export function registerRfc370SqliteAffectedRowsCases(): void {
  for (const factory of ['snapshot', 'file'] as const) {
    describe(`RFC-370 SQLite direct affected rows — ${factory}`, () => {
      test('both prepare and query keep one direct update and its actual trigger effect', () => {
        withDatabase(factory, (_db, sqlite) => {
          for (const [index, method] of ['prepare', 'query'].entries()) {
            const statement = sqlite[method as 'prepare' | 'query'](
              'UPDATE _rfc370_rows SET value = ? WHERE id = 1',
            )
            expect(statement.run(index + 1).changes).toBe(1)
            expect(sqlite.query('SELECT value FROM _rfc370_rows WHERE id = 1').get()).toEqual({
              value: index + 1,
            })
            expect(effects(sqlite)).toEqual(Array.from({ length: index + 1 }, () => ['update', 1]))
          }
        })
      })

      test('both entry points retain two direct updates rather than clamping the count to one', () => {
        withDatabase(factory, (_db, sqlite) => {
          for (const method of ['prepare', 'query'] as const) {
            expect(sqlite[method]('UPDATE _rfc370_rows SET value = value + 1').run().changes).toBe(
              2,
            )
          }
          expect(sqlite.query('SELECT id, value FROM _rfc370_rows ORDER BY id').values()).toEqual([
            [1, 2],
            [2, 2],
          ])
          expect(effects(sqlite)).toEqual([
            ['update', 1],
            ['update', 2],
            ['update', 1],
            ['update', 2],
          ])
        })
      })

      test('a missing update returns zero and produces no trigger effect', () => {
        withDatabase(factory, (_db, sqlite) => {
          expect(
            sqlite.query('UPDATE _rfc370_rows SET value = 1 WHERE id = 99').run().changes,
          ).toBe(0)
          expect(effects(sqlite)).toEqual([])
          expect(sqlite.query('SELECT value FROM _rfc370_rows ORDER BY id').values()).toEqual([
            [0],
            [0],
          ])
        })
      })

      test('SELECT and DDL after a successful multi-row write do not inherit its direct count', () => {
        withDatabase(factory, (_db, sqlite) => {
          expect(sqlite.query('UPDATE _rfc370_rows SET value = 3').run().changes).toBe(2)
          expect(sqlite.query('SELECT * FROM _rfc370_rows').run().changes).toBe(0)
          expect(sqlite.prepare('CREATE TABLE _rfc370_ddl (id INTEGER)').run().changes).toBe(0)
          expect(effects(sqlite)).toEqual([
            ['update', 1],
            ['update', 2],
          ])
        })
      })

      test('insert preserves the original lastInsertRowid and its bigint mode', () => {
        withDatabase(factory, (_db, sqlite) => {
          const first = sqlite.query('INSERT INTO _rfc370_rows VALUES (3, 30)').run()
          expect(first).toEqual({ changes: 1, lastInsertRowid: 3 })
          const statement = sqlite.prepare('INSERT INTO _rfc370_rows VALUES (4, 40)')
          // Bun exposes this native method at runtime; 1.4.0's declarations omit it.
          ;(statement as unknown as { safeIntegers(enabled: boolean): boolean }).safeIntegers(true)
          expect(statement.run()).toEqual({ changes: 1, lastInsertRowid: 4n })
          expect(
            sqlite.query('SELECT id, value FROM _rfc370_rows WHERE id >= 3 ORDER BY id').values(),
          ).toEqual([
            [3, 30],
            [4, 40],
          ])
          expect(effects(sqlite)).toEqual([
            ['insert', 3],
            ['insert', 4],
          ])
        })
      })

      test('delete excludes the two real foreign-key cascades and trigger write', () => {
        withDatabase(factory, (_db, sqlite) => {
          expect(sqlite.query('DELETE FROM _rfc370_rows WHERE id = 1').run().changes).toBe(1)
          expect(sqlite.query('SELECT id FROM _rfc370_rows').values()).toEqual([[2]])
          expect(sqlite.query('SELECT id FROM _rfc370_children').values()).toEqual([])
          expect(effects(sqlite)).toEqual([['delete', 1]])
        })
      })

      test('the original transaction error rolls back both main and trigger rows', () => {
        withDatabase(factory, (_db, sqlite) => {
          const failure = new Error('rfc370-original-rollback')
          expect(() =>
            sqlite.transaction(() => {
              expect(sqlite.query('UPDATE _rfc370_rows SET value = 9').run().changes).toBe(2)
              expect(effects(sqlite)).toEqual([
                ['update', 1],
                ['update', 2],
              ])
              throw failure
            })(),
          ).toThrow(failure)
          expect(sqlite.inTransaction).toBe(false)
          expect(sqlite.query('SELECT value FROM _rfc370_rows ORDER BY id').values()).toEqual([
            [0],
            [0],
          ])
          expect(effects(sqlite)).toEqual([])
          expect(() => sqlite.query('INSERT INTO _rfc370_rows VALUES (1, 10)').run()).toThrow()
          expect(effects(sqlite)).toEqual([])
        })
      })

      test('cached reads, native getters, bound methods and finalize remain usable', () => {
        withDatabase(factory, (_db, sqlite) => {
          const query = 'SELECT id, value FROM _rfc370_rows WHERE id = ?'
          const statement = sqlite.query(query)
          if (factory === 'snapshot') expect(sqlite.query(query)).toBe(statement)
          expect(statement.columnNames).toEqual(['id', 'value'])
          expect(statement.paramsCount).toBe(1)
          const detachedGet = statement.get
          expect(detachedGet(1)).toEqual({ id: 1, value: 0 })
          expect(statement.all(2)).toEqual([{ id: 2, value: 0 }])
          expect(statement.values(1)).toEqual([[1, 0]])
          statement.finalize()
          expect(statement.isFinalized).toBe(true)
          expect(() => statement.get(1)).toThrow()
          const reopened = sqlite.query(query)
          expect(reopened.isFinalized).toBe(false)
          expect(reopened.get(2)).toEqual({ id: 2, value: 0 })
        })
      })

      test('a caller-finalized counting probe is reacquired before the next successful write returns', () => {
        withDatabase(factory, (_db, sqlite) => {
          const probe = sqlite.query('SELECT changes() AS changes')
          probe.finalize()
          expect(probe.isFinalized).toBe(true)
          expect(
            sqlite.prepare('UPDATE _rfc370_rows SET value = 11 WHERE id = 1').run().changes,
          ).toBe(1)
          expect(sqlite.query('SELECT id, value FROM _rfc370_rows ORDER BY id').values()).toEqual([
            [1, 11],
            [2, 0],
          ])
          expect(effects(sqlite)).toEqual([['update', 1]])
        })
      })

      test('clearing the native query cache does not turn a committed update into an error', () => {
        withDatabase(factory, (_db, sqlite) => {
          const probe = sqlite.query('SELECT changes() AS changes')
          const update = sqlite.prepare('UPDATE _rfc370_rows SET value = 12')
          sqlite.clearQueryCache()
          expect(probe.isFinalized).toBe(true)
          expect(update.run().changes).toBe(2)
          expect(sqlite.query('SELECT id, value FROM _rfc370_rows ORDER BY id').values()).toEqual([
            [1, 12],
            [2, 12],
          ])
          expect(effects(sqlite)).toEqual([
            ['update', 1],
            ['update', 2],
          ])
        })
      })

      test('a caller enabling bigint values on the cached probe does not change the count type', () => {
        withDatabase(factory, (_db, sqlite) => {
          const probe = sqlite.query('SELECT changes() AS changes')
          ;(probe as unknown as { safeIntegers(enabled: boolean): boolean }).safeIntegers(true)
          const result = sqlite.prepare('UPDATE _rfc370_rows SET value = 13 WHERE id = 2').run()
          expect(result.changes).toBe(1)
          expect(typeof result.changes).toBe('number')
          expect(sqlite.query('SELECT id, value FROM _rfc370_rows ORDER BY id').values()).toEqual([
            [1, 0],
            [2, 13],
          ])
          expect(effects(sqlite)).toEqual([['update', 2]])
        })
      })

      test('Drizzle and the original affectedRows predicate see the direct count', () => {
        withDatabase(factory, (db, sqlite) => {
          expect(affectedRows(db.run(sql`UPDATE _rfc370_rows SET value = 1 WHERE id = 1`))).toBe(1)
          expect(affectedRows(db.run(sql`UPDATE _rfc370_rows SET value = 2`))).toBe(2)
          expect(affectedRows(db.run(sql`UPDATE _rfc370_rows SET value = 3 WHERE id = 99`))).toBe(0)
          expect(effects(sqlite)).toEqual([
            ['update', 1],
            ['update', 1],
            ['update', 2],
          ])
        })
      })

      test('capture precedes side-writing telemetry and the internal probe stays unobserved', () => {
        const update = 'UPDATE _rfc370_rows SET value = 7'
        const seen: string[] = []
        let connection: Database | undefined
        withDatabase(
          factory,
          (_db, sqlite) => {
            connection = sqlite
            seen.length = 0
            expect(sqlite.query(update).run().changes).toBe(2)
            expect(seen.filter((statement) => statement === update)).toHaveLength(1)
            expect(seen.some((statement) => /^SELECT changes\(\)/i.test(statement))).toBe(false)
            expect(sqlite.query('SELECT id FROM _rfc370_observer').values()).toEqual([[1]])
            expect(effects(sqlite)).toEqual([
              ['update', 1],
              ['update', 2],
            ])
          },
          (_ms, statement) => {
            if (statement !== undefined) seen.push(statement)
            if (statement === update) {
              connection!.query('INSERT INTO _rfc370_observer VALUES (1)').run()
            }
          },
        )
      })
    })
  }
}
