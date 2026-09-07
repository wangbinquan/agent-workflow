// RFC-359 W10 —— `TaskAuthorizationQueries` / 事务内参与者的双引擎对拍。
//
// # 为什么这一条此前是零覆盖
//
// 「这个人看不看得见这个任务 / 能不能对它动手」是**用户直接看得见**的判定：看不见就是列表少一行、
// 详情 404；不能动手就是取消 / 续跑 / 加协作者被拒。它的唯一实现是
// `infrastructure/taskAuthorization.ts`，两个引擎共用——PostgreSQL 侧由该引擎的任务路由适配器
// 调用，SQLite 侧走 `review.ts` 等 legacy 路径。
//
// （这段刻意不写出 PG 那份路由适配器的**文件名**：`rfc359-w5-t19d-coverage-parity.test.ts` 的
// `ref` 口径是「测试文件提到该侧模块名或其导出符号」，一句注释就能把它的覆盖数顶高一格，
// 而这里并没有给那一对增加任何判据——虚高正是那条守卫头注释点名要防的东西。）
//
// 而在此之前，`describeEachProvider` 里**没有任何一条**判据落在这个端口上：唯一提到它的测试
// （`rfc349-task-transaction-participants.test.ts`）驱动的是 `sqliteTaskAuthorization.ts`——一份
// 自 W1-T2c 起就零生产调用方的同步孪生。也就是说，被跑的那份没人用，在用的那份没人跑。
// 这一刀让同步孪生退役，判据同时搬到真在跑的那份上，并且两个引擎各跑一遍。
//
// # 判据落在用户可见契约上
//
// 三条语义、每条都带正向对照（只断言「拒绝」的用例，一个「永远返回空」的实现也满足）：
//   · **可见性**＝自己是 owner，或自己在 `task_collaborators` 里有一行（**任意角色**，含 observer）；
//   · **可动手**＝在 `task_collaborators` 里的角色是 `owner` / `collaborator`（observer **不算**）
//     ——这正是 CLAUDE.md 记的「任务成员（owner+collaborator）即评审/反问的回答权边界」；
//   · `canReadAllTasks` 的主体绕过可见性判据，但**不因此获得动手权**。
//
// 另外钉住 `SQL_IN_CHUNK` 分块：`visibleTaskIds` 按 500 一批发 `IN`，跨批的行必须一条不丢
// ——分块写错在小数据集上完全看不出来，只有在真实规模的任务列表上表现为「少了几行」。

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, tasks, users, workflows } from '@/db/schema'
import {
  createTaskAuthorizationParticipantInTx,
  createTaskAuthorizationQueries,
} from '@/modules/task-execution/infrastructure/taskAuthorization'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { SQL_IN_CHUNK } from '@/util/sqlChunk'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

interface Seeded {
  /** owner = `alice`，无协作者。 */
  readonly ownedByAlice: string
  /** owner = `bob`，`alice` 是 collaborator。 */
  readonly aliceCollaborates: string
  /** owner = `bob`，`alice` 是 observer（看得见、动不了手）。 */
  readonly aliceObserves: string
  /** owner = `bob`，与 `alice` 完全无关。 */
  readonly foreign: string
}

