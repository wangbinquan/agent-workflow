// RFC-359 W10 —— 「这个用户被授权了哪些资源、什么档位」：合一后那一份实现的**双引擎对拍**。
//
// # 这一对是什么，为什么两本账本同时看不见它
//
// 合一前这是一对分叉：中立侧 `infrastructure/resourceVisibility.ts` 的
// `createResourceGrantReadPort`（三个方法），SQLite 侧
// `infrastructure/sqliteResourceGrantRepository.ts` 里**同名的三个自由函数**——逐字相同的
// SELECT，只差参数写成 `DbClient`。
//   - `rfc359-w5-t17-provider-file-location.test.ts` 只按**文件名**清点 provider 命名文件，
//     它看得见 `sqliteResourceGrantRepository.ts` 是一条债，但看不见「它和谁重复」；
//   - `rfc359-w5-provider-pair-conformance.test.ts` 的成对判据要求两侧**同目录、去掉引擎前缀后
//     同名**——这一对一侧叫 `sqliteResourceGrantRepository`、另一侧叫 `resourceVisibility`，
//     **判据当场失明**，于是它只以一个「独苗」的面目出现。
// 分叉却是同一种，而且比一般的两侧分叉更险：**两份在同一个 SQLite 进程里同时被调用**
// （中立那份喂授权应用层，legacy 那份被 `legacy/agent.ts` / `legacy/resourceRefs.ts` /
// `task-execution/infrastructure/legacyCallClosure.ts` 直接调用）。
//
// # 为什么这是**用户可见**的面
//
// 这三个读法的答案直接决定用户在界面上看到什么：
//   - `listGrantedResourceIds` —— 私有资源出不出现在「代理 / 技能 / 工作流」等列表里
//     （`application/resourceAuthorization.ts` 的 `filterVisibleRows`），以及工作流引用检查
//     判不判「引用了你无权使用的资源」（`legacy/resourceRefs.ts`）；
//   - `loadGrantLevel` —— 单行的 access 档位，即「编辑」按钮能不能点（read ⇒ 只读）；
//   - `loadGrantLevelsForUser` —— 列表页每一行的 access 徽章（批量版）。
// 所以「同一份授权数据，在两个引擎上答不答得一样」是一条纯用户可见的判据。
//
// # 这份对拍锁什么
//
// 现在两个引擎跑的是**同一份**实现，所以它锁的是：这份中立实现在两个引擎上给用户的结果逐字
// 相同——空集 / 档位取值 / 跨类型隔离 / 分批边界都不因引擎而变。第一条 test 是**正向对照**：
// 只断言「都为空 / 都为 null」的用例，被一个「永远返回空集」的实现也能满足；所以每一条否定
// 断言旁边都钉着一条肯定断言，用同一次种数据同时验两侧。
//
// 另有一条**函数同一性锁**（不进双引擎块，纯静态）：legacy 那份必须**就是**中立那份，
// 谁再 fork 一份逐字相同的回来，`toBe` 立刻红——这比任何行为断言都早一步拦住漂移。

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { resourceGrants, users } from '@/db/schema'
import * as neutralGrants from '@/modules/resource-catalog/infrastructure/resourceVisibility'
import * as sqliteGrants from '@/modules/resource-catalog/infrastructure/sqliteResourceGrantRepository'
import { describeEachProvider } from './helpers/eachProvider'

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_w10_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

function actorFor(userId: string): Actor {
  return buildActor({
    user: { id: userId, username: userId, displayName: userId, role: 'user', status: 'active' },
    source: 'session',
  })
}

async function grant(
  db: ProviderNeutralDatabase,
  input: Readonly<{
    type: 'agent' | 'workflow' | 'skill'
    resourceId: string
    userId: string
    level: 'read' | 'write'
  }>,
): Promise<void> {
  await db.insert(resourceGrants).values({
    resourceType: input.type,
    resourceId: input.resourceId,
    userId: input.userId,
    level: input.level,
    addedBy: input.userId,
    addedAt: 1,
  })
}

// 谁再 fork 一份逐字相同的实现回来，`toBe` 立刻红——那会是另一个函数对象。
// 这条锁不需要库，所以放在双引擎块外面，一次就够。
test('实现同一性锁：授权集的三个 async 读只有一份实现', () => {
  for (const name of [
    'listGrantedResourceIds',
    'loadGrantLevel',
    'loadGrantLevelsForUser',
  ] as const) {
    expect(typeof neutralGrants[name], `${name} 在中立模块里应当是个函数`).toBe('function')
    expect(sqliteGrants[name], `${name} 又被 fork 成了第二份实现`).toBe(neutralGrants[name])
  }
  // `*InTx` 只在 SQLite 侧存在：中立模块不该长出同名的东西（否则上面那条锁会变成自证）。
  for (const name of [
    'listGrantedResourceIdsInTx',
    'listResourceGrantsInTx',
    'listResourceGrantUserIdsInTx',
    'loadGrantLevelInTx',
  ] as const) {
    expect(typeof sqliteGrants[name], `${name} 应当仍是 SQLite 侧的同步读`).toBe('function')
    expect(name in neutralGrants, `${name} 不该出现在中立模块里`).toBe(false)
  }
})

