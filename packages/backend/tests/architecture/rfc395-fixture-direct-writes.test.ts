// RFC-395 II-a A1: target-model fixtures isolate the storage switch; historical writers form a shrinking, explicit ratchet.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ledger from '../fixtures/rfc395-direct-write-ledger.json'
import { directFixtureWrites } from '../helpers/model/directWrites'

const root = resolve(import.meta.dir, '..')
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : []
  })
}
describe('RFC-395 II-a A1 fixture write boundary', () => {
  test('no unlisted writer and no stale ledger entry', () => {
    const files = sources(root).filter(
      (file) => !relative(root, file).replaceAll('\\', '/').startsWith('helpers/model/'),
    )
    expect(files.length).toBeGreaterThan(2000)
    const writers = Object.fromEntries(
      files
        .map((file) => {
          const path = relative(root, file).replaceAll('\\', '/')
          return [path, directFixtureWrites(path, readFileSync(file, 'utf8'))] as const
        })
        .filter(([, findings]) => findings.length),
    )
    expect(Object.keys(writers).sort()).toEqual(Object.keys(ledger.files).sort())
    for (const reason of Object.values(ledger.files))
      expect(ledger.reasonCategories).toHaveProperty(reason)
  })
  test('negative controls cover chained writes, aliases, insertOne, raw SQL and variables', () => {
    const found = directFixtureWrites(
      'fixture.ts',
      `
      const { tasks: taskRows, nodeRuns } = tablesOf(db)
      const alias = taskRows
      await db.insert(alias).values([]).onConflictDoNothing()
      await insertOne(tx, nodeRuns, row)
      await db.update(taskRows).set(patch).where(predicate)
      const statement = 'INSERT INTO clarify_rounds (id) VALUES (1)'
      db.exec(statement)
      db.run(sql\`UPDATE AGENTS SET skills = '[]'\`)
    `,
    )
    expect(found.map((row) => [row.table, row.shape])).toEqual([
      ['tasks', 'insert'],
      ['nodeRuns', 'insert'],
      ['tasks', 'update'],
      ['clarifyRounds', 'raw-sql'],
      ['agents', 'raw-sql'],
    ])
    expect(
      directFixtureWrites(
        'fixture.ts',
        `const example = 'db.insert(tasks)'; expect(sqlText).toContain('INSERT INTO tasks'); await taskFixture(db, spec)`,
      ),
    ).toEqual([])
  })
})
