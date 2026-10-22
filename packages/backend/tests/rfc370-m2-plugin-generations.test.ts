// Immutable material survives restarts and lost CS replies. RFC-370 v3 V6:
// generation files and manifests are `plugin-generation` publications scoped
// to the generation (registered in one journal transaction, no per-file JSON
// rewrite); retirement releases the scope with the generation row and the
// hosted object maintenance job unpins them.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createHostedBackupReleaseHorizon } from '@/modules/system-operations/infrastructure/crewstation/backupReleaseHorizon'
import { createHostedObjectPublications } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { createHostedPluginGenerations } from '@/modules/resource-catalog/infrastructure/crewstation/pluginGenerations'
import { assertHostedPluginPublicationInTx } from '@/modules/resource-catalog/infrastructure/crewstation/pluginPublication'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { validatePluginMaterialTree } from '@/modules/resource-catalog/infrastructure/crewstation/pluginMaterialTree'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

// Wall-clock allowance, not tolerance for a slower implementation: these
// cases take 14–28 ms on SQLite and ~350 ms on PostgreSQL, but CI run
// 39000900443 (shard 6/24) hit a ~15 s runner stall in which the same SQLite
// cases took 1–5.7 s and two crossed bun's default 5000 ms (the PostgreSQL
// variants right after ran at normal speed). See docs/dev-gotchas.md on tests
// that need an explicit budget under shared-runner load.
setDefaultTimeout(15_000)

