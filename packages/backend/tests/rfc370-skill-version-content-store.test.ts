// RFC-370 H6: storage completion must precede the existing database phase
// transitions. Use real provider databases and a non-filesystem storage fixture,
// plus actual file operations through an asynchronous adapter.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skills, skillOperations, skillOperationLocks, skillVersions } from '@/db/schema'
import type {
  SkillVersionContentStore,
  SkillVersionPublication,
} from '@/modules/resource-catalog/application/skills/versionContentStore'
import {
  createManagedSkill,
  deleteSkillFile,
  readSkillContent,
  readSkillFile,
  writeSkillContent,
  writeSkillFile,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  commitSkillVersion,
  publishStagedSkillVersion,
  restoreSkillVersion,
  stageSkillVersion,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import { createFileSkillVersionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentStore'
import { describeEachProvider } from './helpers/eachProvider'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

function memoryStore(overrides: Partial<SkillVersionContentStore> = {}): SkillVersionContentStore {
  return {
    plan(input) {
      const prefix = `blob:${input.skillId}/${input.publicationId}`
      return {
        ...input,
        liveRef: `blob:${input.skillId}/live`,
        stagingRef: `${prefix}/stage`,
        versionRef: `${prefix}/v${input.version}`,
        stagingJournalRef: `${prefix}/stage`,
        versionJournalRef: `${prefix}/v${input.version}`,
      }
    },
    async stage() {
      return { contentHash: 'a'.repeat(64), matchesLive: false }
    },
    async discardStage() {},
    async captureVersion() {},
    async publish() {},
    async abort() {},
    ...overrides,
  }
}

async function reach(gate: ReturnType<typeof barrier>, pending: Promise<unknown>) {
  await Promise.race([
    gate.pending,
    pending.then(() => {
      throw new Error('operation settled before expected storage step')
    }),
  ])
}

describeEachProvider('RFC-370 skill version content store', (harness) => {
  let appHome: string
  let skillId: string
  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-version-store-'))
    const skill = await createManagedSkill(
      harness.db,
      { appHome },
      {
        name: 'version-store',
        description: 'initial',
        bodyMd: 'initial body',
        frontmatterExtra: {},
      },
    )
    skillId = skill.id
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  async function operation() {
    return (
      await harness.db
        .select()
        .from(skillOperations)
        .where(and(eq(skillOperations.skillId, skillId), eq(skillOperations.kind, 'version-write')))
    )[0]!
  }
  async function currentVersion() {
    return (await harness.db.select().from(skills).where(eq(skills.id, skillId)))[0]!.contentVersion
  }
  async function versions() {
    return await harness.db.select().from(skillVersions).where(eq(skillVersions.skillId, skillId))
  }
  async function locks() {
    return await harness.db
      .select()
      .from(skillOperationLocks)
      .where(eq(skillOperationLocks.lockedSkillId, skillId))
  }

  test('awaits stage, durable snapshot and publish before advancing their operation phases', async () => {
    const stageEntered = barrier(),
      stageReady = barrier()
    const snapshotEntered = barrier(),
      snapshotReady = barrier()
    const publishEntered = barrier(),
      publishReady = barrier()
    const store = memoryStore({
      async stage(publication, change, compareLive) {
        expect(publication.liveRef.startsWith('blob:')).toBe(true)
        expect(change).toEqual({ kind: 'write-main', content: 'new body' })
        expect(compareLive).toBe(true)
        stageEntered.release()
        await stageReady.pending
        return { contentHash: 'b'.repeat(64), matchesLive: false }
      },
      async captureVersion() {
        snapshotEntered.release()
        await snapshotReady.pending
      },
      async publish(_publication, hash) {
        expect(hash).toBe('b'.repeat(64))
        publishEntered.release()
        await publishReady.pending
      },
    })
    const pending = commitSkillVersion(
      harness.db,
      {
        appHome: join(appHome, 'unused'),
        versionContent: store,
      },
      skillId,
      { kind: 'write-main', content: 'new body' },
      { source: 'editor', authorUserId: null },
    )
    try {
      await reach(stageEntered, pending)
      expect(await operation()).toMatchObject({ phase: 'intent', active: 1 })
      expect(await currentVersion()).toBe(1)
      expect(await locks()).toHaveLength(1)
      stageReady.release()
      await reach(snapshotEntered, pending)
      expect(await operation()).toMatchObject({ phase: 'fs-staged', active: 1 })
      expect(await versions()).toHaveLength(1)
      snapshotReady.release()
      await reach(publishEntered, pending)
      expect(await operation()).toMatchObject({ phase: 'db-committed', active: 1 })
      expect(await currentVersion()).toBe(2)
      expect(await versions()).toHaveLength(2)
      expect(await locks()).toHaveLength(1)
    } finally {
      stageReady.release()
      snapshotReady.release()
      publishReady.release()
    }
    expect((await pending).versionIndex).toBe(2)
    expect(await operation()).toMatchObject({ phase: 'done', active: 0 })
    expect(await locks()).toHaveLength(0)
  })

  for (const cleanupFails of [false, true]) {
    test(`pre-commit failure waits for compensation; cleanup failure=${cleanupFails} retains recovery state`, async () => {
      const entered = barrier(),
        ready = barrier()
      const failure = new Error('snapshot failed')
      const store = memoryStore({
        async captureVersion() {
          throw failure
        },
        async abort() {
          entered.release()
          await ready.pending
          if (cleanupFails) throw new Error('storage cleanup failed')
        },
      })
      const pending = commitSkillVersion(
        harness.db,
        { appHome, versionContent: store },
        skillId,
        { kind: 'write-main', content: 'new' },
        { source: 'editor', authorUserId: null },
      )
      // Attach rejection observation immediately; preserve the original error object.
      const outcome = pending.then(
        () => null,
        (error: unknown) => error,
      )
      try {
        await reach(entered, outcome)
        expect(await operation()).toMatchObject({ phase: 'fs-staged', active: 1 })
        expect(await locks()).toHaveLength(1)
        expect(await currentVersion()).toBe(1)
        expect(await versions()).toHaveLength(1)
      } finally {
        ready.release()
      }
      expect(await outcome).toBe(failure)
      expect((await operation()).active).toBe(cleanupFails ? 1 : 0)
      expect(await locks()).toHaveLength(cleanupFails ? 1 : 0)
    })
  }

  test('post-commit publish failure keeps the durable version and supports replay without another version', async () => {
    let publication: SkillVersionPublication | undefined
    let aborts = 0,
      publishes = 0
    const failure = new Error('publish unavailable')
    const store = memoryStore({
      async publish(value) {
        publication = value
        publishes += 1
        if (publishes === 1) throw failure
      },
      async abort() {
        aborts += 1
      },
    })
    const opts = { appHome, versionContent: store }
    await expect(
      commitSkillVersion(
        harness.db,
        opts,
        skillId,
        { kind: 'write-main', content: 'new' },
        { source: 'editor', authorUserId: null },
      ),
    ).rejects.toBe(failure)
    expect(aborts).toBe(0)
    expect(await operation()).toMatchObject({ phase: 'db-committed', active: 1 })
    expect(await currentVersion()).toBe(2)
    const receipt = publication!
    await publishStagedSkillVersion(harness.db, opts, {
      skillId,
      skillName: 'version-store',
      opId: (await operation()).opId,
      publishId: receipt.publicationId,
      newVersion: receipt.version,
      newHash: 'a'.repeat(64),
      filesDir: receipt.liveRef,
      versionDir: receipt.versionRef,
      stagingDir: receipt.stagingRef,
      noop: null,
    })
    expect(await versions()).toHaveLength(2)
    expect(publishes).toBe(2)
    expect(await operation()).toMatchObject({ phase: 'done', active: 0 })
    expect(await locks()).toHaveLength(0)
  })

  test('no-op waits for staged cleanup and returns the original version without publishing', async () => {
    const entered = barrier(),
      ready = barrier()
    let captures = 0,
      publishes = 0
    const store = memoryStore({
      async stage() {
        return { contentHash: 'a'.repeat(64), matchesLive: true }
      },
      async discardStage() {
        entered.release()
        await ready.pending
      },
      async captureVersion() {
        captures += 1
      },
      async publish() {
        publishes += 1
      },
    })
    const pending = commitSkillVersion(
      harness.db,
      { appHome, versionContent: store },
      skillId,
      { kind: 'retain' },
      { source: 'editor', authorUserId: null, expectedVersion: 1 },
    )
    try {
      await reach(entered, pending)
      expect(await operation()).toMatchObject({ phase: 'intent', active: 1 })
      expect(await locks()).toHaveLength(1)
    } finally {
      ready.release()
    }
    expect((await pending).versionIndex).toBe(1)
    expect(captures).toBe(0)
    expect(publishes).toBe(0)
    expect(await versions()).toHaveLength(1)
    expect(await locks()).toHaveLength(0)
  })

  test('a selected neutral store never silently executes a legacy physical-directory callback', async () => {
    let called = false
    await expect(
      stageSkillVersion(
        harness.db,
        { appHome, versionContent: memoryStore() },
        skillId,
        () => {
          called = true
        },
        { source: 'editor', authorUserId: null },
      ),
    ).rejects.toThrow('legacy skill producer requires the local file content store')
    expect(called).toBe(false)
    expect(await operation()).toBeUndefined()
    expect(await versions()).toHaveLength(1)
    expect(await locks()).toHaveLength(0)
  })

  test('editor and restore changes use the selected asynchronous file adapter end to end', async () => {
    const file = createFileSkillVersionContentStore(appHome)
    const changes: string[] = []
    const store: SkillVersionContentStore = {
      ...file,
      async stage(publication, change, compareLive) {
        changes.push(change.kind)
        return await file.stage(publication, change, compareLive)
      },
      async captureVersion(publication) {
        await file.captureVersion(publication)
      },
      async publish(publication, hash) {
        await file.publish(publication, hash)
      },
    }
    const opts = { appHome, versionContent: store }
    const created = await createManagedSkill(harness.db, opts, {
      name: 'async-created',
      description: 'new',
      bodyMd: 'created through adapter',
      frontmatterExtra: {},
    })
    expect((await readSkillContent(harness.db, opts, created.id)).bodyMd).toBe(
      'created through adapter',
    )
    await writeSkillContent(harness.db, opts, skillId, { bodyMd: 'edited body' })
    expect((await readSkillContent(harness.db, opts, skillId)).bodyMd).toBe('edited body')
    await writeSkillFile(harness.db, opts, skillId, 'support/note.txt', 'support data')
    expect(await readSkillFile(harness.db, opts, skillId, 'support/note.txt')).toBe('support data')
    await deleteSkillFile(harness.db, opts, skillId, 'support/note.txt')
    await expect(
      readSkillFile(harness.db, opts, skillId, 'support/note.txt'),
    ).rejects.toMatchObject({ code: 'skill-file-not-found' })
    await restoreSkillVersion(harness.db, opts, skillId, 1, null, {
      unfuseForRestore: async () => [],
    })
    expect((await readSkillContent(harness.db, opts, skillId)).bodyMd).toBe('initial body')
    expect(changes).toEqual([
      'retain',
      'write-main',
      'write-file',
      'delete-file',
      'restore-version',
    ])
    expect(await currentVersion()).toBe(5)
    expect(await versions()).toHaveLength(5)
    const binary = new Uint8Array([0, 255, 1, 128])
    await commitSkillVersion(
      harness.db,
      opts,
      skillId,
      {
        kind: 'replace-files',
        files: [{ path: 'assets/binary.dat', content: binary }],
        mainContent: 'imported body',
      },
      { source: 'import', authorUserId: null },
    )
    expect((await readSkillContent(harness.db, opts, skillId)).bodyMd).toBe('imported body')
    expect(
      new Uint8Array(
        readFileSync(
          join(appHome, 'skills', skillId, 'versions', 'v6', 'files', 'assets', 'binary.dat'),
        ),
      ),
    ).toEqual(binary)
    expect(changes.at(-1)).toBe('replace-files')
  })
})
