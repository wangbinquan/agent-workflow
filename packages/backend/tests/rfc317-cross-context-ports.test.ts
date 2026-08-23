// RFC-317 T41（findings TP-03 / DE-01 / DE-02）—— 三条新端口的行为回归。
//
// 为什么这些测试存在：T41 把三处**跨界直查**换成了 public 端口。换掉的是「谁来执行
// 这条查询」，不是「查询算什么」——所以每条都必须有一个能证明语义逐条不变的用例，
// 否则「重构没改行为」这句话就只是声明。
//
//   · `UserAccessFenceReader`（identity-access）—— 原本是 `ws/registry.ts` 里手写的
//     `SELECT status, access_revision FROM users WHERE id = ?`。那条字符串在列改名时
//     **typecheck 全绿、运行期在授权围栏上失败**，且不是 import 边，任何架构守卫都看不见。
//   · `LegacyMissionDrainPort`（digital-employee 声明 / development-automation 实现）——
//     原本通用 OS 直接查 development 的四张 Mission 表并抄了一份审批终态词表。
//   · `EmployeeReactionRoundQueryPort`（digital-employee）—— 原本 development-automation
//     直接查 OS 的私表，读它冻结的 planJson，并按 `state === 'completed'` 过滤。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import {
  developmentApprovalSagas,
  developmentMissionLinks,
  developmentMissions,
  developmentMrClaims,
  developmentStepRuns,
  employeeCases,
  employeeReactionRounds,
  users,
} from '@/db/schema'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { createLegacyMissionDrainPort } from '@/modules/development-automation/composition/legacyMissionDrain'
import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { createUser } from '@/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-317 T41 · TP-03 —— identity-access 的同步授权围栏读', () => {
  test('返回账号状态与授权版本；查无此人返回 null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
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
    const db = createInMemoryDb(MIGRATIONS)
    const user = await createUser(db, {
      username: 'fence-revoked',
      displayName: 'Fence Revoked',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const fence = composeIdentityAccess(db).authorityFence

    // 直接写库而不是走命令：这里要锁的是「围栏读到的是**已提交的**行」，
    // 与是哪条命令写的无关——WS 发帧路径正是在通知丢失时靠它兜底的。
    db.update(users).set({ status: 'disabled', accessRevision: 7 }).run()
    expect(fence.readAuthorityFence(user.id)).toEqual({ status: 'disabled', accessRevision: 7 })
  })

  test('**同步**返回，不是 Promise —— 异步化会让判定落到帧发出之后', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const result = composeIdentityAccess(db).authorityFence.readAuthorityFence('anyone')
    expect(result instanceof Promise).toBe(false)
  })
})

describe('RFC-317 T41 · DE-01 —— 旧 Mission 排空视图', () => {
  const seedMission = (db: ReturnType<typeof createInMemoryDb>, id: string, terminal: boolean) => {
    db.insert(developmentMissions)
      .values({
        id,
        status: terminal ? 'completed' : 'running',
        repositoryId: 'repo-1',
        sourceKind: 'direct',
        deliveryKind: 'merge-request',
        createdAt: 1,
        updatedAt: 1,
        ...(terminal ? { terminalAt: 2 } : {}),
      })
      .run()
  }

  test('只数未终结的 Mission（terminalAt 为 NULL）', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const drain = createLegacyMissionDrainPort(db)
    expect(drain.openMissionCount(db)).toBe(0)

    seedMission(db, 'open-1', false)
    seedMission(db, 'closed-1', true)
    expect(drain.openMissionCount(db)).toBe(1)
  })

  /**
   * 审批 saga 行挂在 step run 上，step run 又挂在 mission 上。这里把这条外键链一次性
   * 补齐——本组断言只关心「未决审批计数」，链上的业务语义不参与。
   */
  const seedStepRun = (db: ReturnType<typeof createInMemoryDb>, id: string, missionId: string) => {
    db.insert(developmentStepRuns)
      .values({
        id,
        missionId,
        employeeId: 'employee-1',
        employeeRevision: 1,
        stepId: 'approval',
        // 唯一键是 (mission, employee, revision, step, attempt, inputDigest)——
        // 同一个 mission 上播多条时必须让 digest 各不相同。
        inputDigest: `digest-${id}`,
        producerKind: 'platform',
        createdAt: 2,
        updatedAt: 2,
      })
      .run()
    return id
  }

  const seedApproval = (
    db: ReturnType<typeof createInMemoryDb>,
    input: { id: string; missionId: string; latestStatus: string },
  ) => {
    const stepRunId = seedStepRun(db, `step-${input.id}`, input.missionId)
    db.insert(developmentApprovalSagas)
      .values({
        id: input.id,
        missionId: input.missionId,
        stepRunId,
        adapterId: 'adapter-1',
        adapterRevision: 1,
        draftRef: 'draft-1',
        submitIntentDigest: 'intent-digest',
        idempotencyKey: `key-${input.id}`,
        latestStatus: input.latestStatus,
        deadlineAt: 10_000,
        createdAt: 2,
        updatedAt: 2,
      })
      .run()
  }

  test('排空报告带上活跃 MR 认领 / 子链接 / 未决审批三项计数', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedMission(db, 'parent-1', false)
    seedMission(db, 'child-1', false)
    db.insert(developmentMrClaims)
      .values({
        id: 'claim-1',
        codeHostEndpointRef: 'endpoint-1',
        stableProjectRef: 'project-1',
        mrIid: '7',
        missionId: 'parent-1',
        epoch: 1,
        state: 'active',
        createdAt: 2,
      })
      .run()
    db.insert(developmentMissionLinks)
      .values({
        id: 'link-1',
        parentMissionId: 'parent-1',
        parentStepRunId: seedStepRun(db, 'step-link-1', 'parent-1'),
        targetRepositoryId: 'repo-1',
        targetEmployeeId: 'employee-1',
        targetEmployeeRevision: 1,
        inputDigest: 'link-digest',
        idempotencyKey: 'link-key',
        childMissionId: 'child-1',
        completion: 'await-terminal',
        createdAt: 2,
        updatedAt: 2,
      })
      .run()
    seedApproval(db, { id: 'saga-1', missionId: 'parent-1', latestStatus: 'pending' })

    const report = createLegacyMissionDrainPort(db).drainReport(10)
    expect(report.truncated).toBe(false)
    // 顺序是端口契约的一部分：按 (createdAt, id) 升序。两条 createdAt 相同，
    // 于是按 id —— 'child-1' 在 'parent-1' 之前。截断判据（下一条用例）依赖这个
    // 确定顺序，报告页的分页也依赖它，所以这里逐条断言而不是用 arrayContaining。
    expect(report.entries).toEqual([
      {
        missionId: 'child-1',
        status: 'running',
        activeMrClaimCount: 0,
        childLinkCount: 0,
        pendingApprovalCount: 0,
      },
      {
        missionId: 'parent-1',
        status: 'running',
        activeMrClaimCount: 1,
        childLinkCount: 1,
        pendingApprovalCount: 1,
      },
    ])
  })

  test('**已了结**的审批不计入未决数（这份终态词表归 development-automation）', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedMission(db, 'settled-1', false)
    for (const [index, status] of ['approved', 'rejected', 'expired', 'unavailable'].entries()) {
      seedApproval(db, {
        id: `saga-settled-${index}`,
        missionId: 'settled-1',
        latestStatus: status,
      })
    }
    expect(createLegacyMissionDrainPort(db).drainReport(10).entries[0]?.pendingApprovalCount).toBe(
      0,
    )
  })

  test('超过 limit 时如实标 truncated（报告不能假装自己是全部）', () => {
    const db = createInMemoryDb(MIGRATIONS)
    for (let index = 0; index < 4; index += 1) seedMission(db, `bulk-${index}`, false)
    const report = createLegacyMissionDrainPort(db).drainReport(2)
    expect(report.truncated).toBe(true)
    expect(report.entries).toHaveLength(2)
  })
})

