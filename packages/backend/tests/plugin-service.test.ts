// RFC-031 T4 — services/plugin.ts CRUD + reference cascade.
//
// Locks: create → list → get → update → rename → delete happy path; install
// failure rolls back without leaving a DB row; still-referenced delete guard;
// name-conflict; rename cascade updates agents.plugins JSON column atomically;
// delete cleans up the plugin install directory.
//
// Install path uses the test-only fake-npm.sh shim (see RFC-031 design §3.2)
// so tests stay hermetic and offline.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, getAgent } from '../src/services/agent'
import {
  createPlugin,
  deletePlugin,
  findAgentsReferencingPlugin,
  getPlugin,
  listPlugins,
  renamePlugin,
  updatePlugin,
} from '../src/services/plugin'
import { probeNpmBinary, resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { writeFakeNpm } from './helpers/stub-runtime'
import { ConflictError, NotFoundError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let pluginsDir = ''
let fakeNpmBin = ''

beforeEach(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc031-svc-'))
  const npmDir = writeFakeNpm(pluginsDir)
  fakeNpmBin = resolve(npmDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  resetNpmProbeCacheForTests()
  process.env.FAKE_NPM_MODE = 'success'
  delete process.env.FAKE_NPM_VERSION
})

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
  delete process.env.FAKE_NPM_MODE
  delete process.env.FAKE_NPM_VERSION
})

const opts = () => ({ pluginsDir, npmBin: fakeNpmBin })

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

  test('delete removes row + cleans plugin dir from disk', async () => {
    const p = await createPlugin(db, { name: 'gone', spec: 'g@1' }, opts())
    const installDir = join(pluginsDir, p.id)
    expect(existsSync(installDir)).toBe(true)
    await deletePlugin(db, p.id, opts())
    expect(await listPlugins(db)).toHaveLength(0)
    expect(existsSync(installDir)).toBe(false)
  })

  test('delete missing → NotFoundError', async () => {
    await expect(deletePlugin(db, 'no-such-id', opts())).rejects.toBeInstanceOf(NotFoundError)
  })

  test('delete still-referenced → ConflictError with referencedBy list', async () => {
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
      await deletePlugin(db, p.id, opts())
      throw new Error('expected ConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      const e = err as ConflictError
      expect(e.code).toBe('plugin-still-referenced')
      expect(e.details).toEqual(
        expect.objectContaining({ referencedBy: [{ id: expect.any(String), name: 'consumer' }] }),
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

  test('rename cascades into agents.plugins JSON column', async () => {
    const p = await createPlugin(db, { name: 'old-name', spec: 's@1' }, opts())
    // seed an unrelated plugin to assert non-matching names survive untouched
    await createPlugin(db, { name: 'other', spec: 'o@1' }, opts())

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
    expect(a?.plugins).toEqual(['new-name', 'other'])
  })

  test('findAgentsReferencingPlugin: LIKE prefilter + exact dedupe (prefix collision)', async () => {
    await createPlugin(db, { name: 'dd', spec: 's@1' }, opts())
    await createPlugin(db, { name: 'dd-trace', spec: 's@2' }, opts())
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
    // Looking up 'dd' must NOT return the agent that only has 'dd-trace'.
    const refs = await findAgentsReferencingPlugin(db, 'dd')
    expect(refs).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Regression: bare `npm` PATH resolution on Windows.
//
// On Windows npm ships as `npm.cmd`; `spawn('npm', ...)` without a shell does
// not consult PATHEXT, so a bare `npm` ENOENTs even when `npm.cmd` is on PATH.
// pluginInstaller.runCommand appends `.cmd` for bare names on win32 to fix
// this (otherwise probeNpmBinary() -> false -> NpmUnavailableError and every
// plugin install on Windows returns 422). These tests lock that resolution by
// relying on the *default* `npmBin` (no override) + a PATH-injected fake npm,
// which only succeeds if runCommand can find `npm`/`npm.cmd` from PATH.
// ─────────────────────────────────────────────────────────────────────────────
describe('services/plugin.ts bare-npm PATH resolution (no npmBin override)', () => {
  let originalPath: string | undefined

  beforeEach(() => {
    // Outer beforeEach already created the fake-npm shim under pluginsDir.
    const npmDir = join(pluginsDir, 'fake-npm-bin')
    originalPath = process.env.PATH
    process.env.PATH = `${npmDir}${delimiter}${process.env.PATH ?? ''}`
    resetNpmProbeCacheForTests()
    process.env.FAKE_NPM_MODE = 'success'
    process.env.FAKE_NPM_VERSION = '3.2.1'
  })

  afterEach(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    delete process.env.FAKE_NPM_VERSION
  })

  test('probeNpmBinary finds npm on PATH (npm.cmd on Windows)', async () => {
    const ok = await probeNpmBinary()
    expect(ok).toBe(true)
  })

  test('createPlugin without npmBin override installs via PATH-resolved npm', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const p = await createPlugin(db, { name: 'pathonly', spec: 'pkg@3' }, { pluginsDir })
    expect(p.resolvedVersion).toBe('3.2.1')
    expect(existsSync(p.cachedPath)).toBe(true)
  })
})
