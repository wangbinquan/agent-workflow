// RFC-395 I-b: business code uses the neutral builders and codec helpers; SQLite terminals stay at the provider boundary.
// RFC-629: the live full-backend `ts.Program` scan runs in `architecture/rfc629-shared-program-guards.test.ts`;
// this file retains the isolated negative/positive fixtures against the same `sqliteQueryFindings` detector.
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { sqliteQueryFindings } from '../helpers/rfc629SharedProgramRules'

export { sqliteQueryFindings }

function fixture(body: string): string[] {
  const path = '/native-query-fixture.ts'
  const source = ts.createSourceFile(
    path,
    `interface Query { then(): void; getSQL(): void; get(): void; all(): void; run(): void }; interface Db { select(): Query; insert(): void; all(): void; run(): void }; declare const db: Db; ${body}`,
    ts.ScriptTarget.Latest,
    true,
  )
  const host = ts.createCompilerHost({ noLib: true })
  host.getSourceFile = (file) => (file === path ? source : undefined)
  const program = ts.createProgram([path], { noLib: true }, host)
  return sqliteQueryFindings(source, program.getTypeChecker())
}

describe('RFC-395 I-b neutral query boundary', () => {
  test('negative controls preserve aliases and distinguish a Map or ordinary runner', () => {
    expect(
      fixture('db.select().get(); db.select().all(); db.select().run(); db.all(); db.run()'),
    ).toEqual([
      'SQLite query .get',
      'SQLite query .all',
      'SQLite query .run',
      'raw database .all',
      'raw database .run',
    ])
    expect(fixture("import { alias as renamed } from 'drizzle-orm/sqlite-core'")).toEqual([
      'sqlite-core import',
    ])
    expect(
      fixture(
        'const runner = { run() {} }; runner.run(); const map = { get() {} }; map.get(); await db.select()',
      ),
    ).toEqual([])
  })
})
