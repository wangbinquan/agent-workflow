// RFC-028 T6 → RFC-223 (PR-1) — pure-function tests for
// collectMcpIdsFromClosure + loadMcpsByIds. Locks: union across closure agents,
// dedupe, BFS-order preservation, empty-input short-circuit, tolerance for
// stale IDS at load time. RFC-223: agent.mcp stores mcp IDS now (was names), so
// the closure collects + hydrates by id.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Agent } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { collectMcpIdsFromClosure, loadMcpsByIds } from '../src/services/mcpClosure'
import { createMcp } from '../src/services/mcp'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function fakeAgent(name: string, mcp: string[] = []): Agent {
  return {
    id: `id-${name}`,
    name,
    description: '',
    outputs: [],
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

describe('collectMcpIdsFromClosure', () => {
  test('empty closure → []', () => {
    expect(collectMcpIdsFromClosure([])).toEqual([])
  })

  test('single agent, single mcp', () => {
    expect(collectMcpIdsFromClosure([fakeAgent('a', ['m1'])])).toEqual(['m1'])
  })

  test('union across multiple agents', () => {
    const closure = [
      fakeAgent('root', ['m1']),
      fakeAgent('dep1', ['m1', 'm2']),
      fakeAgent('dep2', ['m3']),
    ]
    expect(collectMcpIdsFromClosure(closure)).toEqual(['m1', 'm2', 'm3'])
  })

  test('dedupe preserves first-seen order', () => {
    const closure = [
      fakeAgent('root', ['z', 'a']),
      fakeAgent('dep1', ['a', 'b']),
      fakeAgent('dep2', ['z']),
    ]
    expect(collectMcpIdsFromClosure(closure)).toEqual(['z', 'a', 'b'])
  })

  test('tolerates legacy agent rows where mcp field is undefined', () => {
    const legacy = { ...fakeAgent('legacy', []) } as Agent & { mcp?: string[] }
    delete (legacy as { mcp?: string[] }).mcp
    expect(collectMcpIdsFromClosure([legacy])).toEqual([])
  })
})

describe('loadMcpsByIds', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('empty input does not hit DB', async () => {
    expect(await loadMcpsByIds(db, [])).toEqual([])
  })

  test('returns rows for known ids; silently skips unknown', async () => {
    const present = await createMcp(db, {
      name: 'present',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const out = await loadMcpsByIds(db, [present.id, 'missing-id'])
    expect(out.map((m) => m.name)).toEqual(['present'])
  })

  test('preserves caller-supplied id order', async () => {
    const a = await createMcp(db, {
      name: 'a',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    const b = await createMcp(db, {
      name: 'b',
      description: '',
      type: 'remote',
      config: { url: 'https://b.io' },
      enabled: true,
    })
    const c = await createMcp(db, {
      name: 'c',
      description: '',
      type: 'local',
      config: { command: ['y'] },
      enabled: true,
    })
    const out = await loadMcpsByIds(db, [c.id, a.id, b.id])
    expect(out.map((m) => m.name)).toEqual(['c', 'a', 'b'])
  })

  test('returned shape is the validated public Mcp type (config parsed)', async () => {
    const created = await createMcp(db, {
      name: 'm',
      description: '',
      type: 'local',
      config: { command: ['x', '-v'], env: { K: '1' }, timeoutMs: 4000 },
      enabled: true,
    })
    const [m] = await loadMcpsByIds(db, [created.id])
    if (m?.type !== 'local') throw new Error('expected local')
    expect(m.config.command).toEqual(['x', '-v'])
    expect(m.config.env).toEqual({ K: '1' })
    expect(m.config.timeoutMs).toBe(4000)
  })
})
