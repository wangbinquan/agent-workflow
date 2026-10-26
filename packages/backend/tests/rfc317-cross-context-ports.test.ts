import { assertFixedWriterInstallation } from './helpers/model/writerInstallation'
// RFC-395 II-pre：用户夹具改接生产 identity-access 运行时，保留原用例意图。
// RFC-317 T41（findings TP-03 / DE-01 / DE-02）—— 三条新端口的行为回归。
//
// 为什么这些测试存在：T41 把三处**跨界直查**换成了 public 端口。换掉的是「谁来执行
// 这条查询」，不是「查询算什么」——所以每条都必须有一个能证明语义逐条不变的用例，
// 否则「重构没改行为」这句话就只是声明。
//
//   · `UserAccessFenceReader`（identity-access）—— 原本是 `ws/registry.ts` 里手写的
//     `SELECT status, access_revision FROM users WHERE id = ?`。那条字符串在列改名时
//     **typecheck 全绿、运行期在授权围栏上失败**，且不是 import 边，任何架构守卫都看不见。
//   · RFC-395 后 DE-01 使用显式 installation 的固定 writer view；旧 drain 扫描已退役。
//   · `EmployeeReactionRoundQueryPort`（digital-employee）—— 原本 development-automation
//     直接查 OS 的私表，读它冻结的 planJson，并按 `state === 'completed'` 过滤。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryWrite } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'

import { createInMemoryDb } from '@/db/client'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { createUser } from './helpers/userFixture'

