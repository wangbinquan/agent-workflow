// RFC-201 T10.2 — immutable Plugin generations and full-row publication CAS.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, plugins, tasks, workflows } from '../src/db/schema'
import { createPlugin, getPlugin, reinstallPlugin, updatePlugin } from '../src/services/plugin'
import { runPluginGenerationGc } from '../src/services/pluginGenerationGc'
import {
  checkForUpdate,
  garbageCollectPluginGenerations,
  PLUGIN_GENERATION_MANIFEST,
  readGenerationManifestForCachedPath,
  resetNpmProbeCacheForTests,
} from '../src/services/pluginInstaller'
import { pluginOperationConfigHashOf } from '../src/services/pluginOperationRevision'
import { ConflictError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.sh')

let db: DbClient
let pluginsDir = ''

const deps = () => ({ pluginsDir, npmBin: FAKE_NPM })

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc201-plugin-'))
  process.env.FAKE_NPM_MODE = 'success'
  process.env.FAKE_NPM_VERSION = '1.0.0'
  delete process.env.FAKE_NPM_COMMIT
  delete process.env.FAKE_NPM_COUNTER_FILE
  resetNpmProbeCacheForTests()
})

afterEach(async () => {
  await rm(pluginsDir, { recursive: true, force: true })
  delete process.env.FAKE_NPM_MODE
  delete process.env.FAKE_NPM_VERSION
  delete process.env.FAKE_NPM_COMMIT
  delete process.env.FAKE_NPM_COUNTER_FILE
})

describe('immutable generation publication', () => {
  test('same-version reinstall publishes a distinct cachedPath and exact hash', async () => {
    const created = await createPlugin(db, { name: 'same', spec: 'same@1' }, deps())
    const first = await reinstallPlugin(db, created.id, deps())
    const second = await reinstallPlugin(db, created.id, deps())
    expect(first.resolvedVersion).toBe(second.resolvedVersion)
    expect(first.cachedPath).not.toBe(second.cachedPath)
    expect(pluginOperationConfigHashOf(first)).not.toBe(pluginOperationConfigHashOf(second))
    expect(existsSync(first.cachedPath)).toBe(true)
    expect(existsSync(second.cachedPath)).toBe(true)
  })

  test('failed install never changes the current DB/cache generation', async () => {
    const created = await createPlugin(db, { name: 'safe', spec: 'safe@1' }, deps())
    process.env.FAKE_NPM_MODE = 'fail'
    await expect(updatePlugin(db, created.id, { spec: 'safe@2' }, deps())).rejects.toThrow()
    const current = await getPlugin(db, created.id)
    expect(current?.cachedPath).toBe(created.cachedPath)
    expect(current?.spec).toBe(created.spec)
    expect(existsSync(created.cachedPath)).toBe(true)
  })

  test('full-row null-safe CAS rejects a bypass writer before publication', async () => {
    const created = await createPlugin(db, { name: 'cas', spec: 'cas@1' }, deps())
    let preparedPath = ''
    try {
      await updatePlugin(
        db,
        created.id,
        { spec: 'cas@2' },
        {
          ...deps(),
          beforePublish: async (_captured, prepared) => {
            preparedPath = prepared.cachedPath
            await db
              .update(plugins)
              .set({
                name: 'foreign-name',
                spec: 'foreign@9',
                description: 'foreign',
                cachedPath: '/foreign/current',
              })
              .where(eq(plugins.id, created.id))
          },
        },
      )
      throw new Error('expected stale CAS')
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).code).toBe('resource-operation-stale')
    }
    const current = await getPlugin(db, created.id)
    expect(current?.name).toBe('foreign-name')
    expect(current?.spec).toBe('foreign@9')
    expect(current?.description).toBe('foreign')
    expect(current?.cachedPath).toBe('/foreign/current')
    expect(existsSync(preparedPath)).toBe(false)
    expect(existsSync(created.cachedPath)).toBe(true)
  })
})

