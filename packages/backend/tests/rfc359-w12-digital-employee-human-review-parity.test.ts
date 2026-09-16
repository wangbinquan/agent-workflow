// RFC-359 —— 数字员工「计划人审」闸门：同一个 executionRef，两个引擎给出同一个状态。
//
// 为什么这条测试存在：`inspectHumanReview` 此前是**同步**端口，只有 SQLite 那侧的 composition
// 提供——`composeDigitalEmployeeExecution` 根本没有实现它。于是在 PostgreSQL 上闸门状态
// 只能退回按 round 状态推断（`planning` / `approved` / `failed`），**永远报不出 `waiting`**：
// 同一个案子在 SQLite 上显示「等待人审」、在 PG 上显示「规划中」。那是用户可见的行为分叉，
// 也正是本 RFC 要消灭的形态。
//
// 修法是把判定收成一份 **async 的中立实现**（查的是 `tasks` + `nodeRuns`，本来就没有方言），
// 两侧 composition 都装它——SQLite 侧直接拿 db 调，PG 侧按 `humanReview` 端口接进来。
// 本文件锁两件事：
//   ① 五个状态在两个引擎上逐字相同（planning / waiting / approved / failed / null）；
//   ② **两侧 composition 都必须交出 `inspectHumanReview`**——这是那条分叉的源头，
//      少了任何一侧，PG 上的闸门就又会退回推断。

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, workflows } from '@/db/schema'
import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  composeDigitalEmployeeExecution,
  inspectDigitalEmployeeHumanReviewState,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import {
  DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY,
  DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import { describeEachProvider } from './helpers/eachProvider'

async function seedExecution(
  db: ProviderNeutralDatabase,
  opts: { readonly planPrompt: boolean },
): Promise<string> {
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
  })
  const taskId = `task_${ulid()}`
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/rfc359-human-review',
    worktreePath: '/tmp/rfc359-human-review',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: opts.planPrompt
      ? JSON.stringify({ [DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]: 'frozen plan prompt' })
      : '{}',
    startedAt: 1,
  })
  return taskId
}

async function seedReviewRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  status: string,
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID,
    iteration: 0,
    retryIndex: 0,
    status: status as 'done',
    startedAt: 1,
  })
}

describeEachProvider('RFC-359 —— 计划人审闸门状态两个引擎一致', (harness) => {
  test('查无此任务 ⇒ null；没有计划 prompt 的任务也 ⇒ null（不是数字员工执行）', async () => {
    const db = harness.db
    expect(await inspectDigitalEmployeeHumanReviewState(db, `missing_${ulid()}`)).toBeNull()
    const plain = await seedExecution(db, { planPrompt: false })
    expect(await inspectDigitalEmployeeHumanReviewState(db, plain)).toBeNull()
  })

  test('有计划 prompt、还没有评审 run ⇒ planning', async () => {
    const db = harness.db
    const taskId = await seedExecution(db, { planPrompt: true })
    expect(await inspectDigitalEmployeeHumanReviewState(db, taskId)).toBe('planning')
  })

  test('评审 run 停在 awaiting_review ⇒ waiting（PG 上此前根本报不出这一格）', async () => {
    const db = harness.db
    const taskId = await seedExecution(db, { planPrompt: true })
    await seedReviewRun(db, taskId, 'awaiting_review')
    expect(await inspectDigitalEmployeeHumanReviewState(db, taskId)).toBe('waiting')
  })

  test('评审 run done ⇒ approved', async () => {
    const db = harness.db
    const taskId = await seedExecution(db, { planPrompt: true })
    await seedReviewRun(db, taskId, 'done')
    expect(await inspectDigitalEmployeeHumanReviewState(db, taskId)).toBe('approved')
  })

  test.each(['failed', 'canceled', 'interrupted', 'skipped', 'exhausted'])(
    '评审 run %s ⇒ failed',
    async (status) => {
      const db = harness.db
      const taskId = await seedExecution(db, { planPrompt: true })
      await seedReviewRun(db, taskId, status)
      expect(await inspectDigitalEmployeeHumanReviewState(db, taskId)).toBe('failed')
    },
  )

  test('装配锁：唯一那份 composition 交出 `inspectHumanReview`，且库内缺省端口不是桩', async () => {
    // RFC-359 AC-1（plan §5hl）：两份 composition 已合成一份，所以「两侧都要交出这个方法」
    // 退化成「这一份交出它」。**分叉的源头换了形状但没消失**：现在的风险是装配方
    // 忘了给 `humanReview` 端口、或给了个桩。所以这条同时锁住库内缺省实现
    // （`composeDatabaseDigitalEmployeeExecutionPorts`）读出来的答案与中立实现逐字相同。
    const db = harness.db
    const taskId = await seedExecution(db, { planPrompt: true })
    // 种成 `waiting` 那一格——正是 PG 侧此前报不出来的那一格。桩会答不出它。
    await seedReviewRun(db, taskId, 'awaiting_review')
    const ports = composeDatabaseDigitalEmployeeExecutionPorts(db)
    const execution = composeDigitalEmployeeExecution({
      // 只看端口在不在 / 通不通——别的依赖一个都不碰，所以全给 never。
      appHome: '/tmp/rfc359-human-review',
      resolveActor: null as never,
      resourceAuthorityFor: null as never,
      launch: null as never,
      ...ports,
      agents: null as never,
      workflows: null as never,
      executionContracts: null as never,
    })
    expect(typeof execution.inspectHumanReview).toBe('function')
    expect(await execution.inspectHumanReview!(taskId)).toBe(
      await inspectDigitalEmployeeHumanReviewState(db, taskId),
    )
    expect(await execution.inspectHumanReview!(taskId)).toBe('waiting')
  })

  test('端口确实被转交（装什么就读到什么）', async () => {
    const calls: string[] = []
    const execution = composeDigitalEmployeeExecution({
      appHome: '/tmp/rfc359-human-review',
      resolveActor: null as never,
      resourceAuthorityFor: null as never,
      launch: null as never,
      tasks: null as never,
      readModels: null as never,
      resourceUsage: null as never,
      agents: null as never,
      workflows: null as never,
      executionMetadata: null as never,
      humanReview: {
        inspect: (executionRef) => {
          calls.push(executionRef)
          return Promise.resolve('waiting' as const)
        },
      },
      executionContracts: null as never,
    })
    expect(await execution.inspectHumanReview!('exec-ref')).toBe('waiting')
    expect(calls).toEqual(['exec-ref'])
  })
})
