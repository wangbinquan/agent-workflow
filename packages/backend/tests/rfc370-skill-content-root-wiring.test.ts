import { expectDeploymentSelection } from './helpers/deploymentSelectionSource'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-370 A2: locks real-root propagation of the complete skill store into
// editing, availability and restart recovery without starting a daemon.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    path === 'bootstrap/daemonStart.ts'
      ? readDaemonGraphSource()
      : readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8'),
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

const start = source('bootstrap/daemonStart.ts')
const pg = source('bootstrap/daemonApplication.ts')
const bundle = source('bootstrap/daemonModules/resourceCatalog.ts')

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
  expect(input).toContain(`skillContent:${receiver}.skillContent,`)
  expect(input).toContain(`skillContentRoot:${fallback},`)
}

test('daemon preserves the same complete skill content binding across provider sessions', () => {
  const root = declaration(start, 'startCommand')
  const inputs = descendants(
    root,
    (item) => ts.isVariableDeclaration(item) && item.name.getText(start) === 'sessionInput',
  ).filter(ts.isVariableDeclaration)
  expect(inputs).toHaveLength(1)
  expectDeploymentSelection('skillContent')
  const postgres = declaration(start, 'composeDaemonSession')
  const application = calls(postgres, start, 'composeDaemonApplication')
  expect(application).toHaveLength(1)
  expect(compact(application[0]!.arguments[0]!, start)).toContain(
    '...deploymentSelectionsOf(input),',
  )
  const sqlite = declaration(start, 'composeDaemonApplication')
  selectedCatalog(sqlite, start, 'composeDaemonResourceCatalogModules', 'input', 'input.appHome')
  const http = calls(sqlite, start, 'composeProviderAppComposition')
  expect(http).toHaveLength(1)
  expect(compact(http[0]!.arguments[0]!, start)).toContain(
    'resourceCatalog:resourceCatalogModules,',
  )
})

test('PostgreSQL HTTP and daemon boot choose the same store while retaining their database', () => {
  const root = declaration(pg, 'composeDaemonApplication')
  selectedCatalog(root, pg, 'composeDaemonResourceCatalogModules', 'input', 'input.appHome')
  expect(
    compact(calls(root, pg, 'composeDaemonResourceCatalogModules')[0]!.arguments[0]!, pg),
  ).toContain('db:input.db,')
})

test('RFC-380 shared bundle passes the complete selection once to editing and once to boot', () => {
  const root = declaration(bundle, 'composeDaemonResourceCatalogModules')
  for (const name of ['composeClassicCatalogs', 'composeSkillCatalogBoot']) {
    const selected = calls(root, bundle, name)
    expect(selected).toHaveLength(1)
    expect(compact(selected[0]!.arguments[0]!, bundle)).toContain(
      '...selectSkillContentDependencies(input.skillContent,input.skillContentRoot),',
    )
  }
})
