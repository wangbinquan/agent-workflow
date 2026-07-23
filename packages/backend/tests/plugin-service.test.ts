// RFC-031 T4 — services/plugin.ts CRUD + reference cascade.
//
// Locks: create → list → get → update → rename → delete happy path; install
// failure rolls back without leaving a DB row; still-referenced delete guard;
// name-conflict; rename cascade updates agents.plugins JSON column atomically;
// delete defers immutable-generation cleanup to conservative GC.
//
// Install path uses the test-only fake-npm.sh shim (see RFC-031 design §3.2)
// so tests stay hermetic and offline.

import { buildActor } from '../src/auth/actor'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, getAgent } from '../src/services/agent'
import {
  createPlugin,
  collectPluginGenerationGarbage,
  deletePlugin,
  findAgentsReferencingPlugin,
  getPlugin,
  listPlugins,
  renamePlugin,
  updatePlugin,
} from '../src/services/plugin'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { ConflictError, NotFoundError } from '../src/util/errors'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.sh')

let pluginsDir = ''

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-svc-'))
  resetNpmProbeCacheForTests()
  process.env.FAKE_NPM_MODE = 'success'
  delete process.env.FAKE_NPM_VERSION
})

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
  delete process.env.FAKE_NPM_MODE
  delete process.env.FAKE_NPM_VERSION
})

const opts = () => ({ pluginsDir, npmBin: FAKE_NPM })