describe('RFC-317 T41 · DE-02 —— 反应轮次只读查询面', () => {
  /** case 行是轮次行的外键前提；这里只填必填列，业务语义不参与本组断言。 */
  const seedCase = (db: ReturnType<typeof createInMemoryDb>, caseId: string) => {
    db.insert(employeeCases)
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
      .run()
  }

  const seedRound = (
    db: ReturnType<typeof createInMemoryDb>,
    round: {
      id: string
      caseId: string
      workItemRef: string
      /** 轮次状态是闭合联合——写成 string 会让「拿一个不存在的态去播种」编译期通不过的保护失效。 */
      state: 'planned' | 'running' | 'settling' | 'completed' | 'failed' | 'obsolete'
      settledAt: number | null
    },
  ) => {
    seedCase(db, round.caseId)
    db.insert(employeeReactionRounds)
      .values({
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
      .run()
  }

  test('frozenPlan 按 roundRef 取回 caseId 与冻结计划；查无返回 null', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedRound(db, {
      id: 'round-1',
      caseId: 'case-1',
      workItemRef: 'observe-mr',
      state: 'running',
      settledAt: null,
    })
    const queries = createEmployeeReactionRoundQueries(db)
    expect(queries.frozenPlan('round-1')).toEqual({
      caseId: 'case-1',
      planJson: JSON.stringify({ roundRef: 'round-1' }),
    })
    expect(queries.frozenPlan('missing')).toBeNull()
  })

  test('lastSettledRound 只认已结算的轮次，并取 settledAt 最晚的那条', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedRound(db, {
      id: 'repair-early',
      caseId: 'case-1',
      workItemRef: 'repair-conflict',
      state: 'completed',
      settledAt: 100,
    })
    seedRound(db, {
      id: 'repair-late',
      caseId: 'case-1',
      workItemRef: 'repair-conflict',
      state: 'completed',
      settledAt: 200,
    })
    // 未结算的那条不能被选中——这正是原来散在别人 where 子句里的 `state === 'completed'`。
    seedRound(db, {
      id: 'repair-running',
      caseId: 'case-1',
      workItemRef: 'repair-conflict',
      state: 'running',
      settledAt: 300,
    })
    const queries = createEmployeeReactionRoundQueries(db)
    expect(queries.lastSettledRound({ caseId: 'case-1', workItemRef: 'repair-conflict' })).toEqual({
      roundRef: 'repair-late',
    })
  })

  test('caseId / workItemRef 都参与过滤（串台会把别的 case 的修复结果当成自己的）', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedRound(db, {
      id: 'other-case',
      caseId: 'case-2',
      workItemRef: 'repair-conflict',
      state: 'completed',
      settledAt: 100,
    })
    seedRound(db, {
      id: 'other-item',
      caseId: 'case-1',
      workItemRef: 'observe-mr',
      state: 'completed',
      settledAt: 100,
    })
    expect(
      createEmployeeReactionRoundQueries(db).lastSettledRound({
        caseId: 'case-1',
        workItemRef: 'repair-conflict',
      }),
    ).toBeNull()
  })
})
