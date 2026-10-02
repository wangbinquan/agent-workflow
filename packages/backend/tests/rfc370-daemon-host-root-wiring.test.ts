// RFC-370 A1: the readiness writer and all actual HTTP compositions share one host query.
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
function find(node: ts.Node, match: (item: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (item: ts.Node): void => {
    if (match(item)) result.push(item)
    ts.forEachChild(item, visit)
  }
  visit(node)
  return result
}
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declarations = file.statements.filter(
    (item): item is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(item) && item.name?.text === name && item.body !== undefined,
  )
  expect(declarations).toHaveLength(1)
  return declarations[0]!
}
const compact = (node: ts.Node, file: ts.SourceFile) => node.getText(file).replace(/\s/g, '')
function calls(node: ts.Node, file: ts.SourceFile, expression: string): ts.CallExpression[] {
  return find(
    node,
    (item) => ts.isCallExpression(item) && item.expression.getText(file) === expression,
  ).filter(ts.isCallExpression)
}
function selected(node: ts.Node, file: ts.SourceFile, expression: string, property: string): void {
  const matches = calls(node, file, expression)
  expect(matches).toHaveLength(1)
  expect(compact(matches[0]!.arguments[0]!, file)).toContain(property)
}
const start = source('cli/start.ts')
const pg = source('cli/postgresqlDaemonApplication.ts')
const server = source('server.ts')

test('start selects the host once and passes the same object to serving, initial composition and recompose', () => {
  const root = declaration(start, 'startCommand')
  const factories = calls(root, start, 'selectDaemonHostLifecycle')
  expect(factories).toHaveLength(1)
  expect(compact(factories[0]!.arguments[0]!, start)).toBe('opts.daemonHost')
  const sessionInputs = find(
    root,
    (item) => ts.isVariableDeclaration(item) && item.name.getText(start) === 'sessionInput',
  ).filter(ts.isVariableDeclaration)
  expect(sessionInputs).toHaveLength(1)
  expect(compact(sessionInputs[0]!, start)).toContain('daemonRuntime:daemonHost,')
  const compositions = calls(root, start, 'composeDaemonProviderSession')
  expect(compositions).toHaveLength(2)
  for (const composition of compositions)
    expect(compact(composition.arguments[0]!, start)).toContain('...sessionInput,')
  selected(root, start, 'serveDaemon', 'daemonHost,')
  selected(
    declaration(start, 'composePostgresqlProviderSession'),
    start,
    'composePostgresqlDaemonApplication',
    'daemonRuntime:input.daemonRuntime,',
  )
  selected(
    declaration(start, 'composeSqliteProviderSession'),
    start,
    'composeSqliteAppDeps',
    'daemonRuntime:input.daemonRuntime,',
  )
})

test('both HTTP roots consume the host query rather than reading the info file in the route', () => {
  for (const [file, name, receiver] of [
    [pg, 'composePostgresqlApplication', 'input'],
    [server, 'composeSqliteApiRouteMounts', 'deps'],
  ] as const) {
    const selection = calls(declaration(file, name), file, 'selectDaemonRuntimeQueries')
    expect(selection).toHaveLength(1)
    expect(compact(selection[0]!.arguments[0]!, file)).toBe(`${receiver}.daemonRuntime`)
  }
  const route = source('routes/daemon.ts')
  const current = calls(declaration(route, 'mountDaemonRoutes'), route, 'deps.runtime.readCurrent')
  expect(current).toHaveLength(1)
  expect(ts.isAwaitExpression(current[0]!.parent)).toBe(true)
  expect(route.text).not.toContain("from '@/util/daemonInfo'")
})

test('the single listener invokes every selected lifecycle method on its original receiver', () => {
  const root = declaration(start, 'serveDaemon')
  for (const [method, count] of [
    ['subscribeShutdown', 1],
    ['publishReady', 1],
    ['withdrawReady', 2],
    ['announceReady', 1],
    ['terminate', 1],
  ] as const) {
    expect(calls(root, start, `input.daemonHost.${method}`)).toHaveLength(count)
  }
  expect(calls(root, start, 'Bun.serve')).toHaveLength(1)
  expect(calls(root, start, 'input.bootstrap.stop')).toHaveLength(1)
  expect(calls(root, start, 'input.lock.release')).toHaveLength(2)
})
