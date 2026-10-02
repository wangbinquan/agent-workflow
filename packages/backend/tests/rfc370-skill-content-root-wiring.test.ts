// RFC-370 A2: locks real-root propagation of the complete skill store into
// editing, availability and restart recovery without starting a daemon.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
}
function descendants(node: ts.Node, match: (item: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = []
  function visit(item: ts.Node): void {
    if (match(item)) result.push(item)
    ts.forEachChild(item, visit)
  }
  visit(node)
  return result
}
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const result = file.statements.filter(
    (item): item is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(item) && item.name?.text === name && item.body !== undefined,
  )
  expect(result).toHaveLength(1)
  return result[0]!
}
function calls(node: ts.Node, file: ts.SourceFile, name: string): ts.CallExpression[] {
  return descendants(
    node,
    (item) => ts.isCallExpression(item) && item.expression.getText(file) === name,
  ).filter(ts.isCallExpression)
}
const compact = (node: ts.Node, file: ts.SourceFile): string =>
  node.getText(file).replace(/\s/g, '')

const start = source('cli/start.ts')
const pg = source('cli/postgresqlDaemonApplication.ts')
const server = source('server.ts')

function selectedCatalog(
  node: ts.Node,
  file: ts.SourceFile,
  name: string,
  receiver: string,
  fallback: string,
): void {
  const selected = calls(node, file, name)
  expect(selected).toHaveLength(1)
  const input = compact(selected[0]!.arguments[0]!, file)
  expect(input).toContain(
    `...selectSkillContentDependencies(${receiver}.skillContent,${fallback}),`,
  )
}

test('daemon preserves the same complete skill content binding across provider sessions', () => {
  const root = declaration(start, 'startCommand')
  const inputs = descendants(
    root,
    (item) => ts.isVariableDeclaration(item) && item.name.getText(start) === 'sessionInput',
  ).filter(ts.isVariableDeclaration)
  expect(inputs).toHaveLength(1)
  expect(compact(inputs[0]!, start)).toContain('skillContent:opts.skillContent,')
  const postgres = declaration(start, 'composePostgresqlProviderSession')
  const application = calls(postgres, start, 'composePostgresqlDaemonApplication')
  expect(application).toHaveLength(1)
  expect(compact(application[0]!.arguments[0]!, start)).toContain(
    'skillContent:input.skillContent,',
  )
  const sqlite = declaration(start, 'composeSqliteProviderSession')
  selectedCatalog(sqlite, start, 'composeClassicCatalogs', 'input', 'Paths.root')
  selectedCatalog(sqlite, start, 'composeSkillCatalogBoot', 'input', 'Paths.root')
  const http = calls(sqlite, start, 'composeSqliteAppDeps')
  expect(http).toHaveLength(1)
  expect(compact(http[0]!.arguments[0]!, start)).toContain('skillContent:input.skillContent,')
})

test('PostgreSQL HTTP and daemon boot choose the same store while retaining their database', () => {
  const root = declaration(pg, 'composePostgresqlApplication')
  for (const name of ['composeClassicCatalogs', 'composeSkillCatalogBoot']) {
    selectedCatalog(root, pg, name, 'input', 'input.appHome')
    expect(compact(calls(root, pg, name)[0]!.arguments[0]!, pg)).toContain('db:input.db,')
  }
})

test('SQLite standalone HTTP accepts the complete selected store', () => {
  const root = declaration(server, 'composeSqliteApplicationDeps')
  selectedCatalog(root, server, 'composeClassicCatalogs', 'effectiveDeps', 'Paths.root')
  expect(
    compact(calls(root, server, 'composeClassicCatalogs')[0]!.arguments[0]!, server),
  ).toContain('db:effectiveDeps.db,')
})
