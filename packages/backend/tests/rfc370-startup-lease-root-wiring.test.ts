import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const load = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )

function calls(source: ts.SourceFile, expression: string) {
  const result: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === expression)
      result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

test('the real startup root selects one lazy lease and encloses boot in its failure lifetime', () => {
  const start = load('cli/start.ts')
  const selected = calls(start, 'composeDaemonStartupLease')
  expect(selected).toHaveLength(1)
  const argument = selected[0]!.arguments[0]!
  expect(argument.getText(start)).toContain('selected: opts.startupLease')
  expect(argument.getText(start)).toContain('local: () =>')
  const lifetime = calls(start, 'runDaemonStartupWithLease')
  expect(lifetime).toHaveLength(1)
  expect(lifetime[0]!.arguments[0]!.getText(start)).toBe('lock')
  const boot = lifetime[0]!.arguments[1]!.getText(start)
  expect(boot).toContain("log.info('lock acquired', lock.diagnostics)")
  expect(boot).toContain('const daemonHost = selectDaemonHostLifecycle(')
  expect(boot).toContain('prepareDaemonDatabaseProviderForBoot(')
  expect(boot).toContain('await initial.session.resume(lifecycle)')
  expect(boot).toContain('await serveDaemon({')
  const releases = calls(start, 'lock.release')
  expect(releases).toHaveLength(4)
  for (const call of releases) expect(ts.isAwaitExpression(call.parent)).toBe(true)
  for (const native of [
    'acquireLock',
    'adoptCurrentProcessLock',
    'readControlFile',
    'requestShutdown',
  ]) {
    expect(calls(start, native)).toHaveLength(0)
  }
  expect(start.text).not.toContain('lock.pid')
  expect(start.text).not.toContain('lock.path')
})

test('provider recompose keeps the acquired lease and both boot roots wait for its proof', () => {
  const start = load('cli/start.ts')
  const pg = load('cli/postgresqlDaemonApplication.ts')
  const pgBinding = calls(start, 'composePostgresqlDaemonApplication')[0]!.arguments[0]!
  expect(pgBinding.getText(start)).toContain('daemonStartupLease: input.lock')
  expect(start.text).toContain('...sessionInput,')
  const sqlite = calls(start, 'readDaemonStartupRecoveryAuthority')
  expect(sqlite).toHaveLength(1)
  expect(sqlite[0]!.arguments.map((node) => node.getText(start))).toEqual([
    'lock',
    'DAEMON_GENERATION',
  ])
  expect(ts.isAwaitExpression(sqlite[0]!.parent)).toBe(true)
  const selected = calls(pg, 'readDaemonStartupRecoveryAuthority')
  expect(selected).toHaveLength(1)
  expect(selected[0]!.arguments.map((node) => node.getText(pg))).toEqual([
    'input.daemonStartupLease',
    'input.provider.runtime.generationId',
  ])
  expect(ts.isAwaitExpression(selected[0]!.parent)).toBe(true)
  expect(calls(start, 'createDaemonLockProof')).toHaveLength(0)
  expect(calls(start, 'createDaemonRecoveryAuthorityProof')).toHaveLength(1)
  expect(calls(pg, 'createDaemonRecoveryAuthorityProof')).toHaveLength(1)
})
