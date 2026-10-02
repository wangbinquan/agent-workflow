// The daemon selects one raw legacy source independently of parsed settings.
// Both provider compositions must retain that source through boot and cutover.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { runtimes } from '@/db/schema'
import {
  composeFileRuntimeLegacyConfiguration,
  initializeRuntimeRegistryBoot,
  type RuntimeLegacyConfigurationPort,
} from '@/modules/runtime-management/composition/runtimeRegistry'
import { describeEachProvider } from './helpers/eachProvider'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'

const start = ts.createSourceFile(
  'start.ts',
  readFileSync(resolve(import.meta.dir, '../src/cli/start.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
)

function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (current: ts.Node): void => {
    if (predicate(current)) found.push(current)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

function body(name: string): ts.Block {
  const declaration = start.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
  if (declaration?.body === undefined) throw new Error(`Missing root ${name}`)
  return declaration.body
}

const compact = (node: ts.Node): string => node.getText(start).replace(/\s/g, '')
const calls = (node: ts.Node, name: string): ts.CallExpression[] =>
  descendants(
    node,
    (candidate) => ts.isCallExpression(candidate) && compact(candidate.expression) === name,
  ).filter(ts.isCallExpression)

test('both daemon providers and target recomposition retain the selected raw source', () => {
  const root = body('startCommand')
  const selections = descendants(
    root,
    (node) =>
      ts.isVariableDeclaration(node) && node.name.getText(start) === 'runtimeLegacyConfiguration',
  ).filter(ts.isVariableDeclaration)
  expect(selections).toHaveLength(1)
  expect(compact(selections[0]!.initializer!)).toBe(
    'opts.runtimeLegacyConfiguration??composeFileRuntimeLegacyConfiguration(Paths.config)',
  )
  expect(calls(root, 'composeFileRuntimeLegacyConfiguration')).toHaveLength(1)
  const sessionInputs = descendants(
    root,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(start) === 'sessionInput',
  ).filter(ts.isVariableDeclaration)
  expect(sessionInputs).toHaveLength(1)
  expect(compact(sessionInputs[0]!.initializer!)).toContain(',runtimeLegacyConfiguration,')
  const providerSessions = calls(root, 'composeDaemonProviderSession')
  expect(providerSessions).toHaveLength(2)
  for (const session of providerSessions) {
    expect(compact(session.arguments[0]!)).toContain('...sessionInput,')
  }
  for (const [owner, expected] of [
    ['composePostgresqlProviderSession', 'legacyConfiguration:input.runtimeLegacyConfiguration'],
    ['composeSqliteProviderSession', 'legacyConfiguration:runtimeLegacyConfiguration'],
  ]) {
    const provider = body(owner!)
    expect(calls(provider, 'composeFileRuntimeLegacyConfiguration')).toHaveLength(0)
    const boots = calls(provider, 'initializeRuntimeRegistryBoot')
    expect(boots).toHaveLength(1)
    expect(compact(boots[0]!.arguments[0]!)).toContain(expected!)
  }
})

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describeEachProvider('RFC-370 selected runtime legacy configuration', (harness) => {
  test('raw ACK precedes the original guard and preserves its legacy keys', async () => {
    const registry = composeRuntimeRegistryOperations(harness.db)
    const entered = barrier()
    const release = barrier()
    const events: string[] = []
    const source = {
      async readText() {
        expect<unknown>(this).toBe(source)
        events.push('raw-enter')
        entered.resolve()
        await release.promise
        events.push('raw-ack')
        return JSON.stringify({ defaultModel: 'selected-legacy-model' })
      },
    } satisfies RuntimeLegacyConfigurationPort
    let settled = false
    const completion = initializeRuntimeRegistryBoot({
      operations: {
        async seedBuiltinRuntimes() {
          events.push('seed')
          await registry.seedBuiltinRuntimes()
        },
        async migrateConfigIntoBuiltins(config) {
          events.push('backfill')
          await registry.migrateConfigIntoBuiltins(config)
        },
        assertConfigDefaultsMigrated(configuration) {
          expect(configuration).toBe(source)
          events.push('guard')
          return registry.assertConfigDefaultsMigrated(configuration)
        },
      },
      config: { opencodePath: '/selected/legacy/opencode' },
      legacyConfiguration: source,
      onRecoverableFailure(error) {
        throw error
      },
    }).then(
      () => {
        settled = true
        return { status: 'done' as const }
      },
      (error: unknown) => {
        settled = true
        return { status: 'failed' as const, error }
      },
    )
    try {
      await Promise.race([
        entered.promise,
        completion.then(() => {
          throw new Error('Boot settled before the selected raw read')
        }),
      ])
      expect(settled).toBe(false)
      expect(events).toEqual(['seed', 'backfill', 'guard', 'raw-enter'])
      expect((await registry.getRuntime('opencode'))?.binaryPath).toBe('/selected/legacy/opencode')
      release.resolve()
      const result = await completion
      expect(result.status).toBe('failed')
      if (result.status !== 'failed') throw new Error('Missing original legacy-default guard')
      expect(String(result.error)).toContain('defaultModel')
      expect(String(result.error)).toContain('un-migrated generation defaults')
      expect(events).toEqual(['seed', 'backfill', 'guard', 'raw-enter', 'raw-ack'])
    } finally {
      release.resolve()
      await completion
    }
  })

  test('each boot reads the same live raw receiver and keeps stored profile decisions', async () => {
    const registry = composeRuntimeRegistryOperations(harness.db)
    class RawSource implements RuntimeLegacyConfigurationPort {
      current = '{}'
      reads = 0
      async readText() {
        expect<unknown>(this).toBe(source)
        this.reads += 1
        return this.current
      }
    }
    const source = new RawSource()
    const boot = () =>
      initializeRuntimeRegistryBoot({
        operations: registry,
        config: {},
        legacyConfiguration: source,
        onRecoverableFailure(error) {
          throw error
        },
      })
    await boot()
    expect(source.reads).toBe(1)
    source.current = JSON.stringify({ defaultClaudeModel: 'selected-claude-model' })
    await expect(boot()).rejects.toThrow(/defaultClaudeModel/)
    expect(source.reads).toBe(2)
    await harness.db
      .update(runtimes)
      .set({ model: 'selected-claude-model' })
      .where(eq(runtimes.name, 'claude-code'))
    await boot()
    expect(source.reads).toBe(3)
  })

  test('an unreadable selected raw source retains fresh-install handling without file fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aw-selected-legacy-'))
    const path = join(directory, 'config.json')
    writeFileSync(path, JSON.stringify({ defaultModel: 'file-only-legacy-model' }))
    const registry = composeRuntimeRegistryOperations(harness.db)
    let reads = 0
    const source = {
      async readText(): Promise<string> {
        expect<unknown>(this).toBe(source)
        reads += 1
        throw new Error('selected raw source unavailable')
      },
    } satisfies RuntimeLegacyConfigurationPort
    try {
      await registry.seedBuiltinRuntimes()
      await expect(
        registry.assertConfigDefaultsMigrated(composeFileRuntimeLegacyConfiguration(path)),
      ).rejects.toThrow(/defaultModel/)
      await initializeRuntimeRegistryBoot({
        operations: registry,
        config: {},
        legacyConfiguration: source,
        onRecoverableFailure(error) {
          throw error
        },
      })
      expect(reads).toBe(1)
      expect(readFileSync(path, 'utf8')).toBe(
        JSON.stringify({ defaultModel: 'file-only-legacy-model' }),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
