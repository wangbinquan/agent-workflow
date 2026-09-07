// RFC-031 T7 → RFC-223 (PR-1) — pure-function tests for
// collectPluginIdsFromClosure + loadPluginsByIds. Locks: union across closure
// agents, dedupe, BFS-order preservation, empty-input short-circuit, tolerance
// for stale IDS at load time. RFC-223: agent.plugins stores plugin IDS now.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Agent } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { buildActor } from '../src/auth/actor'
import { AuthorityClaimRegistry } from '../src/modules/identity-access/application/operationContext'
import { composePluginCatalog } from '../src/modules/resource-catalog/composition/pluginOperations'
import { composeResourceCatalogFor } from '../src/modules/resource-catalog/composition/providerResourceCatalog'
import { ResourceOperationCoordinator } from '../src/services/resourceOperationCoordinator'
import { createPluginRepository } from '../src/modules/resource-catalog/infrastructure/pluginRepository'
import {
  collectPluginIdsFromClosure,
  loadPluginsByIds,
  type PluginClosureQuery,
} from '../src/services/pluginClosure'
import { createPlugin, type PluginServiceBinding } from './helpers/pluginServiceBinding'
import {
  checkForUpdate,
  cleanupInstallGeneration,
  installPlugin,
  resetNpmProbeCacheForTests,
} from '../src/services/pluginInstaller'

const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.ts')

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

describeEachProvider('loadPluginsByIds', (harness) => {
  let db: ProviderNeutralDatabase
  let binding: PluginServiceBinding
  let query: PluginClosureQuery
  beforeEach(async () => {
    db = harness.db
    pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-cls-'))
    resetNpmProbeCacheForTests()
    process.env.FAKE_NPM_MODE = 'success'
    const actor = buildActor({
      user: {
        id: 'plugin-test-admin',
        username: 'plugin-test-admin',
        displayName: 'Plugin Test Admin',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const authority = new AuthorityClaimRegistry().mintDirectAuthority(
      { userId: actor.user.id, source: actor.source },
      { ...actor, userId: actor.user.id },
    ).actor
    const installerOptions = { pluginsDir, npmBin: FAKE_NPM }
    binding = {
      authority,
      catalog: composePluginCatalog({
        db,
        resourceCatalog: composeResourceCatalogFor({ db }),
        coordinator: new ResourceOperationCoordinator(),
        installer: {
          async install(pluginId, spec) {
            const installed = await installPlugin(pluginId, spec, installerOptions)
            return {
              sourceKind: installed.sourceKind,
              cachedPath: installed.cachedPath,
              resolvedVersion: installed.resolvedVersion,
              cleanup: () => cleanupInstallGeneration(installed),
            }
          },
          checkForUpdate: (pluginId, spec, currentCachedPath) =>
            checkForUpdate(pluginId, spec, currentCachedPath, installerOptions),
        },
      }),
    }
    const repository = createPluginRepository({ db }).repository
    query = Object.freeze({
      async loadByIds(ids: readonly string[]) {
        const rows = await Promise.all(ids.map((id: string) => repository.get(id)))
        return rows.filter((row): row is NonNullable<typeof row> => row !== null)
      },
    })
  })
  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.FAKE_NPM_MODE
  })

  test('empty input → [] without hitting DB', async () => {
    expect(await loadPluginsByIds(query, [])).toEqual([])
  })

  test('hydrates matching ids, preserves caller order', async () => {
    const p1 = await createPlugin(binding, { name: 'p1', spec: 's@1' })
    const p2 = await createPlugin(binding, { name: 'p2', spec: 's@2' })
    const p3 = await createPlugin(binding, { name: 'p3', spec: 's@3' })

    const r = await loadPluginsByIds(query, [p2.id, p3.id, p1.id])
    expect(r.map((p) => p.name)).toEqual(['p2', 'p3', 'p1'])
  })

  test('unknown ids silently skipped (no throw)', async () => {
    const p1 = await createPlugin(binding, { name: 'p1', spec: 's@1' })
    const r = await loadPluginsByIds(query, [p1.id, 'no-such', 'gone'])
    expect(r.map((p) => p.name)).toEqual(['p1'])
  })
})
