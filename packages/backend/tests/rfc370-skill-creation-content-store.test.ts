// RFC-370 H6: initial bytes and cleanup use the selected storage, while AW
// retains reservation visibility, first-version publication and compensation.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skills, skillOperations, skillOperationLocks, skillVersions, users } from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import type {
  SkillCreationContentStore,
  SkillInitialContent,
} from '@/modules/resource-catalog/application/skills/creationContentStore'
import type { SkillVersionContentStore } from '@/modules/resource-catalog/application/skills/versionContentStore'
import { composeSkillCatalog } from '@/modules/resource-catalog/composition/skillOperations'
import {
  compensateManagedSkillStage,
  createManagedSkill,
  createManagedSkillWithFiles,
  getSkillById,
  listSkills,
  stageManagedSkill,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { createFileSkillCreationContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillCreationContentStore'
import { createFileSkillVersionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentStore'
import { describeEachProvider } from './helpers/eachProvider'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

async function reach(gate: ReturnType<typeof barrier>, pending: Promise<unknown>) {
  await Promise.race([
    gate.pending,
    pending.then(() => {
      throw new Error('operation completed before expected storage step')
    }),
  ])
}

// Non-filesystem contract fixture; this does not model CS persistence or recovery.
function storage() {
  const contents = new Map<string, SkillInitialContent>()
  const creation: SkillCreationContentStore = {
    plan: (skillId) => ({ skillId, rootRef: `blob:${skillId}`, liveRef: `blob:${skillId}/live` }),
    async initialize(plan, content) {
      contents.set(plan.skillId, content)
    },
    async discard(root) {
      contents.delete(root.skillId)
    },
  }
  const versions: SkillVersionContentStore = {
    plan: (input) => ({
      ...input,
      liveRef: `blob:${input.skillId}/live`,
      stagingRef: `blob:${input.skillId}/${input.publicationId}/stage`,
      versionRef: `blob:${input.skillId}/v${input.version}`,
      stagingJournalRef: `blob:${input.skillId}/${input.publicationId}/stage`,
      versionJournalRef: `blob:${input.skillId}/v${input.version}`,
    }),
    async stage(publication, change) {
      expect(contents.has(publication.skillId)).toBe(true)
      expect(change).toEqual({ kind: 'retain' })
      return { contentHash: 'a'.repeat(64), matchesLive: false }
    },
    async discardStage() {},
    async captureVersion() {},
    async publish() {},
    async abort() {},
  }
  return { creation, versions, contents }
}

const input = {
  name: 'creation-store',
  description: 'initial description',
  bodyMd: 'initial body',
  frontmatterExtra: {},
}

describeEachProvider('RFC-370 skill creation content store', (harness) => {
  let directory: string
  let appHome: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aw-creation-store-'))
    appHome = join(directory, 'unused-home')
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  async function row() {
    return (await harness.db.select().from(skills))[0]!
  }
  async function reserve() {
    return (await harness.db.select().from(skillOperations))[0]!
  }
  async function locks() {
    return await harness.db.select().from(skillOperationLocks)
  }

  test('keeps creation invisible until initialization, snapshot and publication finish', async () => {
    const { creation, versions, contents } = storage()
    const initialized = barrier(),
      initializeReady = barrier()
    const publishing = barrier(),
      publishReady = barrier()
    const pending = createManagedSkill(
      harness.db,
      {
        appHome,
        creationContent: {
          ...creation,
          async initialize(plan, content) {
            initialized.release()
            await initializeReady.pending
            await creation.initialize(plan, content)
          },
        },
        versionContent: {
          ...versions,
          async publish() {
            publishing.release()
            await publishReady.pending
          },
        },
      },
      input,
    )
    try {
      await reach(initialized, pending)
      expect(await row()).toMatchObject({
        reservationState: 'reserving',
        versionState: 'legacy-unbackfilled',
      })
      expect(await reserve()).toMatchObject({ phase: 'intent', active: 1 })
      expect(await listSkills(harness.db)).toEqual([])
      expect(await locks()).toHaveLength(1)
      initializeReady.release()
      await reach(publishing, pending)
      expect(await row()).toMatchObject({ reservationState: 'reserving', contentVersion: 1 })
      expect(await reserve()).toMatchObject({ phase: 'fs-staged', active: 1 })
      expect(await getSkillById(harness.db, (await row()).id)).toBeNull()
    } finally {
      initializeReady.release()
      publishReady.release()
    }
    const result = await pending
    expect(await row()).toMatchObject({
      id: result.id,
      reservationState: 'ready',
      contentVersion: 1,
    })
    expect(await reserve()).toMatchObject({ phase: 'done', active: 0 })
    expect(await locks()).toEqual([])
    expect(await harness.db.select().from(skillVersions)).toHaveLength(1)
    expect(contents.get(result.id)).toMatchObject({
      kind: 'main',
      content: expect.stringContaining('initial body'),
    })
    expect(existsSync(appHome)).toBe(false)
  })

  test('awaits cleanup after initialize failure and releases the reservation even when cleanup fails', async () => {
    const { creation, versions } = storage()
    const cleaning = barrier(),
      cleanupReady = barrier()
    const failure = new Error('initial bytes unavailable')
    const pending = createManagedSkill(
      harness.db,
      {
        appHome,
        versionContent: versions,
        creationContent: {
          ...creation,
          async initialize() {
            throw failure
          },
          async discard(root) {
            expect(root.rootRef).toBe(`blob:${root.skillId}`)
            cleaning.release()
            await cleanupReady.pending
            throw new Error('cleanup unavailable too')
          },
        },
      },
      input,
    )
    // Attach the rejection assertion before releasing asynchronous cleanup.
    const rejected = expect(pending).rejects.toBe(failure)
    try {
      await reach(cleaning, pending)
      expect(await row()).toMatchObject({ reservationState: 'reserving' })
      expect(await reserve()).toMatchObject({ phase: 'intent', active: 1 })
      expect(await locks()).toHaveLength(1)
    } finally {
      cleanupReady.release()
    }
    await rejected
    expect(await harness.db.select().from(skills)).toEqual([])
    expect(await reserve()).toMatchObject({ active: 0 })
    expect(await locks()).toEqual([])
    const retried = await createManagedSkill(
      harness.db,
      { appHome, creationContent: creation, versionContent: versions },
      input,
    )
    expect(retried.name).toBe(input.name)
  })

  test('planning failure and a physical producer with selected storage leave no reservation', async () => {
    const { creation, versions } = storage()
    const failure = new Error('cannot plan content')
    await expect(
      createManagedSkill(
        harness.db,
        {
          appHome,
          versionContent: versions,
          creationContent: {
            ...creation,
            plan() {
              throw failure
            },
          },
        },
        input,
      ),
    ).rejects.toBe(failure)
    let producerCalled = false
    await expect(
      createManagedSkillWithFiles(
        harness.db,
        {
          appHome,
          creationContent: creation,
          versionContent: versions,
        },
        input,
        () => {
          producerCalled = true
        },
      ),
    ).rejects.toThrow('legacy skill producer requires the local file creation store')
    expect(producerCalled).toBe(false)
    expect(await harness.db.select().from(skills)).toEqual([])
    expect(await harness.db.select().from(skillOperations)).toEqual([])
    expect(await locks()).toEqual([])
  })

  test('post-commit failure preserves ready content and its recoverable operation', async () => {
    const { creation, versions, contents } = storage()
    const failure = new Error('after ready crash')
    await expect(
      createManagedSkillWithFiles(
        harness.db,
        {
          appHome,
          creationContent: creation,
          versionContent: versions,
        },
        input,
        { kind: 'main', content: 'initial bytes' },
        {
          __afterDbCommitForTest() {
            throw failure
          },
        },
      ),
    ).rejects.toBe(failure)
    expect(await row()).toMatchObject({ reservationState: 'ready', contentVersion: 1 })
    expect(await reserve()).toMatchObject({ phase: 'db-committed', active: 1 })
    expect(await locks()).toHaveLength(1)
    expect(contents.has((await row()).id)).toBe(true)
    expect(await getSkillById(harness.db, (await row()).id)).not.toBeNull()
    expect(existsSync(appHome)).toBe(false)
  })

  test('bundle stage stays invisible and compensation uses its selected root store', async () => {
    const { creation, versions, contents } = storage()
    const staged = await stageManagedSkill(
      harness.db,
      {
        appHome,
        creationContent: creation,
        versionContent: versions,
      },
      input,
      { kind: 'main', content: 'bundle body' },
    )
    expect(staged.skillDir).toBe(`blob:${staged.skillId}`)
    expect(await reserve()).toMatchObject({ phase: 'fs-published', active: 1 })
    expect(await listSkills(harness.db)).toEqual([])
    const cleaning = barrier(),
      cleanupReady = barrier()
    const pending = compensateManagedSkillStage(harness.db, staged, {
      ...creation,
      async discard(root) {
        expect(root).toEqual({ skillId: staged.skillId, rootRef: staged.skillDir })
        cleaning.release()
        await cleanupReady.pending
        await creation.discard(root)
      },
    })
    try {
      await reach(cleaning, pending)
      expect(await locks()).toHaveLength(1)
    } finally {
      cleanupReady.release()
    }
    await pending
    expect(contents.size).toBe(0)
    expect(await harness.db.select().from(skills)).toEqual([])
    expect(await reserve()).toMatchObject({ active: 0 })
    expect(await locks()).toEqual([])
    expect(existsSync(appHome)).toBe(false)
  })

  test('production catalog threads async file creation through editor and ZIP including binary files', async () => {
    await harness.db.insert(users).values({
      id: 'creation-owner',
      username: 'creation-owner',
      displayName: 'Creation owner',
      role: 'admin',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    const admitted = await admitTestDirectAuthority(
      createIdentityAccessRuntime({ db: harness.db }).directAuthority,
      {
        source: 'session',
        userId: 'creation-owner',
      },
    )
    if (admitted === null) throw new Error('creation fixture authority unavailable')
    const localCreation = createFileSkillCreationContentStore(appHome)
    const localVersions = createFileSkillVersionContentStore(appHome)
    const initialized: string[] = []
    const catalog = composeSkillCatalog({
      db: harness.db,
      appHome,
      creationContent: {
        ...localCreation,
        async initialize(plan, content) {
          await Promise.resolve()
          initialized.push(content.kind)
          await localCreation.initialize(plan, content)
        },
      },
      versionContent: {
        ...localVersions,
        async stage(...args) {
          await Promise.resolve()
          return localVersions.stage(...args)
        },
        async captureVersion(...args) {
          await Promise.resolve()
          await localVersions.captureVersion(...args)
        },
        async publish(...args) {
          await Promise.resolve()
          await localVersions.publish(...args)
        },
      },
      restoreMembership: { unfuseForRestore: async () => [] },
    })
    const created = await catalog.operations.create.invoke(admitted.actor, {
      submission: { kind: 'json-body', body: JSON.stringify(input) },
    })
    expect((await catalog.queries.content(admitted.actor, { id: created.id })).bodyMd).toContain(
      'initial body',
    )
    const bytes = new Uint8Array([0, 128, 255, 1])
    const archive = zipSync({
      'imported/SKILL.md': new TextEncoder().encode(
        '---\nname: imported\ndescription: from archive\n---\nZIP body',
      ),
      'imported/data/raw.bin': bytes,
    })
    const result = await catalog.zipImport.commit(admitted.actor, {
      archive: { content: Buffer.from(archive).toString('base64') },
      decisions: { imported: { action: 'import' } },
    })
    expect(result.failed).toEqual([])
    expect(result.created).toHaveLength(1)
    const imported = result.created[0]!
    expect(initialized).toEqual(['main', 'files'])
    expect((await catalog.queries.content(admitted.actor, { id: imported.id })).bodyMd).toContain(
      'ZIP body',
    )
    for (const suffix of ['files', 'versions/v1/files']) {
      expect(
        new Uint8Array(readFileSync(join(appHome, 'skills', imported.id, suffix, 'data/raw.bin'))),
      ).toEqual(bytes)
    }
    expect(
      await harness.db.select().from(skillVersions).where(eq(skillVersions.skillId, imported.id)),
    ).toHaveLength(1)
  })
})
