// RFC-401 T5（design §10.2）—— skill 的单写入栈。锁定：
//   · 唯一 skill 写入参与者：新建重名 409 `skill-name-in-use`；推进版本的复合前置条件、版本号必须是 contentVersion + 1、
//     内容与当前版本相同且 description 不变 → already-current（不写行）、description 变化 → metaRevision + 1、`before` 在栅栏之前
//     （错误优先级）、`after` 拿到新版本号；删除前事务内复查引用；
//   · skill 写入场景（AtomicApply）：claim 事务取技能锁（被占 → 409 `skill-operation-busy`，不留 journal）；提交前失败按工件补偿、
//     记为 failed、释放锁；提交后发布失败不再把技能锁到重启——journal committed / 尾部 pending、锁仍持有，恢复在租约过期后
//     接管、前滚发布、尾部 complete 并释放锁；提交前崩溃（prepared + 过期租约）被恢复补偿；
//   · 字节合同：lineWidth 0 不折行；与当前 SKILL.md 解析等价时保留原字节；
//   · 锁 GC 只回收既不属于在途旧 operation、也不属于未结算 journal 的锁。
// 覆盖验收条款：RFC-271 的 AC-24g（内容不变的技能写入仍在提交事务里过栅栏，只跳过版本写入与发布）——资源包的 big tx 与普通编辑
// 经同一个参与者。
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { ATOMIC_APPLY_LEASE_MS } from '@/platform/atomic-apply/lease'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import {
  skillApplyContentFor,
  skillApplyRecoveryContentFor,
} from '@/modules/resource-catalog/infrastructure/skillApplyContent'
import { createSkillApplyRecoveryScene } from '@/modules/resource-catalog/infrastructure/skillApplyRecovery'
import { createSkillApplyScene } from '@/modules/resource-catalog/infrastructure/skillAtomicApply'
import {
  createSkillMutationParticipant,
  SkillDeleteReferencedError,
} from '@/modules/resource-catalog/infrastructure/skillMutationParticipant'
import {
  preserveSkillMarkdownBytes,
  renderSkillMarkdown,
} from '@/modules/resource-catalog/infrastructure/skillMarkdown'
import {
  acquireOpLocks,
  gcOrphanLocks,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { describeEachProvider } from './helpers/eachProvider'
import { agentFixture, patchAgentFixture } from './helpers/model'

const encoder = new TextEncoder()
const main = (description: string, body: string) =>
  encoder.encode(renderSkillMarkdown({ name: 'notes', description, bodyMd: body }))

test('byte contract: one serializer, no folding, equivalent bytes are kept', () => {
  const long = 'x'.repeat(120)
  const rendered = renderSkillMarkdown({ name: 'n', description: long, bodyMd: 'body\n' })
  expect(rendered).toBe(`---\nname: n\ndescription: ${long}\n---\nbody\n`)
  // 资源包旧序列化器写出的字节（frontmatter 后空一行、末尾补换行）与新内容解析等价：保留原字节。
  const packaged = `---\nname: n\ndescription: d\n---\n\nbody\n`
  expect(renderSkillMarkdown({ name: 'n', description: 'd', bodyMd: 'body' }, packaged)).toBe(
    packaged,
  )
  // 普通编辑旧序列化器（lineWidth 80）折行的长 description 解析后相同：同样保留。
  const folded = `---\nname: n\ndescription: ${'word '
    .repeat(30)
    .trimEnd()
    .replace(/(.{70}) /, '$1\n  ')}\n---\nbody`
  expect(
    preserveSkillMarkdownBytes(
      folded,
      renderSkillMarkdown({ name: 'n', description: 'word '.repeat(30).trimEnd(), bodyMd: 'body' }),
    ),
  ).toBe(folded)
  // 真变化不保留；键序不影响判等。
  expect(renderSkillMarkdown({ name: 'n', description: 'd2', bodyMd: 'body' }, packaged)).not.toBe(
    packaged,
  )
  expect(
    preserveSkillMarkdownBytes(
      '---\ndescription: d\nname: n\n---\nbody',
      renderSkillMarkdown({ name: 'n', description: 'd', bodyMd: 'body' }),
    ),
  ).toBe('---\ndescription: d\nname: n\n---\nbody')
})

describeEachProvider('RFC-401 T5 skill write participant', (harness) => {
  let db: PersistenceDb
  beforeEach(() => {
    db = harness.db
  })
  const tx = <T>(
    run: (participant: ReturnType<typeof createSkillMutationParticipant>) => Promise<T>,
  ) => databaseSessionFor(db).transaction((handle) => run(createSkillMutationParticipant(handle)))
  const create = (id: string, name = 'notes', ownerUserId: string | null = null) =>
    tx((skills) =>
      skills.create({
        id,
        name,
        description: 'd',
        ownerUserId,
        contentKind: 'local-file',
        contentHash: 'hash-1',
        authorUserId: ownerUserId,
        now: 10,
      }),
    )
  const row = async (id: string) => {
    const { skills } = tablesOf(db)
    return first(db.select().from(skills).where(eq(skills.id, id)))
  }
  const versions = async (id: string) => {
    const { skillVersions } = tablesOf(db)
    return db.select().from(skillVersions).where(eq(skillVersions.skillId, id))
  }
  const base = (id: string) => ({
    skillId: id,
    versionIndex: 2,
    contentKind: 'local-file' as const,
    contentHash: 'hash-2',
    fence: { expectedVersion: 1 },
    source: 'editor' as const,
    summary: null,
    fusionId: null,
    restoredFromVersion: null,
    authorUserId: null,
    now: 20,
  })

  test('create writes a ready row with v1; the same owner and name is 409 skill-name-in-use', async () => {
    const id = ulid()
    await create(id)
    expect(await row(id)).toMatchObject({
      reservationState: 'ready',
      versionState: 'snapshot-authoritative',
      contentVersion: 1,
      metaRevision: 0,
      visibility: 'private',
    })
    expect((await versions(id)).map((version) => [version.versionIndex, version.source])).toEqual([
      [1, 'initial'],
    ])
    const duplicate = create(ulid())
    await expect(duplicate).rejects.toMatchObject({
      code: 'skill-name-in-use',
      status: 409,
      message: "skill 'notes' already exists",
    })
    // 另一个 owner 的同名不冲突。
    const { users } = tablesOf(db)
    await insertOne(db, users, {
      id: 'rfc401-skill-owner',
      username: 'rfc401-skill-owner',
      displayName: 'o',
      role: 'user',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    await create(ulid(), 'notes', 'rfc401-skill-owner')
  })

  test('version: fence, version index, already-current and the metaRevision rule', async () => {
    const id = ulid()
    await create(id)
    await expect(
      tx((skills) => skills.version({ ...base(id), fence: { expectedVersion: 7 } })),
    ).rejects.toMatchObject({ code: 'resource-operation-stale' })
    await expect(
      tx((skills) => skills.version({ ...base(id), versionIndex: 5 })),
    ).rejects.toMatchObject({ code: 'resource-operation-stale' })
    // 内容摘要与当前版本相同、description 不变：不写任何行。RFC-271 AC-24g：不变的写入照样在提交事务里先过栅栏
    // （资源包的 big tx 经同一个参与者），栅栏漂了就 stale，只跳过版本写入。
    await expect(
      tx((skills) =>
        skills.version({ ...base(id), contentHash: 'hash-1', fence: { expectedVersion: 7 } }),
      ),
    ).rejects.toMatchObject({ code: 'resource-operation-stale' })
    expect(
      await tx((skills) =>
        skills.version({ ...base(id), contentHash: 'hash-1', description: 'd' }),
      ),
    ).toEqual({ outcome: 'already-current', versionIndex: 1, metaRevision: 0 })
    expect(await versions(id)).toHaveLength(1)
    // 内容变化、description 不变：metaRevision 不动。
    const written = await tx((skills) => skills.version(base(id)))
    expect(written).toMatchObject({ outcome: 'committed', versionIndex: 2, metaRevision: 0 })
    // description 变化：metaRevision + 1，写入 description。
    const described = await tx((skills) =>
      skills.version({
        ...base(id),
        versionIndex: 3,
        contentHash: 'hash-3',
        fence: { expectedVersion: 2 },
        description: 'd2',
        now: 30,
      }),
    )
    expect(described).toMatchObject({ outcome: 'committed', versionIndex: 3, metaRevision: 1 })
    expect(await row(id)).toMatchObject({ contentVersion: 3, metaRevision: 1, description: 'd2' })
    // restore / fusion 总是推进：摘要相同也写一版。
    const always = await tx((skills) =>
      skills.version({
        ...base(id),
        versionIndex: 4,
        contentHash: 'hash-3',
        fence: { expectedVersion: 3 },
        source: 'restore',
        advance: 'always',
        now: 40,
      }),
    )
    expect(always).toMatchObject({ outcome: 'committed', versionIndex: 4 })
  })

  test('version hooks: before runs ahead of the fence, after sees the new version', async () => {
    const id = ulid()
    await create(id)
    const order: string[] = []
    await expect(
      tx((skills) =>
        skills.version({
          ...base(id),
          fence: { expectedVersion: 9 },
          hooks: {
            before: () => {
              order.push('before')
              throw new Error('fusion-not-applying')
            },
          },
        }),
      ),
    ).rejects.toThrow('fusion-not-applying')
    await tx((skills) =>
      skills.version({
        ...base(id),
        hooks: {
          before: () => void order.push('before'),
          after: (version) => void order.push(`after:${version}`),
        },
      }),
    )
    expect(order).toEqual(['before', 'before', 'after:2'])
  })

  test('delete re-checks references in the transaction', async () => {
    const id = ulid()
    await create(id)
    await agentFixture(db, {
      id: ulid(),
      name: 'uses-notes',
      skills: [{ kind: 'managed', skillId: id }],
    })
    const referenced = tx((skills) => skills.delete({ skillId: id }))
    await expect(referenced).rejects.toBeInstanceOf(SkillDeleteReferencedError)
    expect(await row(id)).toBeDefined()
    await patchAgentFixture(db, { name: 'uses-notes' }, { skills: [] })
    await tx((skills) => skills.delete({ skillId: id }))
    expect(await row(id)).toBeUndefined()
    expect(await versions(id)).toHaveLength(0)
  })
})

describeEachProvider('RFC-401 T5 skill write scene and recovery', (harness) => {
  let db: PersistenceDb
  let appHome: string
  let clock = 1_000_000
  const now = () => clock

  beforeEach(() => {
    db = harness.db
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc401-skill-'))
    clock = 1_000_000
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const scene = () =>
    createSkillApplyScene({ db, content: skillApplyContentFor(db, { appHome }), now })
  const recovery = () =>
    createAtomicApplyRecovery(
      [
        createSkillApplyRecoveryScene({
          db,
          content: skillApplyRecoveryContentFor(db, appHome),
          now,
        }),
      ],
      now,
    )
  const journals = async (skillId: string) => {
    const { skillApplyJournal } = tablesOf(db)
    return db.select().from(skillApplyJournal).where(eq(skillApplyJournal.skillId, skillId))
  }
  const claim = async (journalId: string) => {
    const { atomicApplyClaims } = tablesOf(db)
    return first(
      db
        .select()
        .from(atomicApplyClaims)
        .where(
          and(eq(atomicApplyClaims.scene, 'skill'), eq(atomicApplyClaims.journalId, journalId)),
        ),
    )
  }
  const locks = async () => {
    const { skillOperationLocks } = tablesOf(db)
    return db.select().from(skillOperationLocks)
  }
  const live = (skillId: string) =>
    readFileSync(join(appHome, 'skills', skillId, 'files', 'SKILL.md'), 'utf8')
  const skillRow = async (skillId: string) => {
    const { skills } = tablesOf(db)
    return first(db.select().from(skills).where(eq(skills.id, skillId)))
  }
  const createSkill = () =>
    scene().create({
      name: 'notes',
      description: 'd',
      ownerUserId: null,
      authorUserId: null,
      initial: { kind: 'main', content: main('d', 'v1') },
    })
  const write = (skillId: string, body: string, extra: object = {}) =>
    scene().version({
      skillId,
      change: { kind: 'write-main', content: main('d', body) },
      compareLive: true,
      mutation: {
        fence: { expectedVersion: undefined },
        source: 'editor',
        summary: null,
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: null,
      },
      ...extra,
    })

  test('create and save publish live, settle the journal and release the lock', async () => {
    const skillId = await createSkill()
    expect(live(skillId)).toContain('v1')
    const saved = await write(skillId, 'v2')
    expect(saved).toMatchObject({ outcome: 'committed', versionIndex: 2 })
    expect(live(skillId)).toContain('v2')
    const rows = await journals(skillId)
    expect(rows.map((row) => [row.operation, row.state])).toEqual([
      ['create', 'committed'],
      ['version', 'committed'],
    ])
    for (const row of rows) expect((await claim(row.id))?.tailState).toBe('complete')
    expect(await locks()).toEqual([])
    // 编辑器内容与 live 相同：不推进版本，也不留暂存。
    expect(await write(skillId, 'v2')).toMatchObject({
      outcome: 'already-current',
      versionIndex: 2,
    })
    expect((await skillRow(skillId))?.contentVersion).toBe(2)
    expect(
      readdirSync(join(appHome, 'skills', skillId)).filter((name) => name.includes('.op-')),
    ).toEqual([])
  })

  test('an unchanged editor write still checks the precondition in the committing transaction', async () => {
    const skillId = await createSkill()
    const unchanged = scene().version({
      skillId,
      change: { kind: 'write-main', content: main('d', 'v1') },
      compareLive: true,
      mutation: {
        fence: { expectedMetaRevision: 3 },
        source: 'editor',
        summary: null,
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: null,
      },
    })
    await expect(unchanged).rejects.toMatchObject({ code: 'resource-operation-stale' })
    expect((await skillRow(skillId))?.contentVersion).toBe(1)
    expect(await locks()).toEqual([])
  })

  test('a held lock is 409 skill-operation-busy and leaves no journal', async () => {
    const skillId = await createSkill()
    await databaseSessionFor(db).transaction((tx) => acquireOpLocks(tx, ulid(), [skillId]))
    await expect(write(skillId, 'v2')).rejects.toMatchObject({
      code: 'skill-operation-busy',
      status: 409,
    })
    expect((await journals(skillId)).map((row) => row.operation)).toEqual(['create'])
  })

  test('a pre-commit failure compensates, records failed and releases the lock', async () => {
    const skillId = await createSkill()
    const stale = scene().version({
      skillId,
      change: { kind: 'write-main', content: main('d', 'v2') },
      mutation: {
        fence: { expectedMetaRevision: 5 },
        source: 'editor',
        summary: null,
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: null,
      },
    })
    await expect(stale).rejects.toMatchObject({ code: 'resource-operation-stale' })
    const failed = (await journals(skillId)).find((row) => row.operation === 'version')
    expect(failed?.state).toBe('failed')
    expect(await locks()).toEqual([])
    expect(live(skillId)).toContain('v1')
    expect(existsSync(join(appHome, 'skills', skillId, 'versions', 'v2', 'files'))).toBe(false)
  })

  test('a post-commit publish failure keeps the lock until recovery rolls forward after the lease', async () => {
    const skillId = await createSkill()
    await expect(
      write(skillId, 'v2', {
        faults: {
          afterCommit: () => {
            throw new Error('publish interrupted')
          },
        },
      }),
    ).rejects.toThrow('publish interrupted')
    const pending = (await journals(skillId)).find((row) => row.operation === 'version')!
    expect(pending.state).toBe('committed')
    expect((await claim(pending.id))?.tailState).toBe('pending')
    expect((await skillRow(skillId))?.contentVersion).toBe(2)
    expect(live(skillId)).toContain('v1')
    expect((await locks()).map((lock) => lock.opId)).toEqual([pending.id])
    // 记账时释放了租约，恢复立刻可接管；锁 GC 不回收未结算 journal 的锁。
    await databaseSessionFor(db).transaction((tx) => gcOrphanLocks(tx))
    expect(await locks()).toHaveLength(1)
    clock += ATOMIC_APPLY_LEASE_MS + 1
    expect(await recovery().converge({ skill: [] })).toEqual({ failed: 0, rolledForward: 1 })
    expect(live(skillId)).toContain('v2')
    expect((await claim(pending.id))?.tailState).toBe('complete')
    expect(await locks()).toEqual([])
    // 下一轮不再前滚。
    expect(await recovery().converge({ skill: [] })).toEqual({ failed: 0, rolledForward: 0 })
  })

  test('an incomplete compensation is finished by recovery, which then releases the lock', async () => {
    const skillId = await createSkill()
    const stale = scene().version({
      skillId,
      change: { kind: 'write-main', content: main('d', 'v2') },
      mutation: {
        fence: { expectedMetaRevision: 5 },
        source: 'editor',
        summary: null,
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: null,
      },
      faults: {
        beforeCompensate: () => {
          throw new Error('compensation interrupted')
        },
      },
    })
    await expect(stale).rejects.toMatchObject({ code: 'resource-operation-stale' })
    const left = (await journals(skillId)).find((row) => row.operation === 'version')!
    expect(left.state).toBe('prepared')
    expect(left.error).toContain('retryable: compensation incomplete')
    expect((await locks()).map((lock) => lock.opId)).toEqual([left.id])
    expect(await recovery().converge({ skill: [] })).toEqual({ failed: 1, rolledForward: 0 })
    expect((await journals(skillId)).find((row) => row.id === left.id)?.state).toBe('failed')
    expect(await locks()).toEqual([])
    expect(
      readdirSync(join(appHome, 'skills', skillId)).filter((name) => name.includes('.op-')),
    ).toEqual([])
    expect(live(skillId)).toContain('v1')
  })

  test('recovery leaves a live lease alone and takes over once it expires', async () => {
    const skillId = await createSkill()
    const journalId = ulid()
    const { skillApplyJournal, atomicApplyClaims } = tablesOf(db)
    await databaseSessionFor(db).transaction(async (tx) => {
      await insertOne(tx, skillApplyJournal, {
        id: journalId,
        skillId,
        operation: 'version',
        state: 'prepared',
        preparedArtifactsJson: '{"scene":"skill","version":1,"artifacts":[]}',
        receiptJson: null,
        error: null,
        createdAt: clock,
        updatedAt: clock,
      })
      await insertOne(tx, atomicApplyClaims, {
        scene: 'skill',
        journalId,
        claimedBy: 'another-process',
        leaseEpoch: 1,
        claimExpiresAt: clock + ATOMIC_APPLY_LEASE_MS,
        tailState: 'none',
        createdAt: clock,
        updatedAt: clock,
      })
      await acquireOpLocks(tx, journalId, [skillId])
    })
    expect(await recovery().converge({ skill: [] })).toEqual({ failed: 0, rolledForward: 0 })
    expect(await locks()).toHaveLength(1)
    clock += ATOMIC_APPLY_LEASE_MS + 1
    expect(await recovery().converge({ skill: [] })).toEqual({ failed: 1, rolledForward: 0 })
    expect((await claim(journalId))?.leaseEpoch).toBe(2)
    expect(await locks()).toEqual([])
  })
})