describeEachProvider('RFC-359 W10 —— 授权集读法的双引擎对拍', (harness) => {
  test('被授权集合：命中与不命中在两个引擎上是同一个答案，且跨资源类型隔离', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const grantee = await seedUser(db)
    const stranger = await seedUser(db)
    const agentId = `a_${ulid()}`
    const workflowId = `w_${ulid()}`
    await grant(db, { type: 'agent', resourceId: agentId, userId: grantee, level: 'read' })
    await grant(db, { type: 'workflow', resourceId: workflowId, userId: grantee, level: 'write' })

    // 肯定断言（正向对照的另一半）：被授权的那一个确实回来了……
    expect(await sqliteGrants.listGrantedResourceIds(db, actorFor(grantee), 'agent')).toEqual(
      new Set([agentId]),
    )
    // ……而且**只**回来那一个：另一个资源类型的授权不许串味。
    expect(await sqliteGrants.listGrantedResourceIds(db, actorFor(grantee), 'workflow')).toEqual(
      new Set([workflowId]),
    )
    expect(await sqliteGrants.listGrantedResourceIds(db, actorFor(grantee), 'skill')).toEqual(
      new Set(),
    )
    // 否定断言：没被授权的人拿到空集。
    expect(await sqliteGrants.listGrantedResourceIds(db, actorFor(stranger), 'agent')).toEqual(
      new Set(),
    )
    expect(await sqliteGrants.listGrantedResourceIds(db, actorFor(owner), 'agent')).toEqual(
      new Set(),
    )
  })

  test('档位：read / write 逐字回传，未授权是 null（不是 read，也不是抛错）', async () => {
    const db = harness.db
    const reader = await seedUser(db)
    const writer = await seedUser(db)
    const stranger = await seedUser(db)
    const agentId = `a_${ulid()}`
    await grant(db, { type: 'agent', resourceId: agentId, userId: reader, level: 'read' })
    await grant(db, { type: 'agent', resourceId: agentId, userId: writer, level: 'write' })

    expect(await sqliteGrants.loadGrantLevel(db, 'agent', agentId, reader)).toBe('read')
    expect(await sqliteGrants.loadGrantLevel(db, 'agent', agentId, writer)).toBe('write')
    expect(await sqliteGrants.loadGrantLevel(db, 'agent', agentId, stranger)).toBeNull()
    // 同一个 (resourceId, userId) 换个资源类型：不许命中。
    expect(await sqliteGrants.loadGrantLevel(db, 'workflow', agentId, reader)).toBeNull()
    // 不存在的资源 id：null，不是抛错。
    expect(await sqliteGrants.loadGrantLevel(db, 'agent', `a_${ulid()}`, reader)).toBeNull()
  })

  test('批量档位跨过 500 的分批边界：两个引擎给同一张表，且未授权的 id 不出现在结果里', async () => {
    const db = harness.db
    const grantee = await seedUser(db)
    // 分批口径是 500。取 501 个被授权 id，强制走到第二批——分批只在这个边界之后才有行为。
    const grantedIds = Array.from(
      { length: 501 },
      (_, index) => `a_w10_${String(index).padStart(4, '0')}`,
    )
    for (let index = 0; index < grantedIds.length; index += 100) {
      await db.insert(resourceGrants).values(
        grantedIds.slice(index, index + 100).map((resourceId) => ({
          resourceType: 'agent' as const,
          resourceId,
          userId: grantee,
          level: (resourceId.endsWith('0') ? 'write' : 'read') as 'read' | 'write',
          addedBy: grantee,
          addedAt: 1,
        })),
      )
    }
    const ungranted = `a_w10_ungranted`
    const levels = await sqliteGrants.loadGrantLevelsForUser(
      db,
      'agent',
      [...grantedIds, ungranted],
      grantee,
    )
    // 肯定断言：501 个全部回来了（丢批 / 只跑第一批会停在 500）。
    expect(levels.size).toBe(grantedIds.length)
    // 逐字断言档位，而不是只数个数——「永远返回 'read'」的实现也能满足计数。
    expect(levels.get('a_w10_0000')).toBe('write')
    expect(levels.get('a_w10_0001')).toBe('read')
    expect(levels.get('a_w10_0500')).toBe('write')
    // 否定断言：没授权的 id 不许凭空出现。
    expect(levels.has(ungranted)).toBe(false)
  })

  test('legacy 名字与中立端口在同一个库上答案逐字相同（名字已经只是名字）', async () => {
    const db = harness.db
    const grantee = await seedUser(db)
    const agentId = `a_${ulid()}`
    await grant(db, { type: 'agent', resourceId: agentId, userId: grantee, level: 'write' })
    const port = neutralGrants.createResourceGrantReadPort(db)
    const actor = actorFor(grantee)

    expect(await port.listGrantedResourceIds(actor, 'agent')).toEqual(
      await sqliteGrants.listGrantedResourceIds(db, actor, 'agent'),
    )
    expect(await port.loadGrantLevel('agent', agentId, grantee)).toBe(
      await sqliteGrants.loadGrantLevel(db, 'agent', agentId, grantee),
    )
    expect(await port.loadGrantLevelsForUser('agent', [agentId], grantee)).toEqual(
      await sqliteGrants.loadGrantLevelsForUser(db, 'agent', [agentId], grantee),
    )
    // 正向对照：上面三条在「两侧都返回空」时也会过，所以这里钉住它们不是空的。
    expect(await port.loadGrantLevel('agent', agentId, grantee)).toBe('write')
  })
})
