import { createFileSkillContentBinding } from '@/modules/resource-catalog/infrastructure/local/fileSkillContentBinding'
import { conversion as contentConversion } from '@/platform/content/migration'
import { contentLookups, frozenValues } from './helpers/rfc395V2/contentFixtures'
// RFC-395 X: native bytes, explicit tree locations and ordinary operation recovery survive the switch.
import { setDefaultTimeout, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { contentRefColumns } from '@/platform/content/contentStore'
import { createDatabaseSkillContent } from '@/modules/resource-catalog/infrastructure/databaseSkillContent'
import {
  createSkillContentLocationQuery,
  readTree,
  hashSkillTree,
  skillTreeColumns,
  writeTree,
  copyTree,
  deleteTree,
  renameTree,
  treeExists,
} from '@/modules/resource-catalog/infrastructure/databaseSkillTrees'
import { createManagedSkillWithFiles } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  commitSkillVersion,
  stageSkillVersion,
  commitSkillVersionInTx,
  backfillLegacySkillVersions,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import {
  beginOperation,
  advancePhase,
  getActiveOp,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { createSkillCatalogBootAdapter } from '@/modules/resource-catalog/infrastructure/skillCatalogBootAdapter'
import { selectSkillContentDependencies } from '@/modules/resource-catalog/composition/skillContentBinding'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []
afterEach(() => {
  resetSkillBootVerifyForTest()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describeEachProvider('RFC-395 skill target recovery', (harness) => {
  test('live/version/staging/trash copy and rename preserve inline and external bytes', async () => {
    const skillId = ulid()
    const files = [
      { path: 'SKILL.md', bytes: new Uint8Array([239, 187, 191, 65]) },
      { path: 'invalid.bin', bytes: new Uint8Array([255, 0, 192, 128]) },
      { path: 'empty', bytes: new Uint8Array() },
      { path: 'large.bin', bytes: new Uint8Array(70_000).fill(255) },
    ]
    await harness.session.transaction(async (tx) => {
      const { skills } = tablesOf(tx)
      await tx.insert(skills).values({
        id: skillId,
        name: skillId,
        description: '',
        ...skillTreeColumns(skillId, 'live', 'database-bytes'),
        createdAt: 1,
        updatedAt: 1,
      })
      await writeTree(tx, skillId, 'live', files, 1)
      await copyTree(tx, skillId, 'live', 'version:1', 2)
      await copyTree(tx, skillId, 'live', 'staging:operation', 3)
      await renameTree(tx, skillId, 'staging:operation', 'trash:operation|live')
    })
    for (const tree of ['live', 'version:1', 'trash:operation|live']) {
      const actual = new Map(
        (await readTree(harness.db, skillId, tree)).map((entry) => [entry.path, entry.bytes]),
      )
      for (const file of files) expect(actual.get(file.path)).toEqual(file.bytes)
    }
    const { skillContentEntries } = tablesOf(harness.db)
    const rows = await harness.db
      .select()
      .from(skillContentEntries)
      .where(eq(skillContentEntries.tree, 'live'))
    expect(
      rows
        .map((row) => contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)!.kind)
        .sort(),
    ).toEqual(['database-bytes', 'inline', 'inline', 'inline'])
    const { contentObjects, contentBytes } = tablesOf(harness.db)
    expect(await harness.db.select().from(contentObjects)).toHaveLength(1)
    expect(await harness.db.select().from(contentBytes)).toHaveLength(1)
    const largeRows = await harness.db
      .select()
      .from(skillContentEntries)
      .where(eq(skillContentEntries.path, 'large.bin'))
    expect(new Set(largeRows.map((row) => JSON.parse(row.contentRefJson).contentId)).size).toBe(1)
    const query = createSkillContentLocationQuery(harness.db)
    expect(
      await query.locate(skillId, {
        kind: 'trash',
        operationId: 'operation',
        original: { kind: 'live' },
      }),
    ).toMatchObject({
      kind: 'database-bytes',
      location: { value: { skillId, tree: 'trash:operation|live' } },
    })
    expect(await query.locate(skillId, { kind: 'staging', operationId: 'operation' })).toBeNull()
    // Entry bytes alone do not invent a committed version row.
    expect((await query.publication(skillId, 1))?.snapshot).toBeNull()
    expect(await query.publication('deleted', 1)).toBeNull()
  })

  for (const profile of ['database', 'local'] as const) {
    test(`${profile}: a committed version crash recovers from its exact snapshot and keeps historical bytes`, async () => {
      const appHome = mkdtempSync(join(tmpdir(), 'aw-skill-target-'))
      roots.push(appHome)
      const database = createDatabaseSkillContent({ db: harness.db })
      const options =
        profile === 'database' ? selectSkillContentDependencies(database, appHome) : { appHome }
      const main = new Uint8Array([
        239,
        187,
        191,
        ...Buffer.from('---\nname: target\ndescription: target\n---\ninitial\n'),
      ])
      const binary = new Uint8Array([255, 0, 128])
      const skill = await createManagedSkillWithFiles(
        harness.db,
        options,
        { name: `target-${profile}`, description: 'target' },
        {
          kind: 'files',
          mainContent: main,
          files: [
            { path: 'invalid.bin', content: binary },
            { path: 'empty', content: new Uint8Array() },
          ],
        },
      )
      const next = Buffer.from('---\nname: target\ndescription: target\n---\nnext\n')
      await expect(
        commitSkillVersion(
          harness.db,
          options,
          skill.id,
          { kind: 'write-main', content: next },
          {
            source: 'editor',
            authorUserId: null,
            __afterDbCommitForTest() {
              throw new Error('crash-before-live')
            },
          },
        ),
      ).rejects.toThrow('crash-before-live')
      const query = createSkillContentLocationQuery(harness.db)
      expect(await query.publication(skill.id, 2)).toMatchObject({
        contentVersion: 2,
        snapshot: { version: 2 },
      })
      expect((await query.publication(skill.id, 3))?.snapshot).toBeNull()
      expect(await getActiveOp(harness.db, skill.id)).toMatchObject({
        kind: 'version-write',
        phase: 'db-committed',
      })
      const boot = createSkillCatalogBootAdapter({ db: harness.db, ...options })
      expect(await boot.recoverOperations()).toMatchObject({ rolledForward: 1 })
      expect(await getActiveOp(harness.db, skill.id)).toBeNull()
      expect(await boot.reverifySnapshots()).toMatchObject({ verified: 1, quarantined: 0 })
      if (profile === 'database') {
        expect(await database.versionReader.readTree({ skillId: skill.id, version: 1 })).toEqual(
          new Map([
            ['SKILL.md', main],
            ['empty', new Uint8Array()],
            ['invalid.bin', binary],
          ]),
        )
        expect(
          await database.content.readMain({ id: skill.id, name: skill.name, contentVersion: 2 }),
        ).toEqual(next)
      }
      expect('runIdentityMigrationBarrier' in boot).toBe(false)
      expect('backfillLegacyVersions' in boot).toBe(false)
      await expect(backfillLegacySkillVersions(harness.db, options)).rejects.toThrow(
        'skill-legacy-upgrade-requires-conversion',
      )
    })
  }

  test('ordinary reconciliation restores missing live bytes from the committed snapshot without legacy backfill', async () => {
    const database = createDatabaseSkillContent({ db: harness.db })
    const options = selectSkillContentDependencies(database, 'unused')
    const bytes = new Uint8Array([239, 187, 191, ...Buffer.from('retained snapshot')])
    const skill = await createManagedSkillWithFiles(
      harness.db,
      options,
      { name: 'reconcile', description: '' },
      { kind: 'main', content: bytes },
    )
    await harness.session.transaction((tx) => deleteTree(tx, skill.id, 'live'))
    expect(await treeExists(harness.db, skill.id, 'live')).toBe(false)
    await createSkillCatalogBootAdapter({ db: harness.db, ...options }).reconcileLiveFiles()
    expect(await treeExists(harness.db, skill.id, 'live')).toBe(true)
    expect(
      await database.content.readMain({ id: skill.id, name: skill.name, contentVersion: 1 }),
    ).toEqual(bytes)
    expect(await database.versionReader.readTree({ skillId: skill.id, version: 1 })).toEqual(
      new Map([['SKILL.md', bytes]]),
    )
  })

  test('an uncommitted staged version rolls back without deleting the live or prior snapshot', async () => {
    const database = createDatabaseSkillContent({ db: harness.db })
    const options = selectSkillContentDependencies(database, 'unused')
    const skill = await createManagedSkillWithFiles(
      harness.db,
      options,
      { name: 'rollback', description: '' },
      { kind: 'main', content: Buffer.from('original') },
    )
    const staged = await stageSkillVersion(
      harness.db,
      options,
      skill.id,
      { kind: 'write-main', content: Buffer.from('candidate') },
      { source: 'editor', authorUserId: null },
    )
    await expect(
      harness.session.transaction(async (tx) => {
        await commitSkillVersionInTx(tx, staged, { source: 'editor', authorUserId: null })
        throw new Error('rollback-database')
      }),
    ).rejects.toThrow('rollback-database')
    expect(
      await createSkillCatalogBootAdapter({ db: harness.db, ...options }).recoverOperations(),
    ).toMatchObject({ rolledBack: 1 })
    const query = createSkillContentLocationQuery(harness.db)
    expect((await query.publication(skill.id, 2))?.snapshot).toBeNull()
    expect((await query.publication(skill.id, 1))?.contentVersion).toBe(1)
    expect(
      await database.content.readMain({ id: skill.id, name: skill.name, contentVersion: 1 }),
    ).toEqual(Buffer.from('original'))
    expect(
      contentRefColumns.decode(
        (await harness.db.select().from(tablesOf(harness.db).skills))[0]!.contentRefJson,
        null,
      ),
    ).toMatchObject({
      kind: 'database-bytes',
      location: { value: { skillId: skill.id, tree: 'live' } },
    })
  })
})

// X2: run B's real converter and hydrate its output into a native target database.
import {
  createSkillBootConversion,
  type SkillBootContentConverter,
} from '@/modules/resource-catalog/infrastructure/migration/skillBootRules'
import { skillBootEnvironment } from '@/modules/resource-catalog/infrastructure/migration/skillBootFacts'
import { convertFrozenSkillContent } from '@/platform/content/migration/skillContent'
import { createBootUpgradeFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { describeV2Providers, emptyV2Content } from './helpers/rfc395V2Harness'

import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { createTestDb } from './helpers/testDatabase'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'

// Slowest case took 4.50 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

const frozenConverter: SkillBootContentConverter = convertFrozenSkillContent

describeV2Providers('RFC-395 X2 converted skill runtime-reader parity', (source) => {
  test.each([
    ['local-file', 'initial'],
    ['local-file', 'existing'],
    ['database-bytes', 'initial'],
    ['database-bytes', 'existing'],
  ] as const)(
    '%s %s frozen bytes remain readable after live mutation and deletion',
    async (profile, history) => {
      await source.install()
      const root = mkdtempSync(join(tmpdir(), 'aw-converted-skill-'))
      roots.push(root)
      const files = [
        {
          path: 'SKILL.md',
          bytes: Buffer.from('\ufeff---\nname: frozen\ndescription: exact\n---\noriginal\r\n'),
        },
        { path: 'raw.bin', bytes: new Uint8Array([255, 0, 192, 128]) },
        { path: 'empty.bin', bytes: new Uint8Array() },
      ]
      await source.write('skills', [
        frozenValues('skills', {
          id: 'frozen',
          name: 'legacy',
          managed_path:
            profile === 'database-bytes' ? 'database:skill_content_entries' : 'skills/legacy/files',
          reservation_state: 'ready',
          version_state: history === 'initial' ? 'legacy-unbackfilled' : 'snapshot-authoritative',
          content_version: history === 'initial' ? 0 : 1,
        }),
      ])
      if (history === 'existing')
        await source.write('skill_versions', [
          frozenValues('skill_versions', {
            id: 'original-v1',
            skill_id: 'frozen',
            version_index: 1,
            files_path:
              profile === 'database-bytes'
                ? 'database:skill_content_entries'
                : 'skills/legacy/versions/v1/files',
            content_hash: hashSkillTree(files),
            source: 'initial',
          }),
        ])
      if (profile === 'database-bytes')
        await source.write(
          'skill_content_entries',
          (history === 'existing' ? ['live', 'version:1'] : ['live']).flatMap((tree) =>
            files.map((file) =>
              frozenValues('skill_content_entries', {
                skill_id: 'frozen',
                tree,
                path: file.path,
                encoding: 'base64',
                content: Buffer.from(file.bytes).toString('base64'),
                size: file.bytes.length,
              }),
            ),
          ),
        )
      else {
        for (const tree of history === 'existing' ? ['files', 'versions/v1/files'] : ['files']) {
          mkdirSync(join(root, 'skills/legacy', tree), { recursive: true })
          for (const file of files)
            writeFileSync(join(root, 'skills/legacy', tree, file.path), file.bytes)
        }
      }
      const input = await source.input([
        createSkillBootConversion(frozenConverter),
        contentConversion,
        contentLookups(),
      ])
      const target = await createTestDb(
        input.preflight.fingerprint.provider === 'postgresql'
          ? {
              provider: 'postgresql',
              urlEnv: process.env.AW_TEST_POSTGRESQL_URL
                ? 'AW_TEST_POSTGRESQL_URL'
                : 'RFC357_DATABASE_URL',
            }
          : { provider: 'sqlite' },
      )
      try {
        const capture: BootUpgradeCaptureInput = {
          stage: 'freeze',
          source: {
            reader: input.source,
            preflight: input.preflight,
            preUpgrade: null,
            watermark: input.preflight.watermark,
            evidenceRoot: null,
            close: async () => {},
          },
          content: emptyV2Content,
          root: { kind: 'app-home', root, runsSupplied: false, objects: 'none' },
          manifest: {
            version: 1,
            roots: [],
            files: [],
            objects: [],
            databaseTrees: [],
            digest: valueDigest([]),
          },
          readArtifact: async () => null,
          writeArtifact: async () => {},
        }
        const facts = createBootUpgradeFacts(await skillBootEnvironment().capture(capture))
        const sink = new V2MemorySink()
        expect((await runConversion({ ...input, bootUpgradeFacts: facts }, sink)).blocks).toEqual(
          [],
        )
        const { contentObjects, contentBytes, skills, skillVersions, skillContentEntries } =
          tablesOf(target.db)
        // Insert B and X's complete rows, preserving every emitted column.
        const targetRow = <T>(row: Record<string, unknown>): T =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
              value instanceof Uint8Array ? Buffer.from(value) : value,
            ]),
          ) as T
        await target.session.transaction(async (tx) => {
          for (const row of sink.rows('content_objects'))
            await tx
              .insert(contentObjects)
              .values(targetRow<typeof contentObjects.$inferInsert>(row))
          for (const row of sink.rows('content_bytes'))
            await tx.insert(contentBytes).values(targetRow<typeof contentBytes.$inferInsert>(row))
          for (const row of sink.rows('skills'))
            await tx.insert(skills).values(targetRow<typeof skills.$inferInsert>(row))
          for (const row of sink.rows('skill_versions'))
            await tx.insert(skillVersions).values(targetRow<typeof skillVersions.$inferInsert>(row))
          for (const row of sink.rows('skill_content_entries'))
            await tx
              .insert(skillContentEntries)
              .values(targetRow<typeof skillContentEntries.$inferInsert>(row))
        })
        const content =
          profile === 'local-file'
            ? createFileSkillContentBinding(target.db, root)
            : createDatabaseSkillContent({ db: target.db })
        const reference = { id: 'frozen', name: 'legacy', contentVersion: 1 }
        expect(await content.content.readMain(reference)).toEqual(files[0]!.bytes)
        if (profile === 'database-bytes') {
          const localBinding = createFileSkillContentBinding(target.db, root)
          expect(await localBinding.content.readMain(reference)).toEqual(files[0]!.bytes)
          await target.session.transaction((tx) => deleteTree(tx, 'frozen', 'live'))
          await localBinding.lifecycleContent.restoreLiveIfMissing('frozen', 1)
          expect(await localBinding.lifecycleContent.hasLiveMain('frozen')).toBe(true)
        }
        for (const file of files)
          expect(await content.content.readFile(reference, file.path)).toEqual(file.bytes)
        const locations = createSkillContentLocationQuery(target.db)
        const published = await locations.publication('frozen', 1)
        expect(published!.live!.kind).toBe(profile)
        expect(published!.snapshot!.content.kind).toBe(
          history === 'existing' ? profile : 'database-bytes',
        )
        expect(published!.snapshot!.content.contentId).toBeNull()
        expect(await locations.locate('frozen', { kind: 'version', version: 2 })).toBeNull()
        expect(await content.content.readMain({ ...reference, contentVersion: 2 })).toEqual(
          files[0]!.bytes,
        )
        expect(
          (await content.versionReader.readSnapshot({ skillId: 'frozen', version: 2 })).main,
        ).toBeNull()
        expect(await content.treeContent!.readVersion({ skillId: 'frozen', version: 1 })).toEqual(
          [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        )
        const options = selectSkillContentDependencies(content, join(root, 'unused-native-home'))
        const boot = createSkillCatalogBootAdapter({ db: target.db, ...options })
        boot.activateAvailabilityGate()
        expect(await boot.reverifySnapshots()).toEqual({ verified: 1, quarantined: 0 })
        const snapshotReference = published!.snapshot!.content
        if (profile === 'local-file')
          writeFileSync(join(root, 'skills/legacy/files/SKILL.md'), 'edited live')
        else
          await target.session.transaction((tx) =>
            writeTree(
              tx,
              'frozen',
              'live',
              [{ path: 'SKILL.md', bytes: Buffer.from('edited live') }],
              2,
            ),
          )
        expect(await content.content.readMain(reference)).toEqual(files[0]!.bytes)
        expect(
          (await content.versionReader.readSnapshot({ skillId: 'frozen', version: 1 })).main,
        ).toEqual(files[0]!.bytes)
        expect((await locations.publication('frozen', 1))!.snapshot!.content).toEqual(
          snapshotReference,
        )
        // Boot restores the referenced local live path from either kind of snapshot.
        if (profile === 'local-file') {
          rmSync(join(root, 'skills/legacy/files'), { recursive: true })
          await content.lifecycleContent.restoreLiveIfMissing('frozen', 1)
          expect(await content.lifecycleContent.hasLiveMain('frozen')).toBe(true)
        }
        await commitSkillVersion(
          target.db,
          options,
          'frozen',
          { kind: 'write-main', content: Buffer.from('native v2') },
          { source: 'editor', authorUserId: null },
        )
        expect(await content.content.readMain({ ...reference, contentVersion: 2 })).toEqual(
          Buffer.from('native v2'),
        )
        expect(
          (await content.versionReader.readSnapshot({ skillId: 'frozen', version: 1 })).main,
        ).toEqual(files[0]!.bytes)
        expect((await locations.publication('frozen', 1))!.snapshot!.content).toEqual(
          snapshotReference,
        )
        expect(existsSync(join(root, 'skills/frozen'))).toBe(profile === 'local-file')
        boot.activateAvailabilityGate()
        expect(await boot.reverifySnapshots()).toEqual({ verified: 1, quarantined: 0 })
        // Both physical trees and database entries participate in reversible deletion.
        const deletion = content.deletionContent.plan({ skillId: 'frozen', operationId: ulid() })
        await content.deletionContent.stage(deletion)
        await content.deletionContent.rollback(deletion, false)
        expect(
          (await content.versionReader.readSnapshot({ skillId: 'frozen', version: 1 })).main,
        ).toEqual(files[0]!.bytes)
      } finally {
        await target.close()
        await input.source.close()
      }
    },
    180_000,
  )
})

describeEachProvider('RFC-395 native reserve proof before retirement', (harness) => {
  test('awaits the selected storage proof and preserves the operation until it completes', async () => {
    const content = createDatabaseSkillContent({ db: harness.db })
    const options = selectSkillContentDependencies(content, 'unused-proof-home')
    const skill = await createManagedSkillWithFiles(
      harness.db,
      options,
      { name: 'reserve-proof', description: '' },
      {
        kind: 'files',
        mainContent: Buffer.from('---\nname: reserve-proof\ndescription: d\n---\nbody'),
        files: [],
      },
    )
    const opId = await harness.session.transaction(async (tx) => {
      const id = await beginOperation(tx, {
        kind: 'reserve',
        skillId: skill.id,
        preconditionJson: JSON.stringify({ skillId: skill.id }),
      })
      for (const phase of ['fs-staged', 'fs-published', 'db-committed'] as const)
        await advancePhase(tx, id, phase)
      return id
    })
    let reached!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      reached = resolve
    })
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const boot = createSkillCatalogBootAdapter({
      db: harness.db,
      ...options,
      identityInspector: {
        ...content.identityInspector,
        async assertPublishedReserve(input) {
          expect(input).toMatchObject({ skillId: skill.id, operationId: opId })
          reached()
          await ready
          await content.identityInspector.assertPublishedReserve(input)
        },
      },
    })
    const pending = boot.recoverOperations()
    try {
      await Promise.race([
        entered,
        pending.then(() => {
          throw new Error('retired before storage proof')
        }),
      ])
      expect((await getActiveOp(harness.db, skill.id))?.opId).toBe(opId)
      release()
      expect(await pending).toMatchObject({ total: 1, rolledForward: 1 })
      expect(await getActiveOp(harness.db, skill.id)).toBeNull()
    } finally {
      release()
      await pending.catch(() => {})
    }
  })
})
