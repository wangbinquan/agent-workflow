// RFC-370 M0 — skill trees kept in the database for deployments without a
// persistent disk (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §5.1).
// Locks: the database tree hash is byte-for-byte the canonical file-tree hash
// recorded in version metadata; every content port keeps its file-store
// semantics; and real HTTP editing plus boot verification work end to end with
// no skill file written to the local disk.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { skillContentEntries, skills } from '@/db/schema'
import { composeSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { selectSkillContentDependencies } from '@/modules/resource-catalog/composition/skillContentBinding'
import { createDatabaseSkillContent } from '@/modules/resource-catalog/infrastructure/databaseSkillContent'
import {
  hashSkillTree,
  isInsideSkillDirectory,
  normalizeSkillPath,
} from '@/modules/resource-catalog/infrastructure/databaseSkillTrees'
import {
  hashDir,
  hashRegularFileTree,
} from '@/modules/resource-catalog/infrastructure/legacy/skillHash'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { describeEachProvider } from './helpers/eachProvider'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const enc = (text: string) => new TextEncoder().encode(text)
const SKILL = '01J0SKDB000000000000000000'
const PUBLICATION = '01J0PB00000000000000000001'
const OPERATION = '01J0QP00000000000000000001'

afterEach(resetSkillBootVerifyForTest)

test('the database tree hash equals the canonical file-tree hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc370-m0-hash-'))
  try {
    const files = [
      { path: 'SKILL.md', bytes: enc('# main\n') },
      { path: 'scripts/run.sh', bytes: enc('echo 中文\n') },
      { path: 'a/b/c.bin', bytes: new Uint8Array([0, 1, 2, 255]) },
      { path: 'Z.txt', bytes: enc('upper sorts before lower') },
    ]
    for (const file of files) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true })
      writeFileSync(join(dir, file.path), file.bytes)
    }
    expect(hashSkillTree(files)).toBe(hashRegularFileTree(dir))
    // An absent tree hashes to the empty digest, exactly like the file store's hashDir.
    expect(hashSkillTree([])).toBe(hashDir(join(dir, 'missing')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill paths stay relative and inside the tree', () => {
  expect(normalizeSkillPath('scripts/run.sh')).toBe('scripts/run.sh')
  expect(normalizeSkillPath('scripts\\win.ps1')).toBe('scripts/win.ps1')
  for (const bad of ['', '/abs', '../up', 'a/../b', 'a//b', './x', 'C:/x']) {
    expect(() => normalizeSkillPath(bad)).toThrow('invalid skill file path')
  }
  expect(isInsideSkillDirectory('docs/guide.md', 'docs')).toBe(true)
  expect(isInsideSkillDirectory('docs/a/b.md', 'docs/a')).toBe(true)
  for (const [path, directory] of [
    ['docs', 'docs'],
    ['docsx/a.md', 'docs'],
    ['doc', 'docs'],
  ] as const) {
    expect(isInsideSkillDirectory(path, directory)).toBe(false)
  }
})

