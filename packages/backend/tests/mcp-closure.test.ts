// RFC-028 T6 — pure-function tests for collectMcpNamesFromClosure +
// loadMcpsByNames. Locks: union across closure agents, dedupe, BFS-order
// preservation, empty-input short-circuit, tolerance for stale names at
// load time.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Agent } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { collectMcpNamesFromClosure, loadMcpsByNames } from '../src/services/mcpClosure'
import { createMcp } from '../src/services/mcp'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function fakeAgent(name: string, mcp: string[] = []): Agent {
  return {
    id: `id-${name}`,
    name,
    description: '',
    outputs: [],
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp,
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('collectMcpNamesFromClosure', () => {
  test('empty closure → []', () => {
    expect(collectMcpNamesFromClosure([])).toEqual([])
  })

  test('single agent, single mcp', () => {
    expect(collectMcpNamesFromClosure([fakeAgent('a', ['m1'])])).toEqual(['m1'])
  })

  test('union across multiple agents', () => {
    const closure = [
      fakeAgent('root', ['m1']),
      fakeAgent('dep1', ['m1', 'm2']),
      fakeAgent('dep2', ['m3']),
    ]
    expect(collectMcpNamesFromClosure(closure)).toEqual(['m1', 'm2', 'm3'])
  })

  test('dedupe preserves first-seen order', () => {
    const closure = [
      fakeAgent('root', ['z', 'a']),
      fakeAgent('dep1', ['a', 'b']),
      fakeAgent('dep2', ['z']),
    ]
    expect(collectMcpNamesFromClosure(closure)).toEqual(['z', 'a', 'b'])
  })

  test('tolerates legacy agent rows where mcp field is undefined', () => {
    const legacy = { ...fakeAgent('legacy', []) } as Agent & { mcp?: string[] }
    delete (legacy as { mcp?: string[] }).mcp
    expect(collectMcpNamesFromClosure([legacy])).toEqual([])
  })
})

describe('loadMcpsByNames', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('empty input does not hit DB', async () => {
    expect(await loadMcpsByNames(db, [])).toEqual([])
  })

  test('returns rows for known names; silently skips unknown', async () => {
    await createMcp(db, {
      name: 'present',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const out = await loadMcpsByNames(db, ['present', 'missing'])
    expect(out.map((m) => m.name)).toEqual(['present'])
  })

  test('preserves caller-supplied name order', async () => {
    await createMcp(db, {
      name: 'a',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await createMcp(db, {
      name: 'b',
      description: '',
      type: 'remote',
      config: { url: 'https://b.io' },
      enabled: true,
    })
    await createMcp(db, {
      name: 'c',
      description: '',
      type: 'local',
      config: { command: ['y'] },
      enabled: true,
    })
    const out = await loadMcpsByNames(db, ['c', 'a', 'b'])
    expect(out.map((m) => m.name)).toEqual(['c', 'a', 'b'])
  })

  test('returned shape is the validated public Mcp type (config parsed)', async () => {
    await createMcp(db, {
      name: 'm',
      description: '',
      type: 'local',
      config: { command: ['x', '-v'], env: { K: '1' }, timeoutMs: 4000 },
      enabled: true,
    })
    const [m] = await loadMcpsByNames(db, ['m'])
    if (m?.type !== 'local') throw new Error('expected local')
    expect(m.config.command).toEqual(['x', '-v'])
    expect(m.config.env).toEqual({ K: '1' })
    expect(m.config.timeoutMs).toBe(4000)
  })
})
