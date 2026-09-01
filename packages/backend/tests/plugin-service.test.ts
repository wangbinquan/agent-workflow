// RFC-031 T4 — PluginCatalog CRUD + reference cascade.
//
// Locks: create → list → get → update → rename → delete happy path; install
// failure rolls back without leaving a DB row; still-referenced delete guard;
// name-conflict; rename cascade updates agents.plugins JSON column atomically;
// delete defers immutable-generation cleanup to conservative GC.
//
// Install path uses the test-only fake-npm.ts shim (see RFC-031 design §3.2)
// so tests stay hermetic and offline.

import { buildActor } from '../src/auth/actor'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { AuthorityClaimRegistry } from '../src/modules/identity-access/application/operationContext'
import type { PluginInstallerPort } from '../src/modules/resource-catalog/application/plugins/ports'
import { composeSqlitePluginGenerationGcCommand } from '../src/modules/resource-catalog/composition/pluginGenerationGc'
import { composePluginCatalog } from '../src/modules/resource-catalog/composition/pluginOperations'
import { createSqlitePluginRepository } from '../src/modules/resource-catalog/infrastructure/sqlitePluginRepository'
import type { PluginCatalogModule } from '../src/modules/resource-catalog/public/operations'
import type { PluginOperationContext } from '../src/modules/resource-catalog/public/participants'
import { createAgent } from '../src/services/agent'
import { getAgent } from './helpers/resourceLookup'
import {
  createPlugin,
  deletePlugin,
  getPlugin,
  listPlugins,
  renamePlugin,
  type PluginServiceBinding,
  updatePlugin,
} from './helpers/pluginServiceBinding'
import { createPluginGenerationFilesystemGcPort } from '../src/services/pluginGenerationGc'
import {
  checkForUpdate,
  cleanupInstallGeneration,
  installPlugin,
  resetNpmProbeCacheForTests,
} from '../src/services/pluginInstaller'
import { ResourceOperationCoordinator } from '../src/services/resourceOperationCoordinator'
import { ConflictError, NotFoundError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.ts')

let pluginsDir = ''
let db: DbClient
let catalog: PluginCatalogModule
let binding: PluginServiceBinding

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-svc-'))
  resetNpmProbeCacheForTests()
  process.env.FAKE_NPM_MODE = 'success'
  delete process.env.FAKE_NPM_VERSION
  db = createInMemoryDb(MIGRATIONS)
  catalog = composeTestPluginCatalog(db)
  binding = serviceBinding(catalog)
})

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
  delete process.env.FAKE_NPM_MODE
  delete process.env.FAKE_NPM_VERSION
})

const opts = () => ({ pluginsDir, npmBin: FAKE_NPM })

function authorityFor(userId: string, role: 'admin' | 'user' = 'admin'): PluginOperationContext {
  const projection = buildActor({
    user: { id: userId, username: userId, displayName: userId, role, status: 'active' },
    source: 'session',
  })
  return new AuthorityClaimRegistry().mintDirectAuthority(
    { userId, source: 'session' },
    { ...projection, userId },
  ).actor
}

function testPluginInstaller(): PluginInstallerPort {
  return Object.freeze({
    async install(pluginId: string, spec: string) {
      const installed = await installPlugin(pluginId, spec, opts())
      return Object.freeze({
        sourceKind: installed.sourceKind,
        cachedPath: installed.cachedPath,
        resolvedVersion: installed.resolvedVersion,
        cleanup: () => cleanupInstallGeneration(installed),
      })
    },
    checkForUpdate: (pluginId: string, spec: string, currentCachedPath: string) =>
      checkForUpdate(pluginId, spec, currentCachedPath, opts()),
  })
}

function composeTestPluginCatalog(db: DbClient): PluginCatalogModule {
  return composePluginCatalog({
    db,
    coordinator: new ResourceOperationCoordinator(),
    installer: testPluginInstaller(),
  })
}

function serviceBinding(
  pluginCatalog: PluginCatalogModule,
  userId = 'u-t6-test',
  role: 'admin' | 'user' = 'admin',
): PluginServiceBinding {
  return Object.freeze({ catalog: pluginCatalog, authority: authorityFor(userId, role) })
}

function findAgentReferences(pluginId: string) {
  return createSqlitePluginRepository(db).repository.findAgentReferences(pluginId)
}

async function collectPluginGenerationGarbage(now: number): Promise<void> {
  await composeSqlitePluginGenerationGcCommand(
    db,
    createPluginGenerationFilesystemGcPort(pluginsDir),
  ).run({ executionFence: 'clear', graceMs: 0, now })
}