describeEachProvider('RFC-370 M0 database skill content ports', (harness) => {
  const store = () => createDatabaseSkillContent({ db: harness.db, now: () => 1_000 })
  const reference = (contentVersion: number) => ({ id: SKILL, name: 'db-skill', contentVersion })

  test('creation, snapshot-preferring reads, file errors and discard', async () => {
    const content = store()
    const plan = content.creationContent.plan(SKILL)
    expect(plan).toEqual({
      skillId: SKILL,
      rootRef: `skills/${SKILL}`,
      liveRef: `skills/${SKILL}/files`,
    })
    await content.creationContent.initialize(plan, {
      kind: 'files',
      mainContent: '# hello',
      files: [
        { path: 'SKILL.md', content: enc('ignored: main content wins') },
        { path: 'docs/guide.md', content: enc('guide') },
        { path: 'bin/data', content: new Uint8Array([0, 9]) },
      ],
    })
    expect(await content.content.readMain(reference(1))).toBe('# hello')
    expect(await content.content.listFiles(reference(1))).toEqual([
      { path: 'SKILL.md', type: 'file', size: 7, modifiedAt: 1_000 },
      { path: 'bin', type: 'dir' },
      { path: 'bin/data', type: 'file', size: 2, modifiedAt: 1_000 },
      { path: 'docs', type: 'dir' },
      { path: 'docs/guide.md', type: 'file', size: 5, modifiedAt: 1_000 },
    ])
    expect(await content.content.readFile(reference(1), 'docs/guide.md')).toBe('guide')
    await expect(content.content.readFile(reference(1), 'docs')).rejects.toMatchObject({
      code: 'skill-file-is-dir',
    })
    await expect(content.content.readFile(reference(1), 'nope.md')).rejects.toMatchObject({
      code: 'skill-file-not-found',
    })
    await content.creationContent.discard(plan)
    expect(await content.lifecycleContent.isRootEmpty(SKILL)).toBe(true)
    await expect(content.content.readMain(reference(1))).rejects.toMatchObject({
      code: 'skill-md-missing',
    })
  })

  test('version funnel: stage changes, capture, publish atomically, abort and recover', async () => {
    const content = store()
    await content.creationContent.initialize(content.creationContent.plan(SKILL), {
      kind: 'main',
      content: '# v1',
    })
    expect(await content.lifecycleContent.captureInitial(SKILL)).toBe(
      hashSkillTree([{ path: 'SKILL.md', bytes: enc('# v1') }]),
    )
    const publication = content.versionContent.plan({
      skillId: SKILL,
      version: 2,
      publicationId: PUBLICATION,
    })
    expect(publication.stagingJournalRef).toBe(`skills/${SKILL}/files.op-${PUBLICATION}.staged`)
    expect(publication.versionJournalRef).toBe(`skills/${SKILL}/versions/v2/files`)

    const unchanged = await content.versionContent.stage(publication, { kind: 'retain' }, true)
    expect(unchanged.matchesLive).toBe(true)
    const staged = await content.versionContent.stage(
      publication,
      { kind: 'write-file', path: 'notes/a.md', content: 'A' },
      true,
    )
    expect(staged.matchesLive).toBe(false)
    expect(staged.contentHash).toBe(
      hashSkillTree([
        { path: 'SKILL.md', bytes: enc('# v1') },
        { path: 'notes/a.md', bytes: enc('A') },
      ]),
    )
    // Staging never touches what readers see.
    expect((await content.content.listFiles(reference(1))).map((node) => node.path)).toEqual([
      'SKILL.md',
    ])
    await content.versionContent.captureVersion(publication)
    expect(await content.versionPresence.exists(reference(2))).toBe(true)
    await expect(content.versionContent.publish(publication, 'not-the-hash')).rejects.toThrow(
      'does not match committed content hash',
    )
    await content.versionContent.publish(publication, staged.contentHash)
    expect(await content.content.readFile(reference(2), 'notes/a.md')).toBe('A')
    expect((await content.versionReader.readSnapshot({ skillId: SKILL, version: 2 })).main).toBe(
      '# v1',
    )

    // Deleting a directory path removes its subtree; restore-version copies an old tree.
    const third = content.versionContent.plan({
      skillId: SKILL,
      version: 3,
      publicationId: OPERATION,
    })
    const deleted = await content.versionContent.stage(
      third,
      { kind: 'delete-file', path: 'notes' },
      false,
    )
    expect(deleted.contentHash).toBe(hashSkillTree([{ path: 'SKILL.md', bytes: enc('# v1') }]))
    await content.versionContent.abort(third)
    expect(await content.versionPresence.exists(reference(3))).toBe(false)
    const restored = await content.versionContent.stage(
      third,
      { kind: 'restore-version', version: 1 },
      true,
    )
    expect(restored.contentHash).toBe(hashSkillTree([{ path: 'SKILL.md', bytes: enc('# v1') }]))

    // Recovery: the persisted references select the same trees.
    const recovery = content.versionRecovery.plan({
      skillId: SKILL,
      operationId: OPERATION,
      version: 3,
      stagingReference: third.stagingJournalRef,
      versionReference: third.versionJournalRef,
    })
    expect(recovery.publicationId).toBe(OPERATION)
    expect(content.versionRecovery.matchesVersionReference(recovery, third.versionJournalRef)).toBe(
      true,
    )
    await content.versionContent.captureVersion(third)
    await content.versionRecovery.rollForward(recovery, restored.contentHash)
    expect(await content.content.listFiles(reference(3))).toHaveLength(1)
    expect(() =>
      content.versionRecovery.plan({
        skillId: SKILL,
        operationId: OPERATION,
        version: 3,
        stagingReference: `skills/${SKILL}/files.op-bad.staged`,
        versionReference: third.versionJournalRef,
      }),
    ).toThrow('staging path does not match')
  })

  test('deletion moves every tree to its trash and restores or discards it', async () => {
    const content = store()
    await content.creationContent.initialize(content.creationContent.plan(SKILL), {
      kind: 'main',
      content: '# keep',
    })
    await content.lifecycleContent.captureInitial(SKILL)
    const plan = content.deletionContent.plan({ skillId: SKILL, operationId: OPERATION })
    expect(plan.backupJournalRef).toBe(`skills/.trash/${SKILL}-${OPERATION}`)
    expect(() =>
      content.deletionContent.plan({
        skillId: SKILL,
        operationId: OPERATION,
        recordedBackupRef: 'skills/.trash/other',
      }),
    ).toThrow('backup path does not match')
    await content.deletionContent.stage(plan)
    expect(await content.lifecycleContent.isRootEmpty(SKILL)).toBe(true)
    await content.deletionContent.rollback(plan, false)
    expect(await content.lifecycleContent.hasLiveMain(SKILL)).toBe(true)
    await content.deletionContent.stage(plan)
    await content.deletionContent.discard(plan)
    expect(
      await harness.db
        .select()
        .from(skillContentEntries)
        .where(eq(skillContentEntries.skillId, SKILL)),
    ).toEqual([])
    await expect(content.deletionContent.rollback(plan, true)).rejects.toThrow(
      'lost both root and trash',
    )
  })

  test('boot inspection proves stored versions and the live tree', async () => {
    const content = store()
    await content.creationContent.initialize(content.creationContent.plan(SKILL), {
      kind: 'main',
      content: '# boot',
    })
    const hash = (await content.lifecycleContent.captureInitial(SKILL))!
    const versions = [
      { version: 1, reference: `skills/${SKILL}/versions/v1/files`, contentHash: hash },
    ]
    expect(
      await content.snapshotInspector.inspect({ skillId: SKILL, currentVersion: 1, versions }),
    ).toEqual({ ok: true })
    expect(
      await content.snapshotInspector.inspect({
        skillId: SKILL,
        currentVersion: 1,
        versions: [{ ...versions[0]!, contentHash: 'tampered' }],
      }),
    ).toMatchObject({ ok: false })
    await content.identityInspector.assertCanonicalRoot(SKILL)
    await content.identityInspector.assertCanonicalLive(SKILL)
    await content.identityInspector.assertCanonicalVersion(SKILL, 1)
    await content.identityInspector.assertNoResidue()
    await content.versionContent.stage(
      content.versionContent.plan({ skillId: SKILL, version: 2, publicationId: PUBLICATION }),
      { kind: 'retain' },
      false,
    )
    await expect(content.identityInspector.assertNoResidue()).rejects.toMatchObject({
      code: 'skill-migration-postcondition-failed',
    })
    expect(
      content.identityInspector.needsMigration({ id: SKILL, name: 'x', canonicalMetadata: true }),
    ).toBe(false)
    const packaged = await content.packageContent.readTree(reference(1))
    expect(packaged.map((entry) => entry.path)).toEqual(['SKILL.md'])
  })
})

