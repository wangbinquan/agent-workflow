// RFC-370 H6: initial bytes and cleanup use the selected storage, while AW
// retains visibility, first-version publication and compensation.
//
// RFC-401 T5：新建经 skill 写入场景——初始内容作为整树（`replace-files`）经选定的版本存储暂存为 v1、固化快照，ready 行与 v1
// 版本行在提交事务里一起写入（没有 `reserving` 中间态），提交后发布 live；选定的创建存储只在补偿时丢弃整棵根。
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { zipSync } from 'fflate'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import type { SkillCreationContentStore } from '@/modules/resource-catalog/application/skills/creationContentStore'
import type { SkillVersionContentStore } from '@/modules/resource-catalog/application/skills/versionContentStore'
import { composeSkillCatalog } from '@/modules/resource-catalog/composition/skillOperations'
import {
  createManagedSkill,
  createManagedSkillWithFiles,
  getSkillById,
  listSkills,
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
  const staged = new Map<string, string>()
  const published = new Set<string>()
  const discarded: string[] = []
  const creation: SkillCreationContentStore = {
    plan: (skillId) => ({ skillId, rootRef: `blob:${skillId}`, liveRef: `blob:${skillId}/live` }),
    async initialize() {
      throw new Error('creation never initializes content directly')
    },
    async discard(root) {
      discarded.push(root.rootRef)
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
      expect(change.kind).toBe('replace-files')
      if (change.kind === 'replace-files')
        staged.set(publication.skillId, Buffer.from(change.mainContent).toString('utf8'))
      return { contentHash: 'a'.repeat(64), matchesLive: false }
    },
    async discardStage() {},
    async captureVersion() {},
    async publish(publication) {
      published.add(publication.skillId)
    },
    async abort(publication) {
      staged.delete(publication.skillId)
    },
  }
  return { creation, versions, staged, published, discarded }
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

  async function rows() {
    const { skills } = tablesOf(harness.db)
    return await harness.db.select().from(skills)
  }
  async function journal() {
    const { skillApplyJournal } = tablesOf(harness.db)
    return (await harness.db.select().from(skillApplyJournal))[0]
  }
  async function locks() {
    const { skillOperationLocks } = tablesOf(harness.db)
    return await harness.db.select().from(skillOperationLocks)
  }

  test('keeps creation invisible until the snapshot commits, then publishes v1', async () => {
    const { creation, versions, staged, published } = storage()
    const staging = barrier(),
      stageReady = barrier()
    const publishing = barrier(),
      publishReady = barrier()
    const pending = createManagedSkill(
      harness.db,
      {
        appHome,
        creationContent: creation,
        versionContent: {
          ...versions,
          async stage(publication, change, compareLive) {
            staging.release()
            await stageReady.pending
            return await versions.stage(publication, change, compareLive)
          },
          async publish(publication, hash) {
            publishing.release()
            await publishReady.pending
            await versions.publish(publication, hash)
          },
        },
      },
      input,
    )
    try {
      await reach(staging, pending)
      expect(await rows()).toEqual([])
      expect(await listSkills(harness.db)).toEqual([])
      expect((await journal())?.state).toBe('prepared')
      expect(await locks()).toHaveLength(1)
      stageReady.release()
      await reach(publishing, pending)
      expect(await rows()).toMatchObject([
        { reservationState: 'ready', contentVersion: 1, versionState: 'snapshot-authoritative' },
      ])
      expect((await journal())?.state).toBe('committed')
      expect(await locks()).toHaveLength(1)
    } finally {
      stageReady.release()
      publishReady.release()
    }
    const result = await pending
    expect(await locks()).toEqual([])
    const { skillVersions } = tablesOf(harness.db)
    expect(await harness.db.select().from(skillVersions)).toHaveLength(1)
    expect(staged.get(result.id)).toContain('initial body')
    expect(published.has(result.id)).toBe(true)
    expect(existsSync(appHome)).toBe(false)
  })

  for (const cleanupFails of [false, true]) {
    test(`a staging failure discards the selected root; cleanup failure=${cleanupFails} keeps the lock for recovery`, async () => {
      const { creation, versions, discarded } = storage()
      const failure = new Error('initial bytes unavailable')
      const pending = createManagedSkill(
        harness.db,
        {
          appHome,
          versionContent: {
            ...versions,
            async captureVersion() {
              throw failure
            },
          },
          creationContent: {
            ...creation,
            async discard(root) {
              await creation.discard(root)
              if (cleanupFails) throw new Error('cleanup unavailable too')
            },
          },
        },
        input,
      )
      await expect(pending).rejects.toBe(failure)
      expect(await rows()).toEqual([])
      expect(discarded).toHaveLength(1)
      expect(discarded[0]).toMatch(/^blob:[0-9A-HJKMNP-TV-Z]{26}$/)
      expect((await journal())?.state).toBe(cleanupFails ? 'prepared' : 'failed')
      expect(await locks()).toHaveLength(cleanupFails ? 1 : 0)
      if (cleanupFails) return
      const retried = await createManagedSkill(
        harness.db,
        { appHome, creationContent: creation, versionContent: versions },
        input,
      )
      expect(retried.name).toBe(input.name)
    })
  }

  test('planning failure and a physical producer with selected storage leave no row', async () => {
    const { creation, versions } = storage()
    const failure = new Error('cannot plan content')
    await expect(
      createManagedSkill(
        harness.db,
        {
          appHome,
          creationContent: creation,
          versionContent: {
            ...versions,
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
    expect(await rows()).toEqual([])
    expect(await locks()).toEqual([])
  })

  test('a post-commit failure keeps the ready row and its recoverable journal', async () => {
    const { creation, versions, published } = storage()
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
        { kind: 'main', content: Buffer.from('initial bytes') },
        {
          __afterDbCommitForTest() {
            throw failure
          },
        },
      ),
    ).rejects.toBe(failure)
    const [row] = await rows()
    expect(row).toMatchObject({ reservationState: 'ready', contentVersion: 1 })
    expect((await journal())?.state).toBe('committed')
    expect(await locks()).toHaveLength(1)
    expect(published.size).toBe(0)
    expect(await getSkillById(harness.db, row!.id)).not.toBeNull()
    expect(existsSync(appHome)).toBe(false)
  })

  test('production catalog threads async file creation through editor and ZIP including binary files', async () => {
    const { users } = tablesOf(harness.db),
      { skillVersions } = tablesOf(harness.db)
    await insertOne(harness.db, users, {
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
    const staged: string[] = []
    const catalog = composeSkillCatalog({
      db: harness.db,
      appHome,
      creationContent: localCreation,
      versionContent: {
        ...localVersions,
        async stage(...args) {
          await Promise.resolve()
          staged.push(args[1].kind)
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
      archive: { encoding: 'base64', content: Buffer.from(archive).toString('base64') },
      decisions: { imported: { action: 'import' } },
    })
    expect(result.failed).toEqual([])
    expect(result.created).toHaveLength(1)
    const imported = result.created[0]!
    expect(staged).toEqual(['replace-files', 'replace-files'])
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
