import { expectDeploymentSelection } from './helpers/deploymentSelectionSource'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-370 A2: leaf archive selection must reach both real provider roots, boot
// recovery and HTTP. No daemon, worker or listener is started by this oracle.
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
const server = source('server.ts')
const owner = source('bootstrap/daemonHttpComposition.ts')
const provider = source('modules/task-execution/composition/providerRuntime.ts')
const bundle = source('bootstrap/daemonModules/taskExecution.ts')

test('daemon selected archive binding survives provider creation and re-composition', () => {
  const root = declaration(start, 'startCommand')
  const sessionInputs = descendants(
    root,
    (item) => ts.isVariableDeclaration(item) && item.name.getText(start) === 'sessionInput',
  ).filter(ts.isVariableDeclaration)
  expect(sessionInputs).toHaveLength(1)
  expectDeploymentSelection('taskArchive')
  const pgRoot = declaration(start, 'composeDaemonSession')
  const pgApplication = calls(pgRoot, start, 'composeDaemonApplication')
  expect(pgApplication).toHaveLength(1)
  expect(compact(pgApplication[0]!.arguments[0]!, start)).toContain(
    '...deploymentSelectionsOf(input),',
  )
  const sqlite = declaration(start, 'composeDaemonApplication')
  const runtime = calls(sqlite, start, 'composeDaemonTaskExecutionModules')
  expect(runtime).toHaveLength(1)
  expect(compact(runtime[0]!.arguments[0]!, start)).toContain('archive:input.taskArchive,')
  expect(compact(bundle, bundle)).toContain('archive:selection.archive,')
  const selected = calls(bundle, bundle, 'composeTaskExecutionProviderRuntime')
  expect(selected).toHaveLength(1)
  expect(compact(selected[0]!.arguments[0]!, bundle)).toContain('archive:selection.archive,')
  const http = calls(sqlite, start, 'composeProviderAppComposition')
  expect(http).toHaveLength(1)
  expect(compact(http[0]!.arguments[0]!, start)).toContain('taskExecution:taskExecutionModules,')
  expect(compact(owner, owner)).toContain('taskArchiveMaintenance:taskExecutionProvider.archive,')
  expect(calls(sqlite, start, 'taskExecutionProvider.archive.recover')).toHaveLength(1)
})

test('both provider aggregates use the selected binding with their original database client', () => {
  for (const name of ['composeTaskExecutionProviderRuntime']) {
    const root = declaration(provider, name)
    const archive = calls(root, provider, 'createDrizzleTaskArchiveMaintenanceCommand')
    expect(archive).toHaveLength(1)
    expect(archive[0]!.arguments.map((item) => compact(item, provider))).toEqual([
      'db',
      'dependencies.archiveCollaboration',
      'dependencies.archive',
    ])
  }
  const helper = declaration(provider, 'createTaskArchiveMaintenanceCommand')
  const archive = calls(helper, provider, 'createDrizzleTaskArchiveMaintenanceCommand')
  expect(archive).toHaveLength(1)
  expect(archive[0]!.arguments.map((item) => compact(item, provider))).toEqual([
    'db',
    'collaboration',
    'archive',
  ])
})

test('PostgreSQL boot and HTTP retain the same selected command', () => {
  const root = declaration(pg, 'composeDaemonApplication')
  const runtime = calls(root, pg, 'composeDaemonTaskExecutionModules')
  expect(runtime).toHaveLength(1)
  expect(compact(runtime[0]!.arguments[0]!, pg)).toContain('archive:input.taskArchive,')
  expect(compact(bundle, bundle)).toContain('archive:selection.archive,')
  const selected = calls(bundle, bundle, 'composeTaskExecutionProviderRuntime')
  expect(selected).toHaveLength(1)
  expect(compact(selected[0]!.arguments[0]!, bundle)).toContain('archive:selection.archive,')
  const http = calls(root, pg, 'composeProviderAppComposition')
  expect(http).toHaveLength(1)
  expect(compact(http[0]!.arguments[0]!, pg)).toContain('taskExecution:taskExecutionModules,')
  expect(calls(root, pg, 'taskExecutionProvider.archive.recover')).toHaveLength(1)
})

test('the shared HTTP archive uses the bundle command without rebuilding the selected content', () => {
  const mounts = calls(server, server, 'mountTaskArchiveRoutes')
  expect(mounts).toHaveLength(1)
  expect(compact(mounts[0]!.arguments[1]!, server)).toBe('input.taskExecution.archive')
  expect(owner.text).toContain('taskArchiveMaintenance: taskExecutionProvider.archive')
  expect(calls(server, server, 'createDrizzleTaskArchiveMaintenanceCommand')).toHaveLength(0)
})
