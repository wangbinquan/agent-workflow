// RFC-031 T9 — scheduler `prepareNodeRunInjection` extends the dependsOn
// closure resolver with a plugin union + DB hydrate step. This test pins the
// contract on the helper itself (not the full scheduler tick) so red here
// points squarely at the closure→plugin glue, not at fan-out timing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { plugins } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { getAgent } from './helpers/resourceLookup'
import {
  createSqliteLegacyAgentDependencyLookup,
  resolveInjection,
} from '../src/services/execution/resolveInjection'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let pluginsDir = ''

async function seedAgent(
  db: DbClient,
  name: string,
  opts: { dependsOn?: string[]; plugins?: string[] } = {},
) {
  return createAgent(db, {
    name,
    description: '',
    outputs: [],
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
  let pluginIdByName: Map<string, string>
  beforeEach(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-sched-'))
    db = createInMemoryDb(MIGRATIONS)
    pluginIdByName = new Map()
    // Seed three plugins so the agents below can reference their canonical ids.
    for (const [index, name] of ['p-root', 'p-leaf', 'p-extra'].entries()) {
      const id = `plugin-${index + 1}`
      db.insert(plugins)
        .values({
          id,
          name,
          spec: `${name}@1`,
          sourceKind: 'npm',
          cachedPath: join(pluginsDir, name),
          installedAt: 1,
        })
        .run()
      pluginIdByName.set(name, id)
    }
  })
  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
  })

  test('agent without plugins[] → plugins array is empty', async () => {
    await seedAgent(db, 'solo')
    const agent = (await getAgent(db, 'solo'))!
    const result = await resolveInjection(db, agent, {
      appHome: '/tmp/aw',
      log: createLogger('test'),
      agentDependencies: createSqliteLegacyAgentDependencyLookup(db),
    })
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.spec.plugins).toEqual([])
  })

  test('root agent declares plugin → loaded into plugins array', async () => {
    await seedAgent(db, 'root', { plugins: [pluginIdByName.get('p-root')!] })
    const agent = (await getAgent(db, 'root'))!
    const result = await resolveInjection(db, agent, {
      appHome: '/tmp/aw',
      log: createLogger('test'),
      agentDependencies: createSqliteLegacyAgentDependencyLookup(db),
    })
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.spec.plugins.map((p) => p.name)).toEqual(['p-root'])
  })

  test('dependsOn closure unions plugins[] across every member (root first)', async () => {
    const leaf = await seedAgent(db, 'leaf', { plugins: [pluginIdByName.get('p-leaf')!] })
    const mid = await seedAgent(db, 'mid', {
      dependsOn: [leaf.id],
      plugins: [pluginIdByName.get('p-root')!],
    })
    await seedAgent(db, 'root', {
      dependsOn: [mid.id],
      plugins: [pluginIdByName.get('p-extra')!],
    })
    const root = (await getAgent(db, 'root'))!
    const result = await resolveInjection(db, root, {
      appHome: '/tmp/aw',
      log: createLogger('test'),
      agentDependencies: createSqliteLegacyAgentDependencyLookup(db),
    })
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.spec.plugins.map((p) => p.name)).toEqual(['p-extra', 'p-root', 'p-leaf'])
  })

  test('closure with same plugin referenced twice → deduped (one row)', async () => {
    const leaf = await seedAgent(db, 'leaf', { plugins: [pluginIdByName.get('p-root')!] })
    await seedAgent(db, 'root', {
      dependsOn: [leaf.id],
      plugins: [pluginIdByName.get('p-root')!],
    })
    const root = (await getAgent(db, 'root'))!
    const result = await resolveInjection(db, root, {
      appHome: '/tmp/aw',
      log: createLogger('test'),
      agentDependencies: createSqliteLegacyAgentDependencyLookup(db),
    })
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.spec.plugins.map((p) => p.name)).toEqual(['p-root'])
  })

  test('plugin deleted out from under the running task → fails closed before spawn', async () => {
    await seedAgent(db, 'a', { plugins: [pluginIdByName.get('p-root')!] })
    // Bypass the cascade guard via raw DB delete to simulate "deleted mid-flight".
    const { plugins: pluginsTable } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.delete(pluginsTable).where(eq(pluginsTable.id, pluginIdByName.get('p-root')!))

    const agent = (await getAgent(db, 'a'))!
    const result = await resolveInjection(db, agent, {
      appHome: '/tmp/aw',
      log: createLogger('test'),
      agentDependencies: createSqliteLegacyAgentDependencyLookup(db),
    })
    expect(result).toMatchObject({ kind: 'failed', message: 'plugin-not-found' })
  })
})
