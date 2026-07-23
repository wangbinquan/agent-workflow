// RFC-031 T7 → RFC-223 (PR-1) — pure-function tests for
// collectPluginIdsFromClosure + loadPluginsByIds. Locks: union across closure
// agents, dedupe, BFS-order preservation, empty-input short-circuit, tolerance
// for stale IDS at load time. RFC-223: agent.plugins stores plugin IDS now.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Agent } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { collectPluginIdsFromClosure, loadPluginsByIds } from '../src/services/pluginClosure'
import { createPlugin } from '../src/services/plugin'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.sh')

let pluginsDir = ''

function fakeAgent(name: string, plugins: string[] = []): Agent {
  return {
    id: `id-${name}`,
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins,
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('collectPluginIdsFromClosure', () => {
  test('empty closure → []', () => {
    expect(collectPluginIdsFromClosure([])).toEqual([])
  })

  test('single agent, single plugin', () => {
    expect(collectPluginIdsFromClosure([fakeAgent('a', ['p1'])])).toEqual(['p1'])
  })

  test('union across multiple agents preserves BFS order', () => {
    const closure = [
      fakeAgent('root', ['p1']),
      fakeAgent('dep1', ['p1', 'p2']),
      fakeAgent('dep2', ['p3']),
    ]
    expect(collectPluginIdsFromClosure(closure)).toEqual(['p1', 'p2', 'p3'])
  })

  test('dedupes within a single agent', () => {
    expect(collectPluginIdsFromClosure([fakeAgent('a', ['p1', 'p1', 'p2'])])).toEqual(['p1', 'p2'])
  })

  test('agent without plugins field treated as empty', () => {
    const a: Agent = { ...fakeAgent('a'), plugins: undefined as unknown as string[] }
    expect(collectPluginIdsFromClosure([a])).toEqual([])
  })
})

describe('loadPluginsByIds', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-cls-'))
    resetNpmProbeCacheForTests()
    process.env.FAKE_NPM_MODE = 'success'
  })
  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.FAKE_NPM_MODE
  })

  test('empty input → [] without hitting DB', async () => {
    expect(await loadPluginsByIds(db, [])).toEqual([])
  })

  test('hydrates matching ids, preserves caller order', async () => {
    const p1 = await createPlugin(db, { name: 'p1', spec: 's@1' }, { pluginsDir, npmBin: FAKE_NPM })
    const p2 = await createPlugin(db, { name: 'p2', spec: 's@2' }, { pluginsDir, npmBin: FAKE_NPM })
    const p3 = await createPlugin(db, { name: 'p3', spec: 's@3' }, { pluginsDir, npmBin: FAKE_NPM })

    const r = await loadPluginsByIds(db, [p2.id, p3.id, p1.id])
    expect(r.map((p) => p.name)).toEqual(['p2', 'p3', 'p1'])
  })

  test('unknown ids silently skipped (no throw)', async () => {
    const p1 = await createPlugin(db, { name: 'p1', spec: 's@1' }, { pluginsDir, npmBin: FAKE_NPM })
    const r = await loadPluginsByIds(db, [p1.id, 'no-such', 'gone'])
    expect(r.map((p) => p.name)).toEqual(['p1'])
  })
})