describe('services/plugin.ts CRUD', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('create + list + get by id and by name', async () => {
    process.env.FAKE_NPM_VERSION = '1.2.3'
    const p = await createPlugin(
      db,
      { name: 'dd-trace', spec: '@mycorp/dd-trace@1.2.3', options: { apiKey: 'k' } },
      opts(),
    )
    expect(p.id).toBeTruthy()
    expect(p.name).toBe('dd-trace')
    expect(p.spec).toBe('@mycorp/dd-trace@1.2.3')
    expect(p.options).toEqual({ apiKey: 'k' })
    expect(p.sourceKind).toBe('npm')
    expect(p.resolvedVersion).toBe('1.2.3')
    expect(p.enabled).toBe(true)
    expect(p.cachedPath).toContain('node_modules')

    const listed = await listPlugins(db)
    expect(listed).toHaveLength(1)

    const byId = await getPlugin(db, p.id)
    expect(byId?.name).toBe('dd-trace')
    const byName = await getPlugin(db, 'dd-trace')
    expect(byName?.id).toBe(p.id)
  })

  test('create conflict: name in use → ConflictError', async () => {
    await createPlugin(db, { name: 'shared', spec: 'a@1' }, opts())
    await expect(createPlugin(db, { name: 'shared', spec: 'b@1' }, opts())).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  test('RFC-223 scopes create and rename conflicts to the owner bucket', async () => {
    const source = await createPlugin(db, { name: 'source', spec: 'source@1' }, opts(), {
      ownerUserId: 'owner-a',
    })
    await createPlugin(db, { name: 'shared', spec: 'shared-b@1' }, opts(), {
      ownerUserId: 'owner-b',
    })

    await expect(renamePlugin(db, source.id, { newName: 'shared' })).resolves.toMatchObject({
      id: source.id,
      name: 'shared',
    })

    await createPlugin(db, { name: 'taken', spec: 'taken@1' }, opts(), { ownerUserId: 'owner-a' })
    await expect(renamePlugin(db, source.id, { newName: 'taken' })).rejects.toMatchObject({
      code: 'plugin-name-in-use',
    })
    await expect(
      createPlugin(db, { name: 'taken', spec: 'duplicate@1' }, opts(), { ownerUserId: 'owner-a' }),
    ).rejects.toMatchObject({ code: 'plugin-name-in-use' })

    await expect(
      createPlugin(db, { name: 'shared', spec: 'shared-c@1' }, opts(), { ownerUserId: 'owner-c' }),
    ).resolves.toMatchObject({ name: 'shared', ownerUserId: 'owner-c' })
    await expect(renamePlugin(db, source.id, { newName: 'shared' })).resolves.toMatchObject({
      id: source.id,
      name: 'shared',
    })
  })

  test('RFC-223 maps a same-owner create race to one stable 409 conflict', async () => {
    const results = await Promise.allSettled([
      createPlugin(db, { name: 'raced', spec: 'race-a@1' }, opts(), { ownerUserId: 'owner-a' }),
      createPlugin(db, { name: 'raced', spec: 'race-b@1' }, opts(), { ownerUserId: 'owner-a' }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected?.reason).toMatchObject({ code: 'plugin-name-in-use', status: 409 })
  })

  test('install failure leaves no DB row', async () => {
    process.env.FAKE_NPM_MODE = 'fail'
    await expect(createPlugin(db, { name: 'broken', spec: 'nope@99' }, opts())).rejects.toThrow()
    const list = await listPlugins(db)
    expect(list).toHaveLength(0)
  })

  test('update spec triggers re-install + refreshes resolvedVersion', async () => {
    process.env.FAKE_NPM_VERSION = '1.0.0'
    const p = await createPlugin(db, { name: 'p', spec: 'pkg@1.0.0' }, opts())
    process.env.FAKE_NPM_VERSION = '2.0.0'
    const updated = await updatePlugin(db, p.id, { spec: 'pkg@2.0.0' }, opts())
    expect(updated.spec).toBe('pkg@2.0.0')
    expect(updated.resolvedVersion).toBe('2.0.0')
    expect(updated.installedAt).toBeGreaterThanOrEqual(p.installedAt)
  })

  test('update without spec does NOT re-install (resolvedVersion unchanged)', async () => {
    process.env.FAKE_NPM_VERSION = '1.0.0'
    const p = await createPlugin(db, { name: 'p2', spec: 'pkg@1.0.0' }, opts())
    process.env.FAKE_NPM_VERSION = '9.9.9' // would change if we re-install
    const updated = await updatePlugin(db, p.id, { enabled: false }, opts())
    expect(updated.enabled).toBe(false)
    expect(updated.resolvedVersion).toBe('1.0.0')
  })

  test('update options re-validates as object', async () => {
    const p = await createPlugin(db, { name: 'p3', spec: 'pkg@1' }, opts())
    const u = await updatePlugin(db, p.id, { options: { nested: { x: 1 } } }, opts())
    expect(u.options).toEqual({ nested: { x: 1 } })
  })

  test('update on missing plugin → NotFoundError', async () => {
    await expect(updatePlugin(db, 'no-such-id', { enabled: false }, opts())).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })
})

describe('services/plugin.ts delete + cleanup', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('delete removes row but defers generation cleanup until conservative GC', async () => {
    const p = await createPlugin(db, { name: 'gone', spec: 'g@1' }, opts())
    expect(existsSync(p.cachedPath)).toBe(true)
    // Inline deletion would be unsafe even when this generation is old: a
    // child process may still be importing it after the row disappears.
    const generationDir = dirname(dirname(p.cachedPath))
    const old = new Date(Date.now() - 48 * 60 * 60_000)
    await utimes(generationDir, old, old)
    await deletePlugin(db, p.id, T6_ACTOR, opts())
    expect(await listPlugins(db)).toHaveLength(0)
    expect(existsSync(p.cachedPath)).toBe(true)
    await collectPluginGenerationGarbage(db, opts(), { graceMs: 0, now: Date.now() + 1 })
    expect(existsSync(p.cachedPath)).toBe(false)
  })

  test('delete missing → NotFoundError', async () => {
    await expect(deletePlugin(db, 'no-such-id', T6_ACTOR, opts())).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('delete still-referenced → ConflictError with principal-aware visible list', async () => {
    const p = await createPlugin(db, { name: 'live', spec: 'live@1' }, opts())
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
      plugins: ['live'],
      frontmatterExtra: {},
      bodyMd: '',
    })
    try {
      await deletePlugin(db, p.id, T6_ACTOR, opts())
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

describe('services/plugin.ts rename + cascade', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('rename happy path', async () => {
    const p = await createPlugin(db, { name: 'old', spec: 's@1' }, opts())
    const r = await renamePlugin(db, p.id, { newName: 'fresh' })
    expect(r.name).toBe('fresh')
    expect(r.id).toBe(p.id)
    expect(await getPlugin(db, 'old')).toBeNull()
    expect((await getPlugin(db, 'fresh'))?.id).toBe(p.id)
  })

  test('rename to existing name → ConflictError', async () => {
    await createPlugin(db, { name: 'taken', spec: 't@1' }, opts())
    const p = await createPlugin(db, { name: 'src', spec: 's@1' }, opts())
    await expect(renamePlugin(db, p.id, { newName: 'taken' })).rejects.toBeInstanceOf(ConflictError)
  })

  // RFC-223 (PR-1 / D7): agents.plugins stores the plugin ID (stable across a
  // rename) — so a rename does NOT rewrite the referencing agent's plugins.
  test('rename does NOT rewrite agents.plugins (ids are stable)', async () => {
    const p = await createPlugin(db, { name: 'old-name', spec: 's@1' }, opts())
    // seed an unrelated plugin to assert non-matching ids survive untouched
    const other = await createPlugin(db, { name: 'other', spec: 'o@1' }, opts())

    await createAgent(db, {
      name: 'consumer',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: ['old-name', 'other'],
      frontmatterExtra: {},
      bodyMd: '',
    })

    await renamePlugin(db, p.id, { newName: 'new-name' })
    const a = await getAgent(db, 'consumer')
    // Ids unchanged; the renamed plugin still resolves by its stable id.
    expect(a?.plugins).toEqual([p.id, other.id])
  })

  // RFC-223 (PR-1): agents.plugins stores plugin IDS — the reverse lookup keys
  // on the plugin id, so another plugin's id never matches this agent.
  test('findAgentsReferencingPlugin: matches by id, not another plugin', async () => {
    const dd = await createPlugin(db, { name: 'dd', spec: 's@1' }, opts())
    const trace = await createPlugin(db, { name: 'dd-trace', spec: 's@2' }, opts())
    await createAgent(db, {
      name: 'a-dd',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: ['dd-trace'],
      frontmatterExtra: {},
      bodyMd: '',
    })
    // Looking up 'dd' by id must NOT return the agent that only has 'dd-trace'.
    expect(await findAgentsReferencingPlugin(db, dd.id)).toEqual([])
    expect((await findAgentsReferencingPlugin(db, trace.id)).map((r) => r.name)).toEqual(['a-dd'])
  })
})
