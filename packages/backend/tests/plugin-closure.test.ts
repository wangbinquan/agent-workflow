// RFC-031 T7 — pure-function tests for collectPluginNamesFromClosure +
// loadPluginsByNames. Locks: union across closure agents, dedupe, BFS-order
// preservation, empty-input short-circuit, tolerance for stale names at
// load time.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Agent } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { collectPluginNamesFromClosure, loadPluginsByNames } from '../src/services/pluginClosure'
import { createPlugin } from '../src/services/plugin'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { writeFakeNpm } from './helpers/stub-runtime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let pluginsDir = ''
let fakeNpmBin = ''

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

describe('collectPluginNamesFromClosure', () => {
  test('empty closure → []', () => {
    expect(collectPluginNamesFromClosure([])).toEqual([])
  })

  test('single agent, single plugin', () => {
    expect(collectPluginNamesFromClosure([fakeAgent('a', ['p1'])])).toEqual(['p1'])
  })

  test('union across multiple agents preserves BFS order', () => {
    const closure = [
      fakeAgent('root', ['p1']),
      fakeAgent('dep1', ['p1', 'p2']),
      fakeAgent('dep2', ['p3']),
    ]
    expect(collectPluginNamesFromClosure(closure)).toEqual(['p1', 'p2', 'p3'])
  })

  test('dedupes within a single agent', () => {
    expect(collectPluginNamesFromClosure([fakeAgent('a', ['p1', 'p1', 'p2'])])).toEqual([
      'p1',
      'p2',
    ])
  })

  test('agent without plugins field treated as empty', () => {
    const a: Agent = { ...fakeAgent('a'), plugins: undefined as unknown as string[] }
    expect(collectPluginNamesFromClosure([a])).toEqual([])
  })
})

describe('loadPluginsByNames', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-cls-'))
    const npmDir = writeFakeNpm(pluginsDir)
    fakeNpmBin = resolve(npmDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    resetNpmProbeCacheForTests()
    process.env.FAKE_NPM_MODE = 'success'
  })
  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.FAKE_NPM_MODE
  })

  test('empty input → [] without hitting DB', async () => {
    expect(await loadPluginsByNames(db, [])).toEqual([])
  })

  test('hydrates matching names, preserves caller order', async () => {
    await createPlugin(db, { name: 'p1', spec: 's@1' }, { pluginsDir, npmBin: fakeNpmBin })
    await createPlugin(db, { name: 'p2', spec: 's@2' }, { pluginsDir, npmBin: fakeNpmBin })
    await createPlugin(db, { name: 'p3', spec: 's@3' }, { pluginsDir, npmBin: fakeNpmBin })

    const r = await loadPluginsByNames(db, ['p2', 'p3', 'p1'])
    expect(r.map((p) => p.name)).toEqual(['p2', 'p3', 'p1'])
  })

  test('unknown names silently skipped (no throw)', async () => {
    await createPlugin(db, { name: 'p1', spec: 's@1' }, { pluginsDir, npmBin: fakeNpmBin })
    const r = await loadPluginsByNames(db, ['p1', 'no-such', 'gone'])
    expect(r.map((p) => p.name)).toEqual(['p1'])
  })
})