// RFC-359：这一块**有意留在单引擎**。`readAuthorityFence` 是 WS 发帧热路径上的**同步**读
// ——帧要在当前 tick 内定夺，改 async 会让判定落到下一个微任务、而帧那时已经发出去了。
// 能力矩阵的 `readRowSync` 只有 bun:sqlite 给得出；PostgreSQL 上围栏读的是进程内的
// `AuthorityFenceCache`（授权读预热 + 写事务提交后刷新，RFC-349 的单 daemon 世代前提下
// 它**就是**围栏本身）。本块断言的正是「直接改库之后同步读立刻看得见」，那条语义按定义
// 只在 SQLite 上成立——拿双引擎 harness 跑它等于断言 PG 必须有一个它按设计就没有的能力。
describe('RFC-317 T41 · TP-03 —— identity-access 的同步授权围栏读', () => {
  test('返回账号状态与授权版本；查无此人返回 null', async () => {
    const db = createInMemoryDb()
    const user = await createUser(db, {
      username: 'fence-subject',
      displayName: 'Fence Subject',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const fence = composeIdentityAccess(db).authorityFence

    expect(fence.readAuthorityFence(user.id)).toEqual({ status: 'active', accessRevision: 0 })
    expect(fence.readAuthorityFence('nobody')).toBeNull()
  })

  test('账号被停用 / 授权版本前进后，围栏立刻看得见（这正是它存在的理由）', async () => {
    const db = createInMemoryDb()
    const user = await createUser(db, {
      username: 'fence-revoked',
      displayName: 'Fence Revoked',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const fence = composeIdentityAccess(db).authorityFence

    const { users } = tablesOf(db)
    // 直接写库而不是走命令：这里要锁的是「围栏读到的是**已提交的**行」，
    // 与是哪条命令写的无关——WS 发帧路径正是在通知丢失时靠它兜底的。
    queryWrite(db.update(users).set({ status: 'disabled', accessRevision: 7 }))
    expect(fence.readAuthorityFence(user.id)).toEqual({ status: 'disabled', accessRevision: 7 })
  })

  test('**同步**返回，不是 Promise —— 异步化会让判定落到帧发出之后', () => {
    const db = createInMemoryDb()
    const result = composeIdentityAccess(db).authorityFence.readAuthorityFence('anyone')
    expect(result instanceof Promise).toBe(false)
  })
})

describeEachProvider('RFC-317 T41 · DE-01 installed writer view', (harness) => {
  test('installation supplies the fixed mode, generation and empty drain report', async () => {
    await assertFixedWriterInstallation(harness.db)
  })
})

describeEachProvider('RFC-317 T41 · DE-02 —— 反应轮次只读查询面', (harness) => {
  /** case 行是轮次行的外键前提；这里只填必填列，业务语义不参与本组断言。 */
  const seedCase = async (db: PersistenceDb, caseId: string) => {
    const { employeeCases } = tablesOf(db)
    await db
      .insert(employeeCases)
      .values({
        id: caseId,
        employeeId: 'employee-1',
        employeeRevision: 1,
        typeId: 'development',
        typeRevision: 1,
        primaryContextId: 'context-1',
        executionPolicyRevision: 1,
        state: 'active',
        createdAt: 1,
        updatedAt: 1,
      })
      .onConflictDoNothing()
  }

  const seedRound = async (
    db: PersistenceDb,
    round: {
      id: string
      caseId: string
      workItemRef: string
      /** 轮次状态是闭合联合——写成 string 会让「拿一个不存在的态去播种」编译期通不过的保护失效。 */
      state: 'planned' | 'running' | 'settling' | 'completed' | 'failed' | 'obsolete'
      settledAt: number | null
    },
  ) => {
    await seedCase(db, round.caseId)
    const { employeeReactionRounds } = tablesOf(db)
    await insertOne(db, employeeReactionRounds, {
      id: round.id,
      caseId: round.caseId,
      caseRevision: 1,
      employeeId: 'employee-1',
      employeeRevision: 1,
      ruleId: 'rule-1',
      workItemRef: round.workItemRef,
      workContractId: 'contract-1',
      workContractVersion: 1,
      executionPolicyRevision: 1,
      inputContextRefsJson: '[]',
      state: round.state,
      attemptOrdinal: 0,
      planJson: JSON.stringify({ roundRef: round.id }),
      createdAt: 1,
      updatedAt: 1,
      ...(round.settledAt === null ? {} : { settledAt: round.settledAt }),
    })
  }

  test('frozenPlan 按 roundRef 取回 caseId 与冻结计划；查无返回 null', async () => {
    const db = harness.db
    await seedRound(db, {
      id: 'round-1',
      caseId: 'case-1',
      workItemRef: 'observe-mr',
      state: 'running',
      settledAt: null,
    })
    const queries = createEmployeeReactionRoundQueries(db)
    expect(await queries.frozenPlan('round-1')).toEqual({
      caseId: 'case-1',
      planJson: JSON.stringify({ roundRef: 'round-1' }),
    })
    expect(await queries.frozenPlan('missing')).toBeNull()
  })

  test('lastSettledRound 只认已结算的轮次，并取 settledAt 最晚的那条', async () => {
    const db = harness.db
    await seedRound(db, {
      id: 'repair-early',
      caseId: 'case-1',
      workItemRef: 'repair-conflict',
      state: 'completed',
      settledAt: 100,
    })
    await seedRound(db, {
      id: 'repair-late',
      caseId: 'case-1',
      workItemRef: 'repair-conflict',
      state: 'completed',
      settledAt: 200,
    })
    // 未结算的那条不能被选中——这正是原来散在别人 where 子句里的 `state === 'completed'`。
    await seedRound(db, {
      id: 'repair-running',
      caseId: 'case-1',
      workItemRef: 'repair-conflict',
      state: 'running',
      settledAt: 300,
    })
    const queries = createEmployeeReactionRoundQueries(db)
    expect(
      await queries.lastSettledRound({ caseId: 'case-1', workItemRef: 'repair-conflict' }),
    ).toEqual({
      roundRef: 'repair-late',
    })
  })

  test('caseId / workItemRef 都参与过滤（串台会把别的 case 的修复结果当成自己的）', async () => {
    const db = harness.db
    await seedRound(db, {
      id: 'other-case',
      caseId: 'case-2',
      workItemRef: 'repair-conflict',
      state: 'completed',
      settledAt: 100,
    })
    await seedRound(db, {
      id: 'other-item',
      caseId: 'case-1',
      workItemRef: 'observe-mr',
      state: 'completed',
      settledAt: 100,
    })
    expect(
      await createEmployeeReactionRoundQueries(db).lastSettledRound({
        caseId: 'case-1',
        workItemRef: 'repair-conflict',
      }),
    ).toBeNull()
  })
})
