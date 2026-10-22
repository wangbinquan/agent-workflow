// RFC-395 I-b: business code uses the neutral builders and codec helpers; SQLite terminals stay at the provider boundary.
import { describe, expect, test } from 'bun:test'
import { resolve, relative } from 'node:path'
import ts from 'typescript'

const backend = resolve(import.meta.dir, '../..')
function wiring(path: string): boolean {
  return (
    path.startsWith('platform/persistence/') ||
    path.startsWith('db/') ||
    path === 'bootstrap/persistenceSchema.ts' ||
    /\/infrastructure\/persistence\/schema\.ts$/.test(path)
  )
}
export function sqliteQueryFindings(source: ts.SourceFile, checker: ts.TypeChecker): string[] {
  const findings: string[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'drizzle-orm/sqlite-core'
    )
      findings.push('sqlite-core import')
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (['get', 'all', 'run', 'values'].includes(method)) {
        const receiver = checker.getTypeAtLocation(node.expression.expression)
        const has = (name: string) => checker.getPropertyOfType(receiver, name) !== undefined
        if (has('select') && has('insert')) findings.push(`raw database .${method}`)
        else if (method !== 'values' && has('then') && has('getSQL'))
          findings.push(`SQLite query .${method}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}
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
  test('no business query uses a dialect terminal or database-level raw execution', () => {
    const config = ts.readConfigFile(resolve(backend, 'tsconfig.json'), ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, backend)
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    const checker = program.getTypeChecker()
    const sources = program
      .getSourceFiles()
      .filter((file) => file.fileName.startsWith(resolve(backend, 'src') + '/'))
    expect(sources.length).toBeGreaterThan(1000)
    expect(
      sources.flatMap((source) => {
        const path = relative(resolve(backend, 'src'), source.fileName).replaceAll('\\', '/')
        return wiring(path)
          ? []
          : sqliteQueryFindings(source, checker).map((finding) => `${path}: ${finding}`)
      }),
    ).toEqual([])
  }, 60_000)
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