async function seed(db: ProviderNeutralDatabase): Promise<Seeded> {
  const now = Date.now()
  // `task_collaborators.user_id` 有到 `users` 的外键，PostgreSQL 会真的校验它。
  await db.insert(users).values(
    ['alice', 'bob', 'carol'].map((id) => ({
      id,
      username: id,
      displayName: id,
      createdAt: now,
      updatedAt: now,
    })),
  )
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc359-w10-auth',
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  const mint = async (owner: string): Promise<string> => {
    const id = `w10auth_${ulid()}`
    await db.insert(tasks).values({
      id,
      name: id,
      workflowId,
      workflowSnapshot: SNAPSHOT,
      workflowVersion: 1,
      repoPath: '/tmp/repo',
      worktreePath: `/tmp/worktree/${id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      ownerUserId: owner,
    })
    await db
      .insert(taskCollaborators)
      .values({ taskId: id, userId: owner, role: 'owner', addedBy: owner, addedAt: Date.now() })
    return id
  }
  const ownedByAlice = await mint('alice')
  const aliceCollaborates = await mint('bob')
  await db.insert(taskCollaborators).values({
    taskId: aliceCollaborates,
    userId: 'alice',
    role: 'collaborator',
    addedBy: 'bob',
    addedAt: Date.now(),
  })
  const aliceObserves = await mint('bob')
  await db.insert(taskCollaborators).values({
    taskId: aliceObserves,
    userId: 'alice',
    role: 'observer',
    addedBy: 'bob',
    addedAt: Date.now(),
  })
  const foreign = await mint('bob')
  return { ownedByAlice, aliceCollaborates, aliceObserves, foreign }
}

const alice = { userId: 'alice', canReadAllTasks: false } as const
const aliceReadsAll = { userId: 'alice', canReadAllTasks: true } as const

describeEachProvider('RFC-359 W10 —— 任务可见性 / 动手权双引擎对拍', (harness) => {
  test('可见性：owner 与任意角色的协作行都看得见，无关任务看不见；canReadAllTasks 全部看得见', async () => {
    const ids = await seed(harness.db)
    const queries = createTaskAuthorizationQueries(harness.db)

    expect(await queries.canViewTask({ subject: alice, taskId: ids.ownedByAlice })).toBe(true)
    expect(await queries.canViewTask({ subject: alice, taskId: ids.aliceCollaborates })).toBe(true)
    // observer 也算「看得见」——`visibleIds` 的判据是「有没有协作行」，不看角色。
    expect(await queries.canViewTask({ subject: alice, taskId: ids.aliceObserves })).toBe(true)
    expect(await queries.canViewTask({ subject: alice, taskId: ids.foreign })).toBe(false)

    // 正向对照：拒绝不是因为「什么都看不见」——同一个人换成读全量就看得见了。
    expect(await queries.canViewTask({ subject: aliceReadsAll, taskId: ids.foreign })).toBe(true)
    // 不存在的 id 与空串都是 false（空串在库里永远匹配不到行）。
    expect(await queries.canViewTask({ subject: aliceReadsAll, taskId: `missing_${ulid()}` })).toBe(
      false,
    )
    expect(await queries.canViewTask({ subject: aliceReadsAll, taskId: '' })).toBe(false)
  })

  test('动手权只认 owner / collaborator——observer 看得见但动不了手，读全量也不给动手权', async () => {
    const ids = await seed(harness.db)
    const queries = createTaskAuthorizationQueries(harness.db)

    expect(await queries.canActOnTask({ userId: 'alice', taskId: ids.ownedByAlice })).toBe(true)
    expect(await queries.canActOnTask({ userId: 'alice', taskId: ids.aliceCollaborates })).toBe(
      true,
    )
    // 这一条是「看得见 ≠ 能动手」的判据本体。
    expect(await queries.canViewTask({ subject: alice, taskId: ids.aliceObserves })).toBe(true)
    expect(await queries.canActOnTask({ userId: 'alice', taskId: ids.aliceObserves })).toBe(false)
    expect(await queries.canActOnTask({ userId: 'alice', taskId: ids.foreign })).toBe(false)
    // `canReadAllTasks` 只影响可见性，动手权仍按协作行判。
    expect(await queries.canViewTask({ subject: aliceReadsAll, taskId: ids.foreign })).toBe(true)
    expect(await queries.canActOnTask({ userId: 'alice', taskId: ids.foreign })).toBe(false)
  })

  test('visibleTaskIds 只回可见的那些，且跨 SQL_IN_CHUNK 分块一条不丢', async () => {
    const ids = await seed(harness.db)
    const queries = createTaskAuthorizationQueries(harness.db)
    const known = [ids.ownedByAlice, ids.aliceCollaborates, ids.aliceObserves, ids.foreign]

    expect([...(await queries.visibleTaskIds({ subject: alice, taskIds: known }))].sort()).toEqual(
      [ids.ownedByAlice, ids.aliceCollaborates, ids.aliceObserves].sort(),
    )
    expect([...(await queries.visibleTaskIds({ subject: alice, taskIds: [] }))]).toEqual([])

    // 分块：用足量的假 id 把两个可见任务推到**不同批次**里。第一批全是不存在的 id，
    // 可见的那两条落在第二批——分块写成「只发第一批」的实现会在这里丢行。
    const padding = Array.from({ length: SQL_IN_CHUNK }, () => `pad_${ulid()}`)
    const chunked = [...padding, ids.ownedByAlice, ids.foreign, ids.aliceCollaborates]
    expect(chunked.length).toBeGreaterThan(SQL_IN_CHUNK)
    expect(
      [...(await queries.visibleTaskIds({ subject: alice, taskIds: chunked }))].sort(),
    ).toEqual([ids.ownedByAlice, ids.aliceCollaborates].sort())
  })

  test('事务内参与者与库外查询给出同一答案（同一份 bind，只是拿到的 reader 不同）', async () => {
    const ids = await seed(harness.db)
    await databaseSessionFor(harness.db).transaction(async (tx) => {
      const participant = createTaskAuthorizationParticipantInTx(tx)
      expect(await participant.canViewTask({ subject: alice, taskId: ids.aliceCollaborates })).toBe(
        true,
      )
      expect(await participant.canViewTask({ subject: alice, taskId: ids.foreign })).toBe(false)
      expect(await participant.canActOnTask({ userId: 'alice', taskId: ids.aliceObserves })).toBe(
        false,
      )
      expect(
        [...(await participant.visibleTaskIds({ subject: alice, taskIds: Object.values(ids) }))]
          .length,
      ).toBe(3)
    })
  })

  test('同一笔事务里刚插入的协作行立刻改变判定（参与者读的是事务内快照，不是提交前的库）', async () => {
    const ids = await seed(harness.db)
    await databaseSessionFor(harness.db).transaction(async (tx) => {
      const participant = createTaskAuthorizationParticipantInTx(tx)
      expect(await participant.canActOnTask({ userId: 'carol', taskId: ids.foreign })).toBe(false)
      await tx.insert(taskCollaborators).values({
        taskId: ids.foreign,
        userId: 'carol',
        role: 'collaborator',
        addedBy: 'bob',
        addedAt: Date.now(),
      })
      expect(await participant.canActOnTask({ userId: 'carol', taskId: ids.foreign })).toBe(true)
      expect(
        await participant.canViewTask({
          subject: { userId: 'carol', canReadAllTasks: false },
          taskId: ids.foreign,
        }),
      ).toBe(true)
    })
  })
})
