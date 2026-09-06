// RFC-359 W4-D23c —— 技能崩溃安全机器的**双引擎**取证。
//
// D23c 把 PostgreSQL 的 3342 行原生技能实现退役，两个数据库从此跑同一套崩溃安全机器
// （`legacy/skill*`：两阶段提交的 op + 锁、恢复驱动、身份迁移屏障、启动重验）。
// 问题是那套机器的既有套件（skill-boot-verify / skill-op-recovery / skill-identity-migration /
// skill-versioning …共 14 个文件）**全是单引擎**的——合一之后它们描述的就是 PG 的行为，
// 却一次都没在 PG 上跑过。合一如果只把实现并成一份、验收面仍只覆盖一个引擎，
// 就等于把「一个测到、一个没测到」换了个位置放，正是本 RFC 要消灭的形态。
//
// 这份套件补上那一层：挑**引擎语义真的可能分叉**的路径，在两个引擎上各跑一遍。
// 纯文件系统的部分（目录换入 / 树哈希）与引擎无关，留给既有单引擎套件，不在这里重复。
//
//   ① 两阶段 op 的锁互斥 —— 同一技能第二个 op 必须撞锁（唯一约束的跨引擎行为）
//   ② 唯一冲突分类 —— `engineOf(tx).classifyError` 在两个引擎上都要把重名判成 409，
//      而不是 500（SQLite 看 errno、PG 看 SQLSTATE，这是最容易只在一侧成立的一条）
//   ③ 崩溃恢复 —— 半途的 op 经恢复驱动回滚 / 前滚，锁与 active 行都要清干净
//   ④ 身份迁移屏障的引用完整性复核 —— D23c 把 SQLite 的 `PRAGMA foreign_key_check`
//      改写成两个引擎都能跑的孤儿行查询（PG 那份原生实现此前**整条略过**了这道复核），
//      所以这一条必须在两个引擎上都真的**拦下**孤儿版本行
//   ⑤ 版本提交 / 回滚 —— 版本行与 live 内容在两个引擎上同形
//   ⑥ 孤儿锁 GC

import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { skills, skillOperationLocks, skillOperations } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  createManagedSkill,
  deleteSkill,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  abandonOperation,
  advancePhase,
  beginOperation,
  finishOperation,
  gcOrphanLocks,
  listActiveOps,
  listOrphanLocks,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { recoverSkillOperations } from '@/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'
import { SKILL_OP_RECOVERY_REGISTRY } from '@/modules/resource-catalog/infrastructure/legacy/skillOpRegistry'
import { assertSkillIdentityPostcondition } from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityMigration'
import {
  commitSkillVersion,
  listSkillVersions,
  restoreSkillVersion,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'user-d23c'
const ACTOR = {
  user: { id: OWNER, username: OWNER, displayName: OWNER, role: 'admin', status: 'active' },
  userId: OWNER,
  source: 'session',
  permissions: new Set(['resource-acl:private']),
} as never

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDirSync(d)
})
// 「本次启动已验证」是进程级 Set，用完清干净不给同进程后跑的文件留状态。
afterAll(() => {
  resetSkillBootVerifyForTest()
})

function appHomeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-d23c-machinery-'))
  dirs.push(dir)
  return dir
}

async function seed(
  db: ProviderNeutralDatabase,
  appHome: string,
  name: string,
): Promise<{ id: string }> {
  const skill = await createManagedSkill(
    db,
    { appHome },
    { name, description: 'd23c fixture', frontmatterExtra: {}, bodyMd: 'ORIGINAL' },
    { ownerUserId: OWNER, actor: ACTOR },
  )
  return { id: skill.id }
}

const liveMd = (appHome: string, id: string): string =>
  readFileSync(join(appHome, 'skills', id, 'files', 'SKILL.md'), 'utf8')