describe('source identity update checks', () => {
  test('same package version at a new Git commit is update-ready', async () => {
    process.env.FAKE_NPM_COMMIT = '1111111111111111111111111111111111111111'
    const created = await createPlugin(db, { name: 'git-source', spec: 'github:org/repo' }, deps())
    process.env.FAKE_NPM_COMMIT = '2222222222222222222222222222222222222222'
    const checked = await checkForUpdate(created.id, created.spec, created.cachedPath, deps())
    expect(checked.identityStatus).toBe('known')
    expect(checked.available).toBe(true)
    expect(checked.latest).toBe('222222222222')
  })

  test('legacy cachedPath without manifest fails closed as identity unknown', async () => {
    const created = await createPlugin(db, { name: 'legacy', spec: 'legacy@1' }, deps())
    const generationDir = dirname(dirname(created.cachedPath))
    await unlink(join(generationDir, PLUGIN_GENERATION_MANIFEST))
    expect(await readGenerationManifestForCachedPath(created.cachedPath)).toBeNull()
    const checked = await checkForUpdate(created.id, created.spec, created.cachedPath, deps())
    expect(checked).toEqual({ available: false, latest: '1.0.0', identityStatus: 'unknown' })
  })

  test('incomplete or mismatched generation manifest fails closed as identity unknown', async () => {
    const created = await createPlugin(db, { name: 'corrupt-manifest', spec: 'manifest@1' }, deps())
    const generationDir = dirname(dirname(created.cachedPath))
    const manifestPath = join(generationDir, PLUGIN_GENERATION_MANIFEST)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    delete manifest.integrity
    await writeFile(manifestPath, JSON.stringify(manifest))
    expect(await readGenerationManifestForCachedPath(created.cachedPath)).toBeNull()
    expect(await checkForUpdate(created.id, created.spec, created.cachedPath, deps())).toEqual({
      available: false,
      latest: '1.0.0',
      identityStatus: 'unknown',
    })
  })
})

describe('generation GC safety', () => {
  test('keeps referenced generation, removes only aged orphan and crashed check dir', async () => {
    const created = await createPlugin(db, { name: 'kept', spec: 'kept@1' }, deps())
    const orphan = join(pluginsDir, 'orphan-id', 'generations', 'orphan-op')
    const crashedCheck = join(pluginsDir, '.check-crashed')
    await mkdir(orphan, { recursive: true })
    await mkdir(crashedCheck, { recursive: true })
    await writeFile(join(orphan, 'partial'), 'x')
    const now = Date.now() + 60_000
    const removed = await garbageCollectPluginGenerations({
      pluginsDir,
      referencedCachedPaths: new Set([created.cachedPath]),
      graceMs: 1,
      now,
    })
    expect(removed).toContain(orphan)
    expect(removed).toContain(crashedCheck)
    expect(existsSync(created.cachedPath)).toBe(true)
  })

  test('periodic GC retains every aged orphan while any node run is non-terminal', async () => {
    const orphan = join(pluginsDir, 'orphan-id', 'generations', 'orphan-op')
    await mkdir(orphan, { recursive: true })
    const workflowId = ulid()
    const taskId = ulid()
    const nodeRunId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'gc-active-workflow',
      definition: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'gc-active-task',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/repo',
      worktreePath: '/worktree',
      baseBranch: 'main',
      branch: 'task/gc-active',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await db.insert(nodeRuns).values({ id: nodeRunId, taskId, nodeId: 'agent', status: 'running' })

    const now = Date.now() + 60_000
    expect(await runPluginGenerationGc({ db, pluginsDir, graceMs: 1, now })).toEqual([])
    expect(existsSync(orphan)).toBe(true)

    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, nodeRunId))
    expect(await runPluginGenerationGc({ db, pluginsDir, graceMs: 1, now })).toContain(orphan)
    expect(existsSync(orphan)).toBe(false)
  })

  test('generation manifest is complete and ties entry to source identity', async () => {
    const created = await createPlugin(db, { name: 'manifest', spec: 'manifest@1' }, deps())
    const manifest = await readGenerationManifestForCachedPath(created.cachedPath)
    expect(manifest).toEqual(
      expect.objectContaining({
        pluginId: created.id,
        sourceKind: 'npm',
        requestedSpec: 'manifest@1',
        completed: true,
        sourceIdentity: expect.stringContaining('npm:https://registry.example.test/'),
      }),
    )
    const generationDir = dirname(dirname(created.cachedPath))
    expect(
      JSON.parse(await readFile(join(generationDir, PLUGIN_GENERATION_MANIFEST), 'utf-8')),
    ).toEqual(manifest)
  })
})

describe('production coordinator callsite ratchet', () => {
  test('Plugin mutations, Check/Upgrade, create, and generic ACL use the stable id fence', async () => {
    const route = await readFile(
      resolve(import.meta.dir, '..', 'src', 'routes', 'plugins.ts'),
      'utf8',
    )
    const service = await readFile(
      resolve(import.meta.dir, '..', 'src', 'services', 'plugin.ts'),
      'utf8',
    )
    expect(route.match(/pluginOperationCoordinator\.runExclusive/g)?.length).toBeGreaterThanOrEqual(
      6,
    )
    expect(route).toContain('runDeduplicatedOperation<PluginUpdateCheck>')
    expect(route).toContain('loadById: (db, resourceId) => getPluginById(db, resourceId)')
    expect(service).toContain('pluginOperationCoordinator.runExclusive(id')
    expect(route).toContain("'resource-operation-stale'")
  })
})
