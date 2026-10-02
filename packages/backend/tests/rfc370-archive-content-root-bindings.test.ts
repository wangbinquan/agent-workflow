// RFC-370 A2: leaf archive selection must reach both real provider roots, boot
// recovery and HTTP. No daemon, worker or listener is started by this oracle.
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
const provider = source('modules/task-execution/composition/providerRuntime.ts')

test('daemon selected archive binding survives provider creation and re-composition', () => {
  const root = declaration(start, 'startCommand')
  const sessionInputs = descendants(
    root,
    (item) => ts.isVariableDeclaration(item) && item.name.getText(start) === 'sessionInput',
  ).filter(ts.isVariableDeclaration)
  expect(sessionInputs).toHaveLength(1)
  expect(compact(sessionInputs[0]!, start)).toContain('taskArchive:opts.taskArchive,')
  const pgRoot = declaration(start, 'composePostgresqlProviderSession')
  const pgApplication = calls(pgRoot, start, 'composePostgresqlDaemonApplication')
  expect(pgApplication).toHaveLength(1)
  expect(compact(pgApplication[0]!.arguments[0]!, start)).toContain(
    'taskArchive:input.taskArchive,',
  )
  const sqlite = declaration(start, 'composeSqliteProviderSession')
  const runtime = calls(sqlite, start, 'composeSqliteTaskExecutionProviderRuntime')
  expect(runtime).toHaveLength(1)
  expect(compact(runtime[0]!.arguments[1]!, start)).toContain('archive:input.taskArchive,')
  const http = calls(sqlite, start, 'composeSqliteAppDeps')
  expect(http).toHaveLength(1)
  expect(compact(http[0]!.arguments[0]!, start)).toContain(
    'taskArchiveMaintenance:taskExecutionProvider.archive,',
  )
  expect(calls(sqlite, start, 'taskExecutionProvider.archive.recover')).toHaveLength(1)
})

test('both provider aggregates use the selected binding with their original database client', () => {
  for (const name of [
    'composeSqliteTaskExecutionProviderRuntime',
    'composePostgresqlTaskExecutionProviderRuntime',
  ]) {
    const root = declaration(provider, name)
    const archive = calls(root, provider, 'createDrizzleTaskArchiveMaintenanceCommand')
    expect(archive).toHaveLength(1)
    expect(archive[0]!.arguments.map((item) => compact(item, provider))).toEqual([
      'db',
      'dependencies.archive',
    ])
  }
  const helper = declaration(provider, 'createTaskArchiveMaintenanceCommand')
  const archive = calls(helper, provider, 'createDrizzleTaskArchiveMaintenanceCommand')
  expect(archive).toHaveLength(1)
  expect(archive[0]!.arguments.map((item) => compact(item, provider))).toEqual(['db', 'archive'])
})

test('PostgreSQL boot and HTTP retain the same selected command', () => {
  const root = declaration(pg, 'composePostgresqlApplication')
  const runtime = calls(root, pg, 'composePostgresqlTaskExecutionProviderRuntime')
  expect(runtime).toHaveLength(1)
  expect(compact(runtime[0]!.arguments[1]!, pg)).toContain('archive:input.taskArchive,')
  const mounts = descendants(
    root,
    (item) => ts.isVariableDeclaration(item) && item.name.getText(pg) === 'taskExecutionRoutes',
  ).filter(ts.isVariableDeclaration)
  expect(mounts).toHaveLength(1)
  expect(compact(mounts[0]!, pg)).toContain('taskArchiveMaintenance:taskExecutionProvider.archive,')
  expect(calls(root, pg, 'taskExecutionProvider.archive.recover')).toHaveLength(1)
})

test('SQLite HTTP prioritizes its daemon command and standalone composition selects content', () => {
  const mounts = calls(server, server, 'mountTaskArchiveRoutes')
  // One neutral provider mount plus one SQLite legacy mount.
  expect(mounts).toHaveLength(2)
  const legacy = mounts.filter((item) =>
    item.arguments[1]?.getText(server).includes('deps.taskArchiveMaintenance'),
  )
  expect(legacy).toHaveLength(1)
  expect(compact(legacy[0]!.arguments[1]!, server)).toContain(
    'taskArchiveMaintenance:deps.taskArchiveMaintenance??createDrizzleTaskArchiveMaintenanceCommand(deps.db,deps.taskArchive),',
  )
  const factories = calls(server, server, 'createDrizzleTaskArchiveMaintenanceCommand')
  expect(factories).toHaveLength(1)
})