describeEachProviderHttpApplication(
  'RFC-370 M0 database skill content over the real HTTP skill API',
  {
    token: 'c'.repeat(64),
    opencodeVersion: null,
    dbVersion: 17,
    tempPrefix: 'aw-rfc370-m0-db-skill-',
  },
  (scope) => {
    const headers = {
      Authorization: `Bearer ${'c'.repeat(64)}`,
      'content-type': 'application/json',
    }
    test('create, edit, read, version and boot-verify a skill with no local skill files', async () => {
      const selection = createDatabaseSkillContent({ db: scope.harness.db })
      const { app, appHome } = await scope.open({ skillContent: selection })
      const created = await app.request('/api/skills', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'db-backed', bodyMd: 'database body' }),
      })
      expect(created.status).toBe(201)
      const { id } = (await created.json()) as { id: string }
      const write = await app.request(`/api/skills/${id}/file?path=templates/a.txt`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: 'aaa' }),
      })
      expect(write.status).toBe(200)
      const read = await app.request(`/api/skills/${id}/file?path=templates/a.txt`, { headers })
      expect(((await read.json()) as { content: string }).content).toBe('aaa')
      const body = await app.request(`/api/skills/${id}/content`, { headers })
      expect(await body.json()).toMatchObject({ bodyMd: 'database body' })
      const versions = await app.request(`/api/skills/${id}/versions`, { headers })
      expect(versions.status).toBe(200)
      expect(existsSync(join(appHome, 'skills', id))).toBe(false)

      const boot = composeSkillCatalogBoot({
        db: scope.harness.db,
        ...selectSkillContentDependencies(selection, appHome),
      })
      await boot.runIdentityMigrationBarrier()
      await boot.reconcileLiveFiles()
      expect(await boot.reverifySnapshots()).toEqual({ verified: 1, quarantined: 0 })
      expect(
        (await scope.harness.db.select().from(skills).where(eq(skills.id, id)))[0],
      ).toMatchObject({ reservationState: 'ready', contentVersion: 2 })
    }, 30_000)
  },
)
