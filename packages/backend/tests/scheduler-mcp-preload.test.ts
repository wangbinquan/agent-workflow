// RFC-028 T8 — scheduler `prepareNodeRunInjection` extends the existing
// dependsOn closure resolver with an MCP union + DB hydrate step. This test
// pins the contract on the helper itself (not the full scheduler tick) so
// red here points squarely at the closure→mcp glue, not at fan-out timing.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import { getAgent } from './helpers/resourceLookup'
import { createMcp } from '../src/services/mcp'
import { prepareNodeRunInjection } from '../src/services/scheduler'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedAgent(
  db: DbClient,
  name: string,
  opts: { dependsOn?: string[]; mcp?: string[] } = {},
) {
  return createAgent(db, {
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: opts.dependsOn ?? [],
    mcp: opts.mcp ?? [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
}

describe('prepareNodeRunInjection — RFC-028 mcp union', () => {
  let db: DbClient
  let mcpIdByName: Map<string, string>
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    mcpIdByName = new Map()
    // Seed a small fleet of MCPs so agents can reference their canonical ids.
    for (const mcp of [
      await createMcp(db, {
        name: 'm-root',
        description: '',
        type: 'local',
        config: { command: ['x'] },
        enabled: true,
      }),
      await createMcp(db, {
        name: 'm-leaf',
        description: '',
        type: 'remote',
        config: { url: 'https://leaf.io/mcp' },
        enabled: true,
      }),
      await createMcp(db, {
        name: 'm-extra',
        description: '',
        type: 'local',
        config: { command: ['y'] },
        enabled: true,
      }),
    ]) {
      mcpIdByName.set(mcp.name, mcp.id)
    }
  })

  test('agent without mcp[] → mcps array is empty', async () => {
    await seedAgent(db, 'solo')
    const agent = (await getAgent(db, 'solo'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', agent, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.mcps).toEqual([])
  })

  test('root agent declares mcp → loaded into mcps array', async () => {
    await seedAgent(db, 'root', { mcp: [mcpIdByName.get('m-root')!] })
    const agent = (await getAgent(db, 'root'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', agent, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.mcps.map((m) => m.name)).toEqual(['m-root'])
  })

  test('dependsOn closure unions mcp[] across every member (root first)', async () => {
    // leaf -> m-leaf; mid -> m-root; root -> m-extra
    const leaf = await seedAgent(db, 'leaf', { mcp: [mcpIdByName.get('m-leaf')!] })
    const mid = await seedAgent(db, 'mid', {
      dependsOn: [leaf.id],
      mcp: [mcpIdByName.get('m-root')!],
    })
    await seedAgent(db, 'root', {
      dependsOn: [mid.id],
      mcp: [mcpIdByName.get('m-extra')!],
    })
    const root = (await getAgent(db, 'root'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', root, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.mcps.map((m) => m.name)).toEqual(['m-extra', 'm-root', 'm-leaf'])
  })

  test('closure with same mcp referenced twice → deduped (one row)', async () => {
    const leaf = await seedAgent(db, 'leaf', { mcp: [mcpIdByName.get('m-root')!] })
    await seedAgent(db, 'root', {
      dependsOn: [leaf.id],
      mcp: [mcpIdByName.get('m-root')!],
    })
    const root = (await getAgent(db, 'root'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', root, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.mcps.map((m) => m.name)).toEqual(['m-root'])
  })

  test('mcp deleted out from under the running task → silently dropped (no kind=failed)', async () => {
    // Save-time validation prevents creating an agent with a missing mcp,
    // but we can simulate "deleted mid-flight" by deleting the row after
    // the agent was created. The save guard blocks deletes via the cascade,
    // so we go to raw DB to bypass it (matches the proposal §6 stance:
    // we never crash a node over a missing MCP).
    await seedAgent(db, 'a', { mcp: [mcpIdByName.get('m-root')!] })
    const { mcps: mcpsTable } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.delete(mcpsTable).where(eq(mcpsTable.id, mcpIdByName.get('m-root')!))

    const agent = (await getAgent(db, 'a'))!
    const result = await prepareNodeRunInjection(db, '/tmp/aw', agent, createLogger('test'))
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.mcps).toEqual([])
  })
})