describeEachProvider('RFC-370 durable hosted plugin generations', (harness) => {
  const fixture = () => {
    const f = objectFixture()
    const bytes = Buffer.from('export default 37')
    const calls: string[] = []
    let held = true,
      failRelease = false,
      writer = false
    let retained: readonly string[] = []
    let epoch = 1
    let retentionReads = 0
    let retainAfterScan: string | null = null
    const helper: WorkspaceHelper = {
      async call<T>(_task: string, operation: string, input: unknown) {
        expect(operation).toBe('plugin-installation')
        const request = input as { method: string; generationId: string }
        calls.push(request.method)
        if (request.method === 'discard') {
          if (writer) throw new Error('writer-not-settled')
          return null as T
        }
        return {
          sourceKind: 'npm',
          resolvedVersion: '1.0.0',
          sourceIdentity: 'npm:immutable-1',
          root: '/work/plugins/plugin/generations/' + request.generationId,
          entry: 'node_modules/fixture',
          files: [
            {
              kind: 'file',
              path: 'node_modules/fixture/index.js',
              sha256: sha256Hex(bytes),
              size: bytes.length,
              mode: 0o755,
            },
            { kind: 'symlink', path: 'node_modules/.bin/fixture', target: '../fixture/index.js' },
          ],
        } as T
      },
    }
    const fence = {
      current: () => ({ epoch, leaseId: `lease-${epoch}`, instanceId: 'instance' }),
      assertHeld: async () => {
        if (!held) throw new Error('fence lost')
      },
    }
    const journal = createHostedObjectPublications({
      db: harness.db,
      fence,
      objects: {
        ...f.objects,
        async release(reference, object) {
          await f.objects.release(reference, object)
          if (failRelease) {
            failRelease = false
            throw new Error('release reply lost')
          }
        },
      },
    })
    const create = () =>
      createHostedPluginGenerations({
        db: harness.db,
        fence,
        helper,
        objects: f.objects,
        publications: journal.publications,
        reference: (_task, path) => path,
        openFile: async () => new Response(bytes).body!,
        retainedReferences: async () => {
          retentionReads++
          return retainAfterScan && retentionReads > 1 ? [retainAfterScan] : retained
        },
      })
    return {
      ...f,
      create,
      settle: () =>
        journal
          .maintenance({ horizon: createHostedBackupReleaseHorizon({ db: harness.db }) })
          .run(),
      calls,
      loseFence: () => {
        held = false
      },
      loseRelease: () => {
        failRelease = true
      },
      writer: (value: boolean) => {
        writer = value
      },
      retain: (value: readonly string[]) => {
        retained = value
      },
      advanceLease: () => {
        epoch++
      },
      retainAfterScan: (reference: string) => {
        retentionReads = 0
        retainAfterScan = reference
      },
    }
  }

  test('lost pin reply retries the same objects and cold reads preserve dependency entry, modes and links', async () => {
    const f = fixture()
    f.losePinReply()
    await expect(f.create().installGeneration('plugin', 'fixture@1', 'gen')).rejects.toThrow(
      'pin reply lost',
    )
    const { pluginArtifactGenerations, hostedObjectPublications } = tablesOf(harness.db)
    const installing = (await harness.db.select().from(pluginArtifactGenerations))[0]!
    expect(installing).toMatchObject({ state: 'installing', objectId: null })
    expect(installing.installedJson).not.toBeNull()
    expect(
      (await harness.db.select().from(hostedObjectPublications)).map((row) => row.state),
    ).toEqual(['pending'])
    const publication = await f.create().installGeneration('plugin', 'fixture@1', 'gen')
    const manifest = await f.create().read(publication.cachedPath)
    expect(manifest.entry).toBe('node_modules/fixture')
    expect(manifest.files[0]!.kind).toBe('file')
    if (manifest.files[0]!.kind === 'file') expect(manifest.files[0]!.mode).toBe(0o755)
    expect(manifest.files[1]).toEqual({
      kind: 'symlink',
      path: 'node_modules/.bin/fixture',
      target: '../fixture/index.js',
    })
    const installs = f.calls.length
    expect(await f.create().installGeneration('plugin', 'fixture@1', 'gen')).toEqual(publication)
    expect(f.calls.length).toBe(installs)
    expect(f.pins).toHaveLength(2)
    await expect(f.create().installGeneration('plugin', 'fixture@2', 'gen')).rejects.toThrow(
      'request-changed',
    )
    f.tamper('body')
    await expect(f.create().read(publication.cachedPath)).rejects.toThrow()
  })

  test('current and journal-referenced generations survive GC; lost release acknowledgement resumes from the database', async () => {
    const f = fixture()
    const publication = await f.create().installGeneration('plugin', 'fixture@1', 'gen')
    const reference = f.create().generationReference('plugin', 'gen')
    const { plugins, pluginArtifactGenerations, hostedObjectPublications } = tablesOf(harness.db)
    await insertOne(harness.db, plugins, {
      id: 'plugin',
      name: 'Plugin',
      spec: 'fixture@1',
      sourceKind: 'npm',
      cachedPath: publication.cachedPath,
      installedAt: 1,
    })
    await expect(f.create().discard(reference)).rejects.toThrow('in-use')
    expect(f.calls).toEqual(['install'])
    await harness.db.delete(plugins).where(eq(plugins.id, 'plugin'))
    f.retain([reference])
    expect(
      await f
        .create()
        .gc.collect({ referencedCachedPaths: new Set(), graceMs: 0, now: Date.now() + 1 }),
    ).toEqual([])
    f.retain([])
    f.writer(true)
    await expect(f.create().discard(reference)).rejects.toThrow('writer-not-settled')
    expect(f.releases).toHaveLength(0)
    expect((await harness.db.select().from(pluginArtifactGenerations))[0]!.state).toBe('releasing')
    f.writer(false)
    await f.create().discard(reference)
    expect((await harness.db.select().from(pluginArtifactGenerations))[0]!.state).toBe('retired')
    // Retirement only released the scope; maintenance unpins and a lost reply
    // is retried on a later pass.
    expect(f.releases).toHaveLength(0)
    f.loseRelease()
    expect(await f.settle()).toMatchObject({ failures: 1 })
    await harness.db.update(hostedObjectPublications).set({ nextAttemptAt: 0 })
    await f.settle()
    expect(f.releases).toHaveLength(2)
    await expect(f.create().read(publication.cachedPath)).rejects.toThrow('not-ready')
    await expect(f.create().installGeneration('plugin', 'fixture@1', 'gen')).rejects.toThrow(
      'retired',
    )
  })

  test('lost authority prevents generation publication; externally managed plugins are never installed by update checks', async () => {
    const f = fixture()
    await expect(
      f.create().installer.checkForUpdate('plugin', 'file:/work/source', 'external'),
    ).rejects.toThrow('externally managed')
    expect(f.calls).toEqual([])
    f.loseFence()
    await expect(f.create().installGeneration('plugin', 'fixture@1', 'gen')).rejects.toThrow(
      'fence lost',
    )
    const { pluginArtifactGenerations, hostedObjectPublications } = tablesOf(harness.db)
    expect(await harness.db.select().from(pluginArtifactGenerations)).toHaveLength(0)
    expect(await harness.db.select().from(hostedObjectPublications)).toHaveLength(0)
    expect(f.pins).toHaveLength(0)
  })

  test('cold GC reconciles pre-index pins without rerunning installation and never reaps the active lease installer', async () => {
    const f = fixture()
    f.losePinReply()
    await expect(f.create().installGeneration('plugin', 'fixture@1', 'gen')).rejects.toThrow(
      'pin reply lost',
    )
    const request = { referencedCachedPaths: new Set<string>(), graceMs: 0, now: Date.now() + 1000 }
    expect(await f.create().gc.collect(request)).toEqual([])
    f.advanceLease()
    expect(await f.create().gc.collect(request)).toEqual(['cs-plugin:plugin/gen'])
    expect(f.calls).toEqual(['install', 'discard'])
    const { pluginArtifactGenerations } = tablesOf(harness.db)
    expect((await harness.db.select().from(pluginArtifactGenerations))[0]!.state).toBe('retired')
    // The interrupted upload's pin is found by replaying its request without bytes.
    await f.settle()
    expect(f.pins).toHaveLength(1)
    expect(f.releases).toEqual(f.pins)
    await expect(f.create().installGeneration('plugin', 'fixture@1', 'gen')).rejects.toThrow(
      'retired',
    )
  })

  test('GC rechecks journals in its claim transaction and publication rejects a generation after retirement begins', async () => {
    const f = fixture()
    const publication = await f.create().installGeneration('plugin', 'fixture@1', 'gen')
    f.retainAfterScan('cs-plugin:plugin/gen')
    expect(
      await f
        .create()
        .gc.collect({ referencedCachedPaths: new Set(), graceMs: 0, now: Date.now() + 1000 }),
    ).toEqual([])
    const { pluginArtifactGenerations } = tablesOf(harness.db)
    expect((await harness.db.select().from(pluginArtifactGenerations))[0]!.state).toBe('ready')
    expect(f.releases).toHaveLength(0)
    await databaseSessionFor(harness.db).transaction((tx) =>
      assertHostedPluginPublicationInTx(tx, 'plugin', publication.cachedPath),
    )
    f.writer(true)
    await expect(f.create().discard('cs-plugin:plugin/gen')).rejects.toThrow('writer-not-settled')
    await expect(
      databaseSessionFor(harness.db).transaction((tx) =>
        assertHostedPluginPublicationInTx(tx, 'plugin', publication.cachedPath),
      ),
    ).rejects.toThrow('not-ready')
    await expect(
      databaseSessionFor(harness.db).transaction((tx) =>
        assertHostedPluginPublicationInTx(tx, 'different', publication.cachedPath),
      ),
    ).rejects.toThrow('owner-mismatch')
    expect(f.releases).toHaveLength(0)
  })
})

test('plugin tree rejects link cycles, missing targets, path aliasing and writes through symlink ancestors', () => {
  for (const files of [
    [
      { kind: 'symlink' as const, path: 'a', target: 'b' },
      { kind: 'symlink' as const, path: 'b', target: 'a' },
    ],
    [{ kind: 'symlink' as const, path: 'a', target: '../../outside' }],
    [{ kind: 'symlink' as const, path: 'a', target: 'missing' }],
    [
      { kind: 'symlink' as const, path: 'a', target: 'b' },
      { kind: 'file' as const, path: 'a/child' },
      { kind: 'file' as const, path: 'b' },
    ],
    [{ kind: 'file' as const, path: 'a/../b' }],
  ])
    expect(() => validatePluginMaterialTree(files, '.')).toThrow()
})
