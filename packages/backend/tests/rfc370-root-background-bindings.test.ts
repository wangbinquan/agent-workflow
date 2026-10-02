// RFC-370: the real daemon roots must bind the shared selected query and drain
// the same admitted backup/refresh instances. Leaf ACK behavior is covered by
// the purpose tests; this locks the wiring without starting a daemon or worker.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const source = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
const start = source('cli/start.ts')
const pg = source('cli/postgresqlDaemonApplication.ts')
const compact = (node: ts.Node, file: ts.SourceFile) => node.getText(file).replace(/\s/g, '')

function descendants(node: ts.Node, match: (item: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (item: ts.Node): void => {
    if (match(item)) found.push(item)
    ts.forEachChild(item, visit)
  }
  visit(node)
  return found
}
function calls(node: ts.Node, file: ts.SourceFile, name: string): ts.CallExpression[] {
  return descendants(
    node,
    (item) => ts.isCallExpression(item) && item.expression.getText(file) === name,
  ).filter(ts.isCallExpression)
}
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = file.statements.find(
    (item): item is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(item) && item.name?.text === name && item.body !== undefined,
  )
  if (found === undefined) throw new Error(`missing real root ${name}`)
  return found
}
function namedVariable(node: ts.Node, name: string): ts.VariableDeclaration {
  const found = descendants(
    node,
    (item) => ts.isVariableDeclaration(item) && item.name.getText(start) === name,
  ).filter(ts.isVariableDeclaration)
  expect(found).toHaveLength(1)
  return found[0]!
}
function method(node: ts.Node, name: string): ts.MethodDeclaration {
  const found = descendants(
    node,
    (item) => ts.isMethodDeclaration(item) && item.name.getText(start) === name,
  ).filter(ts.isMethodDeclaration)
  expect(found).toHaveLength(1)
  return found[0]!
}

for (const [name, query, notificationKey] of [
  [
    'composePostgresqlProviderSession',
    'input.configuration',
    'input.applicationConfiguration.notificationKey',
  ],
  ['composeSqliteProviderSession', 'configuration', 'applicationConfiguration.notificationKey'],
] as const) {
  describe(`RFC-370 ${name} background configuration binding`, () => {
    const root = declaration(start, name)
    test('maintenance and Task background select the same live query', () => {
      const maintenance = namedVariable(root, 'maintenanceConfiguration')
      expect(compact(maintenance.initializer!, start)).toBe(`await${query}.read()`)
      const create = calls(root, start, 'startMaintenanceService')
      expect(create).toHaveLength(1)
      expect(maintenance.pos).toBeLessThan(create[0]!.pos)
      expect(compact(create[0]!, start)).toContain('loadConfig:()=>maintenanceConfiguration,')
      expect(compact(create[0]!, start)).toContain(`configPath:${notificationKey},`)
      const bindings = calls(root, start, '_bindTaskExecutionProviderBackground')
      expect(bindings).toHaveLength(1)
      const dependencies = compact(bindings[0]!.arguments[1]!, start)
      expect(dependencies).toContain(
        query === 'configuration' ? 'configuration,' : 'configuration:input.configuration,',
      )
      expect(dependencies).not.toContain('loadConfig:')
      expect(dependencies).not.toContain('configPath:')
    })

    test('backup and refresh await settings before starting and drain their admitted work', () => {
      for (const [factory, error] of [
        ['backupRuntimeFactory', 'scheduled-backup-drain-before-stop'],
        ['submoduleRefreshRuntimeFactory', 'submodule-refresh-drain-before-stop'],
      ] as const) {
        const value = namedVariable(root, factory)
        const begin = method(value, 'start')
        expect(begin.modifiers?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword)).toBe(true)
        const drain = method(value, 'drain')
        const body = compact(drain.body!, start)
        expect(body).toContain(`if(!stopped)thrownewError('${error}')`)
        expect(body).toContain('awaitticker.awaitIdle()')
        expect(body.indexOf(error)).toBeLessThan(body.indexOf('awaitticker.awaitIdle()'))
        expect(compact(value, start)).not.toContain('loadConfig(')
      }
      const backup = namedVariable(root, 'backupRuntimeFactory')
      expect(compact(backup, start)).toContain(`constcurrent=await${query}.read()`)
      expect(compact(backup, start)).not.toContain('loadRetention:')
      expect(compact(backup, start)).toContain("pruneMode:'external'")
      const refresh = namedVariable(root, 'submoduleRefreshRuntimeFactory')
      const selected = calls(refresh, start, 'startConfiguredSubmoduleRefreshLoop')
      expect(selected).toHaveLength(1)
      expect(ts.isAwaitExpression(selected[0]!.parent)).toBe(true)
      expect(compact(selected[0]!.arguments[1]!, start)).toBe(query)
      expect(compact(refresh, start)).toContain('ticker.reconfigure().then(()=>undefined)')
      expect(compact(refresh, start)).toContain('unregister()')
      const listener = calls(refresh, start, 'registerConfigAppliedListener')
      expect(listener).toHaveLength(1)
      expect(compact(listener[0]!.arguments[0]!, start)).toBe(notificationKey)
    })

    test('idle timeout stays hot and batch retention is read at each provider start', () => {
      const idle = namedVariable(root, 'idleTimeoutRuntimeFactory')
      const run = method(idle, 'run')
      expect(compact(run, start)).toContain(`(await${query}.read()).taskIdleTimeout`)
      expect(compact(run, start)).not.toContain('loadConfig(')
      const batches = namedVariable(root, 'batchImportRuntimeFactory')
      const begin = method(batches, 'start')
      expect(begin.modifiers?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword)).toBe(true)
      expect(compact(begin, start)).toContain(`(await${query}.read()).repoBatchImportRetentionMs`)
      expect(compact(begin, start)).not.toContain('loadConfig(')
    })
  })
}

test('PostgreSQL queued Intent resume reads the current selected source', () => {
  const found = descendants(
    declaration(pg, 'composePostgresqlApplication'),
    (item) => ts.isMethodDeclaration(item) && item.name.getText(pg) === 'resumeIntentSessions',
  ).filter(ts.isMethodDeclaration)
  expect(found).toHaveLength(1)
  expect(compact(found[0]!, pg)).toContain('configSnapshot:awaitconfiguration.read()')
  expect(compact(found[0]!, pg)).not.toContain('loadConfig(')
})