describe('PluginCatalog CRUD', () => {
  test('create + list + get by stable id (name is not an identity selector)', async () => {
    process.env.FAKE_NPM_VERSION = '1.2.3'
    const p = await createPlugin(binding, {
      name: 'dd-trace',
      spec: '@mycorp/dd-trace@1.2.3',
      options: { apiKey: 'k' },
    })
    expect(p.id).toBeTruthy()
    expect(p.name).toBe('dd-trace')
    expect(p.spec).toBe('@mycorp/dd-trace@1.2.3')
    expect(p.options).toEqual({ apiKey: 'k' })
    expect(p.sourceKind).toBe('npm')
    expect(p.resolvedVersion).toBe('1.2.3')
    expect(p.enabled).toBe(true)
    expect(p.cachedPath).toContain('node_modules')

    const listed = await listPlugins(binding)
    expect(listed).toHaveLength(1)

    const byId = await getPlugin(binding, p.id)
    expect(byId?.name).toBe('dd-trace')
    const byName = await getPlugin(binding, 'dd-trace')
    expect(byName).toBeNull()
  })

  test('create conflict: name in use → ConflictError', async () => {
    await createPlugin(binding, { name: 'shared', spec: 'a@1' })
    await expect(createPlugin(binding, { name: 'shared', spec: 'b@1' })).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  test('RFC-223 scopes create and rename conflicts to the owner bucket', async () => {
    const ownerA = serviceBinding(catalog, 'owner-a', 'user')
    const ownerB = serviceBinding(catalog, 'owner-b', 'user')
    const ownerC = serviceBinding(catalog, 'owner-c', 'user')
    const source = await createPlugin(ownerA, { name: 'source', spec: 'source@1' })
    await createPlugin(ownerB, { name: 'shared', spec: 'shared-b@1' })

    await expect(renamePlugin(ownerA, source.id, { newName: 'shared' })).resolves.toMatchObject({
      id: source.id,
      name: 'shared',
    })

    await createPlugin(ownerA, { name: 'taken', spec: 'taken@1' })
    await expect(renamePlugin(ownerA, source.id, { newName: 'taken' })).rejects.toMatchObject({
      code: 'plugin-name-in-use',
    })
    await expect(
      createPlugin(ownerA, { name: 'taken', spec: 'duplicate@1' }),
    ).rejects.toMatchObject({ code: 'plugin-name-in-use' })

    await expect(
      createPlugin(ownerC, { name: 'shared', spec: 'shared-c@1' }),
    ).resolves.toMatchObject({ name: 'shared', ownerUserId: 'owner-c' })
    await expect(renamePlugin(ownerA, source.id, { newName: 'shared' })).resolves.toMatchObject({
      id: source.id,
      name: 'shared',
    })
  })

  test('RFC-223 maps a same-owner create race to one stable 409 conflict', async () => {
    const results = await Promise.allSettled([
      createPlugin(serviceBinding(catalog, 'owner-a', 'user'), {
        name: 'raced',
        spec: 'race-a@1',
      }),
      createPlugin(serviceBinding(catalog, 'owner-a', 'user'), {
        name: 'raced',
        spec: 'race-b@1',
      }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected?.reason).toMatchObject({ code: 'plugin-name-in-use', status: 409 })
  })

  test('install failure leaves no DB row', async () => {
    process.env.FAKE_NPM_MODE = 'fail'
    await expect(createPlugin(binding, { name: 'broken', spec: 'nope@99' })).rejects.toThrow()
    const list = await listPlugins(binding)
    expect(list).toHaveLength(0)
  })

  test('update spec triggers re-install + refreshes resolvedVersion', async () => {
    process.env.FAKE_NPM_VERSION = '1.0.0'
    const p = await createPlugin(binding, { name: 'p', spec: 'pkg@1.0.0' })
    process.env.FAKE_NPM_VERSION = '2.0.0'
    const updated = await updatePlugin(binding, p.id, { spec: 'pkg@2.0.0' })
    expect(updated.spec).toBe('pkg@2.0.0')
    expect(updated.resolvedVersion).toBe('2.0.0')
    expect(updated.installedAt).toBeGreaterThanOrEqual(p.installedAt)
  })

  test('update without spec does NOT re-install (resolvedVersion unchanged)', async () => {
    process.env.FAKE_NPM_VERSION = '1.0.0'
    const p = await createPlugin(binding, { name: 'p2', spec: 'pkg@1.0.0' })
    process.env.FAKE_NPM_VERSION = '9.9.9' // would change if we re-install
    const updated = await updatePlugin(binding, p.id, { enabled: false })
    expect(updated.enabled).toBe(false)
    expect(updated.resolvedVersion).toBe('1.0.0')
  })

  test('update options re-validates as object', async () => {
    const p = await createPlugin(binding, { name: 'p3', spec: 'pkg@1' })
    const u = await updatePlugin(binding, p.id, { options: { nested: { x: 1 } } })
    expect(u.options).toEqual({ nested: { x: 1 } })
  })

  test('update on missing plugin → NotFoundError', async () => {
    await expect(updatePlugin(binding, 'no-such-id', { enabled: false })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })
})

describe('PluginCatalog delete + cleanup', () => {
  test('delete removes row but defers generation cleanup until conservative GC', async () => {
    const p = await createPlugin(binding, { name: 'gone', spec: 'g@1' })
    expect(existsSync(p.cachedPath)).toBe(true)
    // Inline deletion would be unsafe even when this generation is old: a
    // child process may still be importing it after the row disappears.
    const generationDir = dirname(dirname(p.cachedPath))
    const old = new Date(Date.now() - 48 * 60 * 60_000)
    await utimes(generationDir, old, old)
    await deletePlugin(binding, p.id)
    expect(await listPlugins(binding)).toHaveLength(0)
    expect(existsSync(p.cachedPath)).toBe(true)
    await collectPluginGenerationGarbage(Date.now() + 1)
    expect(existsSync(p.cachedPath)).toBe(false)
  })

  test('delete missing → NotFoundError', async () => {
    await expect(deletePlugin(binding, 'no-such-id')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('delete still-referenced → ConflictError with principal-aware visible list', async () => {
    const p = await createPlugin(binding, { name: 'live', spec: 'live@1' })
    // createAgent validates that referenced plugins exist (T6 layer), so we
    // first persist the plugin, then mint the agent referencing it.
    await createAgent(db, {
      name: 'consumer',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [p.id],
      frontmatterExtra: {},
      bodyMd: '',
    })
    try {
      await deletePlugin(binding, p.id)
      throw new Error('expected ConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      const e = err as ConflictError
      expect(e.code).toBe('plugin-still-referenced')
      expect(e.details).toEqual(
        expect.objectContaining({
          visible: [{ id: expect.any(String), name: 'consumer' }],
          hiddenCount: 0,
        }),
      )
    }
  })
})

describe('PluginCatalog rename + cascade', () => {
  test('rename happy path', async () => {
    const p = await createPlugin(binding, { name: 'old', spec: 's@1' })
    const r = await renamePlugin(binding, p.id, { newName: 'fresh' })
    expect(r.name).toBe('fresh')
    expect(r.id).toBe(p.id)
    expect(await getPlugin(binding, 'old')).toBeNull()
    expect((await getPlugin(binding, p.id))?.name).toBe('fresh')
  })

  test('rename to existing name → ConflictError', async () => {
    await createPlugin(binding, { name: 'taken', spec: 't@1' })
    const p = await createPlugin(binding, { name: 'src', spec: 's@1' })
    await expect(renamePlugin(binding, p.id, { newName: 'taken' })).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  // RFC-223 (PR-1 / D7): agents.plugins stores the plugin ID (stable across a
  // rename) — so a rename does NOT rewrite the referencing agent's plugins.
  test('rename does NOT rewrite agents.plugins (ids are stable)', async () => {
    const p = await createPlugin(binding, { name: 'old-name', spec: 's@1' })
    // seed an unrelated plugin to assert non-matching ids survive untouched
    const other = await createPlugin(binding, { name: 'other', spec: 'o@1' })

    await createAgent(db, {
      name: 'consumer',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [p.id, other.id],
      frontmatterExtra: {},
      bodyMd: '',
    })

    await renamePlugin(binding, p.id, { newName: 'new-name' })
    const a = await getAgent(db, 'consumer')
    // Ids unchanged; the renamed plugin still resolves by its stable id.
    expect(a?.plugins).toEqual([p.id, other.id])
  })

  // RFC-223 (PR-1): agents.plugins stores plugin IDS — the reverse lookup keys
  // on the plugin id, so another plugin's id never matches this agent.
  test('findAgentsReferencingPlugin: matches by id, not another plugin', async () => {
    const dd = await createPlugin(binding, { name: 'dd', spec: 's@1' })
    const trace = await createPlugin(binding, { name: 'dd-trace', spec: 's@2' })
    await createAgent(db, {
      name: 'a-dd',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [trace.id],
      frontmatterExtra: {},
      bodyMd: '',
    })
    // Looking up 'dd' by id must NOT return the agent that only has 'dd-trace'.
    expect(await findAgentReferences(dd.id)).toEqual([])
    expect((await findAgentReferences(trace.id)).map((r) => r.name)).toEqual(['a-dd'])
  })
})
