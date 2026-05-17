// RFC-031 T9 — scheduler `prepareNodeRunInjection` extends the dependsOn
// closure resolver with a plugin union + DB hydrate step. This test pins the
// contract on the helper itself (not the full scheduler tick) so red here
// points squarely at the closure→plugin glue, not at fan-out timing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, getAgent } from '../src/services/agent'
import { createPlugin } from '../src/services/plugin'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { prepareNodeRunInjection } from '../src/services/scheduler'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.sh')

let pluginsDir = ''

async function seedAgent(
  db: DbClient,
  name: string,
  opts: { dependsOn?: string[]; plugins?: string[] } = {},
): Promise<void> {
  await createAgent(db, {
    name,
    description: '',
    outputs: [],
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: opts.dependsOn ?? [],
    mcp: [],
    plugins: opts.plugins ?? [],
    frontmatterExtra: {},
    bodyMd: '',
  })
}

describe('prepareNodeRunInjection — RFC-031 plugin union', () => {
  let db: DbClient
  beforeEach(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-sched-'))
    resetNpmProbeCacheForTests()
    process.env.FAKE_NPM_MODE = 'success'
    db = createInMemoryDb(MIGRATIONS)
    // Seed three plugins so the agents below can reference them by name.
    for (const name of ['p-root', 'p-leaf', 'p-extra']) {
      await createPlugin(db, { name, spec: `${name}@1` }, { pluginsDir, npmBin: FAKE_NPM })
    }
  })
  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.FAKE_NPM_MODE
  })

  test('agent without plugins[] → plugins array is empty', async () => {
    await seedAgent(db, 'solo')
    const agent = (await getAgent(db, 'solo'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', agent, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.plugins).toEqual([])
  })

  test('root agent declares plugin → loaded into plugins array', async () => {
    await seedAgent(db, 'root', { plugins: ['p-root'] })
    const agent = (await getAgent(db, 'root'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', agent, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.plugins.map((p) => p.name)).toEqual(['p-root'])
  })

  test('dependsOn closure unions plugins[] across every member (root first)', async () => {
    await seedAgent(db, 'leaf', { plugins: ['p-leaf'] })
    await seedAgent(db, 'mid', { dependsOn: ['leaf'], plugins: ['p-root'] })
    await seedAgent(db, 'root', { dependsOn: ['mid'], plugins: ['p-extra'] })
    const root = (await getAgent(db, 'root'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', root, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.plugins.map((p) => p.name)).toEqual(['p-extra', 'p-root', 'p-leaf'])
  })

  test('closure with same plugin referenced twice → deduped (one row)', async () => {
    await seedAgent(db, 'leaf', { plugins: ['p-root'] })
    await seedAgent(db, 'root', { dependsOn: ['leaf'], plugins: ['p-root'] })
    const root = (await getAgent(db, 'root'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', root, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.plugins.map((p) => p.name)).toEqual(['p-root'])
  })

  test('plugin deleted out from under the running task → silently dropped (no kind=failed)', async () => {
    await seedAgent(db, 'a', { plugins: ['p-root'] })
    // Bypass the cascade guard via raw DB delete to simulate "deleted mid-flight".
    const { plugins: pluginsTable } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.delete(pluginsTable).where(eq(pluginsTable.name, 'p-root'))

    const agent = (await getAgent(db, 'a'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', agent, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.plugins).toEqual([])
  })
})