describeEachProvider('RFC-359 W4-D23c —— 技能崩溃安全机器在两个引擎上同形', (harness) => {
  test('① 同一技能的第二个 op 撞锁——两阶段提交的互斥不依赖引擎', async () => {
    const appHome = appHomeDir()
    const { id } = await seed(harness.db, appHome, 'lock-mutex')
    const session = databaseSessionFor(harness.db)

    const opId = await session.transaction(
      async (tx) =>
        await beginOperation(tx, {
          skillId: id,
          kind: 'version-write',
          preconditionJson: JSON.stringify({ skillId: id }),
        }),
    )
    expect(opId).toBeTruthy()

    // 第二个 op 抢同一把锁：必须拒，且**不能**留下半个 op 行。
    await expect(
      session.transaction(
        async (tx) =>
          await beginOperation(tx, {
            skillId: id,
            kind: 'delete',
            preconditionJson: JSON.stringify({ skillId: id }),
          }),
      ),
    ).rejects.toThrow()
    expect((await listActiveOps(harness.db)).map((op) => op.opId)).toEqual([opId])

    await session.transaction(async (tx) => await abandonOperation(tx, opId))
    expect(await listActiveOps(harness.db)).toHaveLength(0)
    // 放弃之后锁真的释放了——同一技能可以再开 op。
    const second = await session.transaction(
      async (tx) =>
        await beginOperation(tx, {
          skillId: id,
          kind: 'delete',
          preconditionJson: JSON.stringify({ skillId: id }),
        }),
    )
    await session.transaction(async (tx) => await abandonOperation(tx, second))
  })

  test('② 重名冲突在两个引擎上都判成 409 —— 唯一冲突分类不是单引擎的 errno 判据', async () => {
    const appHome = appHomeDir()
    await seed(harness.db, appHome, 'dup-name')
    // SQLite 看 errno、PostgreSQL 看 SQLSTATE；分类错了这里会是 500 而不是 409。
    await expect(seed(harness.db, appHome, 'dup-name')).rejects.toMatchObject({
      status: 409,
      code: 'skill-name-in-use',
    })
    // 失败的那次不留残渣：没有多出来的行、没有挂着的 op 或锁。
    expect(await harness.db.select().from(skills)).toHaveLength(1)
    expect(await listActiveOps(harness.db)).toHaveLength(0)
    expect(await harness.db.select().from(skillOperationLocks)).toHaveLength(0)
  })

  test('③ 崩在 create 途中的 reserving 行 + 锁，被恢复驱动清干净（P0-11 的那个形态）', async () => {
    const appHome = appHomeDir()
    const session = databaseSessionFor(harness.db)
    const orphanId = ulid()

    // 复刻「进程在 reserve intent 之后、任何文件系统副作用之前挂掉」：
    // 一行 reservation_state='reserving' 的技能（对 list/read 不可见）+ 一个 active 的 reserve op + 锁。
    // dual-provider-parity-audit P0-11 说的正是这个残留在 PG 上永远没人清——该技能存不下来、同名也永远建不了。
    const opId = await session.transaction(async (tx) => {
      await tx.insert(skills).values({
        id: orphanId,
        name: 'crashed-create',
        description: 'never completed',
        managedPath: `skills/${orphanId}/files`,
        ownerUserId: OWNER,
        visibility: 'private',
        aclRevision: 0,
        reservationState: 'reserving',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      return await beginOperation(tx, {
        skillId: orphanId,
        kind: 'reserve',
        ownerUserId: OWNER,
        preconditionJson: JSON.stringify({ skillId: orphanId }),
      })
    })
    expect(await listActiveOps(harness.db)).toHaveLength(1)

    const report = await recoverSkillOperations(harness.db, { appHome }, SKILL_OP_RECOVERY_REGISTRY)
    expect(report).toMatchObject({ total: 1, rolledBack: 1, noHandler: 0, quarantined: 0 })
    expect(await listActiveOps(harness.db)).toHaveLength(0)
    expect(
      await harness.db.select().from(skillOperationLocks).where(eq(skillOperationLocks.opId, opId)),
    ).toHaveLength(0)
    // reserving 行被丢弃——这正是「同名永远建不了」的解药。
    expect(await harness.db.select().from(skills).where(eq(skills.id, orphanId))).toHaveLength(0)
    // 清干净之后同名可以正常建。
    const revived = await seed(harness.db, appHome, 'crashed-create')
    expect(revived.id).not.toBe(orphanId)
  })

  test('④ 身份迁移屏障的引用完整性复核在两个引擎上都真的跑了一遍', async () => {
    const appHome = appHomeDir()
    await seed(harness.db, appHome, 'identity-postcondition')
    // 干净状态下屏障放行，且**两个引擎都执行到了**那条复核——D23c 之前 PG 那份原生实现整条略过它。
    await expect(assertSkillIdentityPostcondition(harness.db, appHome)).resolves.toMatchObject({
      skills: 1,
      versions: 1,
    })
  })

  // 孤儿版本行在两个引擎上都被外键挡住，制造不出来（`skill_versions.skill_id` 有 FK），
  // 所以那条复核是**防御外部损坏存量**的一道，无法用普通写路径провок。这里退一步用源码层锁：
  // 判据必须是两个引擎都能跑的孤儿行查询，而不是 SQLite 独有的 PRAGMA——否则合一等于把
  // PG 侧那条缺失的屏障固化下来。
  test('④b 源码锁：引用完整性判据是可移植的孤儿行查询，不是 SQLite 的 PRAGMA', () => {
    // 注释里会提到 PRAGMA（记录它被换掉的由来），所以先剥掉注释再断言**代码**。
    const barrier = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src/modules/resource-catalog/infrastructure/legacy/skillIdentityMigration.ts',
      ),
      'utf8',
    )
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n')
    expect(barrier).not.toContain('PRAGMA')
    expect(barrier).not.toContain('$client')
    expect(barrier).toContain('.leftJoin(skills, eq(skillVersions.skillId, skills.id))')
    expect(barrier).toContain('isNull(skills.id)')
    expect(barrier).toContain("'skill-migration-foreign-key-failed'")
  })

  test('⑤ 版本提交与回滚在两个引擎上同形：版本行、live 内容、序号都一致', async () => {
    const appHome = appHomeDir()
    const { id } = await seed(harness.db, appHome, 'version-roundtrip')
    const baseline = liveMd(appHome, id)

    await commitSkillVersion(
      harness.db,
      { appHome },
      id,
      (dir) => writeFileSync(join(dir, 'SKILL.md'), '---\nname: version-roundtrip\n---\n\nV2\n'),
      { source: 'editor', authorUserId: OWNER },
    )
    expect(liveMd(appHome, id)).toContain('V2')
    const afterCommit = await listSkillVersions(harness.db, { appHome }, id)
    expect(afterCommit.map((v) => v.versionIndex).sort((a, b) => a - b)).toEqual([1, 2])

    await restoreSkillVersion(harness.db, { appHome }, id, 1, OWNER, {
      unfuseForRestore: async () => [],
    })
    // 回滚铸一个内容等于 v1 的新版本，而不是就地改写历史。
    expect(liveMd(appHome, id)).toBe(baseline)
    const afterRestore = await listSkillVersions(harness.db, { appHome }, id)
    expect(afterRestore.map((v) => v.versionIndex).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  test('⑥ 孤儿锁被 GC 掉，活着的 op 的锁不动', async () => {
    const appHome = appHomeDir()
    const { id } = await seed(harness.db, appHome, 'orphan-locks')
    const session = databaseSessionFor(harness.db)

    const liveOp = await session.transaction(
      async (tx) =>
        await beginOperation(tx, {
          skillId: id,
          kind: 'version-write',
          preconditionJson: JSON.stringify({ skillId: id }),
        }),
    )
    // 制造孤儿：op 行没了，锁还在（进程在两条写之间挂掉的残留形态）。
    const orphan = await seed(harness.db, appHome, 'orphan-locks-2')
    const orphanOp = await session.transaction(
      async (tx) =>
        await beginOperation(tx, {
          skillId: orphan.id,
          kind: 'delete',
          preconditionJson: JSON.stringify({ skillId: orphan.id }),
        }),
    )
    await session.transaction(async (tx) => {
      await tx.delete(skillOperations).where(eq(skillOperations.opId, orphanOp))
    })
    expect((await listOrphanLocks(harness.db)).map((lock) => lock.opId)).toEqual([orphanOp])

    const cleared = await session.transaction(async (tx) => await gcOrphanLocks(tx))
    expect(cleared).toBe(1)
    expect(await listOrphanLocks(harness.db)).toHaveLength(0)
    // 活着那个 op 的锁没被顺手清掉。
    expect(
      await harness.db
        .select()
        .from(skillOperationLocks)
        .where(eq(skillOperationLocks.opId, liveOp)),
    ).toHaveLength(1)

    await session.transaction(async (tx) => await abandonOperation(tx, liveOp))
  })

  test('⑦ op 走完 intent → db-committed → 收尾，锁随之释放', async () => {
    const appHome = appHomeDir()
    const { id } = await seed(harness.db, appHome, 'phase-ladder')
    const session = databaseSessionFor(harness.db)

    const opId = await session.transaction(
      async (tx) =>
        await beginOperation(tx, {
          skillId: id,
          kind: 'version-write',
          targetVersion: 2,
          preconditionJson: JSON.stringify({ skillId: id }),
        }),
    )
    for (const phase of ['fs-staged', 'fs-captured', 'fs-versioned', 'fs-published'] as const) {
      await session.transaction(async (tx) => await advancePhase(tx, opId, phase))
    }
    await session.transaction(async (tx) => await advancePhase(tx, opId, 'db-committed'))
    await session.transaction(async (tx) => await finishOperation(tx, opId))

    expect(await listActiveOps(harness.db)).toHaveLength(0)
    expect(
      await harness.db.select().from(skillOperationLocks).where(eq(skillOperationLocks.opId, opId)),
    ).toHaveLength(0)
    // 删除仍然可用——锁真的释放了，不是只把 active 置零。
    await deleteSkill(harness.db, { appHome }, id, ACTOR)
    expect(await harness.db.select().from(skills).where(eq(skills.id, id))).toHaveLength(0)
  })
})
