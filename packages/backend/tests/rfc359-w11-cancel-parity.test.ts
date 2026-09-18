// RFC-359 AC-1（第 11 刀第 1 步）—— **`cancel` 的准入与级联，两个引擎给同一个答案吗**。
//
// 为什么这条测试存在
// ------------------
// `cancel` 是 `ChildTaskLifecycleParticipant` 剩下的那一半：SQLite 转给 `services/task.ts` 的
// `cancelTask`（251 行），PostgreSQL 转给自己的 `cancelCascade`（151 行）。两份实现各自有测试、
// 各自都绿，**谁也没跟谁比过**——与 `retry` / `resume` 合并前是同一个形状。
//
// W8 当年把这一对判为「不合」，机械证据是「`cancelTask` 的准入预检是 bun:sqlite 的同步读」。
// 第 11 刀的勘察实证那条证据**早就不成立**（RFC-359 自己把它换成了 `await db.select(...)`），
// 而且它一直绿在一段解释这件事的**注释**上。所以这一对现在是待合，不是不能合。
//
// 判据形态（沿用第 9 / 10 刀的配方）
// --------------------------------
// 每一格都走**生产装配**（`createEachProviderTaskExecution` 交出的
// `provider.cancellation.cancel`），两条 lane 上跑的正是各自部署里真正会执行的那份实现；
// 断言的是 `(错误码, 事后任务状态, 事后 node_run 形状)`——**同一个常量喂给两条 lane**。
// 任一侧不同 ⇒ 那条 lane 当场红，逼出一次显式的产品判断。
//
// 实测结论与变异实证
// ------------------
// **七格两侧逐字相同**，一处分叉都没有——这一对比 `retry` / `resume` 合并前更接近。
//
// 变异实证两次（一侧一条，落在不同的格上，证明它确实有预言力而不是「都没跑到所以都绿」）：
//   · 短路 SQLite `cancelTask` 的可取消状态门 ⇒ **只有 sqlite lane 的 B / C 红**；
//   · 短路 PostgreSQL `cancelCascade` 对子任务的递归 ⇒ **只有 postgresql lane 的 F 红**。
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, users, workflows } from '@/db/schema'
import { runGit } from '@/util/git'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'

const USER_ID = 'u_rfc359_w11'

const DEFINITION: WorkflowDefinition = {
  $schema_version: 2,
  inputs: [],
  nodes: [
    { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
  ],
  edges: [],
}

interface Fixture {
  readonly appHome: string
  readonly repoPath: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly cleanup: () => void
}

interface SeedOptions {
  readonly status?: string
  /** 打开着的 node_run 状态；缺省 `running`（取消要把它一并关掉）。 */
  readonly runStatus?: string
  /** 再挂一个处于该状态的子任务（级联那几格用）。 */
  readonly childStatus?: string
  /** 再挂一个处于该状态的**孙**任务（挂在子任务下面，验递归深度）。 */
  readonly grandchildStatus?: string
  /** 额外再铸几条打开着的 node_run（验「关的是全部，不是被点的那一条」）。 */
  readonly extraOpenRuns?: readonly string[]
}

async function seedFixture(
  db: ProviderNeutralDatabase,
  options: SeedOptions = {},
): Promise<
  Fixture & {
    childTaskId: string | null
    grandchildTaskId: string | null
    extraRunIds: readonly string[]
  }
> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc359-w11-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'w11@test.invalid'])
  await runGit(repoPath, ['config', 'user.name', 'w11'])
  writeFileSync(join(repoPath, 'README.md'), '# w11\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, USER_ID))
    .limit(1)
  if (existing.length === 0) {
    await db.insert(users).values({
      id: USER_ID,
      username: USER_ID,
      displayName: USER_ID,
      role: 'admin',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
  }
  const workflowId = ulid()
  await db
    .insert(workflows)
    .values({ id: workflowId, name: `w11-${workflowId}`, definition: JSON.stringify(DEFINITION) })

  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'w11',
    workflowId,
    workflowSnapshot: JSON.stringify(DEFINITION),
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: (options.status ?? 'running') as 'running',
    inputs: '{}',
    startedAt: Date.now() - 1000,
    ownerUserId: USER_ID,
    executionLineageId: taskId,
  })
  const nodeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'doc',
    status: (options.runStatus ?? 'running') as 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 900,
  })

  let childTaskId: string | null = null
  if (options.childStatus !== undefined) {
    childTaskId = ulid()
    await db.insert(tasks).values({
      id: childTaskId,
      name: 'w11-child',
      workflowId,
      workflowSnapshot: JSON.stringify(DEFINITION),
      repoPath,
      worktreePath: repoPath,
      baseBranch: 'main',
      branch: `agent-workflow/${childTaskId}`,
      status: options.childStatus as 'running',
      inputs: '{}',
      startedAt: Date.now() - 800,
      ownerUserId: USER_ID,
      executionLineageId: taskId,
      parentTaskId: taskId,
      parentNodeRunId: nodeRunId,
      invocationDepth: 1,
    })
    await db.update(nodeRuns).set({ childTaskId }).where(eq(nodeRuns.id, nodeRunId))
  }

  let grandchildTaskId: string | null = null
  if (options.grandchildStatus !== undefined) {
    if (childTaskId === null) throw new Error('grandchildStatus 需要先有 childStatus')
    const childRunId = ulid()
    await db.insert(nodeRuns).values({
      id: childRunId,
      taskId: childTaskId,
      nodeId: 'doc',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 700,
    })
    grandchildTaskId = ulid()
    await db.insert(tasks).values({
      id: grandchildTaskId,
      name: 'w11-grandchild',
      workflowId,
      workflowSnapshot: JSON.stringify(DEFINITION),
      repoPath,
      worktreePath: repoPath,
      baseBranch: 'main',
      branch: `agent-workflow/${grandchildTaskId}`,
      status: options.grandchildStatus as 'running',
      inputs: '{}',
      startedAt: Date.now() - 600,
      ownerUserId: USER_ID,
      executionLineageId: taskId,
      parentTaskId: childTaskId,
      parentNodeRunId: childRunId,
      invocationDepth: 2,
    })
    await db
      .update(nodeRuns)
      .set({ childTaskId: grandchildTaskId })
      .where(eq(nodeRuns.id, childRunId))
  }

  const extraRunIds: string[] = []
  for (const nodeId of options.extraOpenRuns ?? []) {
    const id = ulid()
    extraRunIds.push(id)
    await db.insert(nodeRuns).values({
      id,
      taskId,
      nodeId,
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 880,
    })
  }

  return {
    appHome,
    repoPath,
    taskId,
    nodeRunId,
    childTaskId,
    grandchildTaskId,
    extraRunIds,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

function codeOf(error: unknown): string {
  const value =
    error !== null && typeof error === 'object' && 'code' in error
      ? Reflect.get(error, 'code')
      : null
  return typeof value === 'string' ? value : `no-code:${String(error)}`
}

/** 调一次生产的取消，返回 `(错误码, 事后任务状态, 事后被点 node_run 状态)`。 */
async function cancelOutcome(
  harness: Parameters<Parameters<typeof describeEachProvider>[1]>[0],
  fixture: Fixture,
  taskId?: string,
): Promise<{ code: string; status: string; run: string }> {
  const execution = await createEachProviderTaskExecution(
    harness,
    { appHome: fixture.appHome, defaultNodeRetries: 0 },
    USER_ID,
  )
  const target = taskId ?? fixture.taskId
  let code = 'no-throw'
  try {
    await execution.provider.cancellation.cancel({ taskId: target, cause: { kind: 'user' } })
  } catch (error) {
    code = codeOf(error)
  }
  const after = (await harness.db.select().from(tasks).where(eq(tasks.id, target)).limit(1))[0]
  const run = (
    await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, fixture.nodeRunId)).limit(1)
  )[0]
  return { code, status: after?.status ?? 'absent', run: run?.status ?? 'absent' }
}

describeEachProvider('RFC-359 W11 —— cancel 的准入与级联对拍', (harness) => {
  let fixture: { cleanup: () => void } | undefined
  afterEach(() => {
    fixture?.cleanup()
    fixture = undefined
  })

  test('A 不存在的任务 → 404 task-not-found', async () => {
    const seeded = await seedFixture(harness.db)
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded, ulid())
    expect(outcome.code).toBe('task-not-found')
    expect(outcome.status).toBe('absent')
  })

  test('B 已终态（done）→ 拒，且任务与 node_run 原样不动', async () => {
    const seeded = await seedFixture(harness.db, { status: 'done', runStatus: 'done' })
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded)
    expect(outcome).toEqual({ code: 'task-not-cancelable', status: 'done', run: 'done' })
  })

  test('C 已 canceled 再取消一次 → 拒（幂等面：不得二次改写）', async () => {
    const seeded = await seedFixture(harness.db, { status: 'canceled', runStatus: 'canceled' })
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded)
    expect(outcome).toEqual({ code: 'task-not-cancelable', status: 'canceled', run: 'canceled' })
  })

  test('D running 的任务 → 放行：任务 canceled，打开的 node_run 一并关掉', async () => {
    const seeded = await seedFixture(harness.db)
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded)
    expect(outcome).toEqual({ code: 'no-throw', status: 'canceled', run: 'canceled' })
  })

  test('E awaiting_human 的任务 → 同样放行（人工闸上的任务也能取消）', async () => {
    const seeded = await seedFixture(harness.db, {
      status: 'awaiting_human',
      runStatus: 'awaiting_human',
    })
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded)
    expect(outcome).toEqual({ code: 'no-throw', status: 'canceled', run: 'canceled' })
  })

  test('F 级联：父取消 ⇒ 活着的子任务也 canceled，并留下 parent-cascade 标记', async () => {
    const seeded = await seedFixture(harness.db, { childStatus: 'running' })
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded)
    expect(outcome.code).toBe('no-throw')
    expect(outcome.status).toBe('canceled')
    const child = (
      await harness.db.select().from(tasks).where(eq(tasks.id, seeded.childTaskId!)).limit(1)
    )[0]
    expect(child?.status).toBe('canceled')
    expect(child?.errorMessage).toBe('canceled-by-parent-cascade')
  })

  // ⚠️ 这一格不是准入面，是**线性化面**——而它正是上面七格看不见的那一维。
  //
  // 契约（`review-cancel-concurrency.test.ts` 的 `cancel first …` / `… first` 两组锁的就是它）：
  // **评审写入与用户取消共用任务级 FIFO**，取消在函数入口**同步取号**
  //（`reserveTaskReviewMutationSlot`），之后才 await 自己的前置读。少了取号，取消就会插到
  // 一个正在进行的评审写入中间——用户可见的后果是评审决定的副作用与取消交错落库。
  //
  // 那份既有判据虽然跑两个引擎，但两条 lane 调的都是 `cancelTask`（SQLite 那份实现），
  // 也就是说 **PostgreSQL 部署上真正会执行的那份（`cancelCascade`）从来没被这条契约验过**。
  // 本格用生产取消面把这一维补上。
  test('H 取消与评审写入共用任务级 FIFO：槽被占着时取消必须排队', async () => {
    const seeded = await seedFixture(harness.db)
    fixture = seeded
    const execution = await createEachProviderTaskExecution(
      harness,
      { appHome: seeded.appHome, defaultNodeRetries: 0 },
      USER_ID,
    )
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = withTaskReviewMutationLock(seeded.taskId, async () => {
      await blocked
    })
    const canceling = execution.provider.cancellation
      .cancel({ taskId: seeded.taskId, cause: { kind: 'user' } })
      .catch(() => undefined)
    // 给取消一个**真实**的机会跑完：它要是没取号，这段时间足够它整个落库。
    await Bun.sleep(250)
    const midway = (
      await harness.db.select().from(tasks).where(eq(tasks.id, seeded.taskId)).limit(1)
    )[0]
    expect(midway?.status, '取消必须排在评审变更槽之后，而不是插进去').toBe('running')
    release()
    await holder
    await canceling
    const after = (
      await harness.db.select().from(tasks).where(eq(tasks.id, seeded.taskId)).limit(1)
    )[0]
    expect(after?.status, '槽释放之后取消照常落地').toBe('canceled')
  }, 30_000)

  // 文案面：任务行上留给用户看的两格（摘要 + 明细）。前十格断的都是状态，文案在状态之下。
  test('K 取消之后任务行上的摘要与明细（用户唯一看得到的归因）', async () => {
    const seeded = await seedFixture(harness.db)
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded)
    expect(outcome.code).toBe('no-throw')
    const after = (
      await harness.db.select().from(tasks).where(eq(tasks.id, seeded.taskId)).limit(1)
    )[0]
    expect({ summary: after?.errorSummary, message: after?.errorMessage }).toEqual({
      summary: 'canceled by user',
      message: 'canceled-by-user',
    })
  })

  test('I 关的是**全部**打开着的 node_run，不是被点的那一条', async () => {
    const seeded = await seedFixture(harness.db, { extraOpenRuns: ['b', 'c'] })
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded)
    expect(outcome.code).toBe('no-throw')
    const rows = await harness.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, seeded.taskId))
    expect(rows).toHaveLength(3)
    expect(
      rows.map((row) => row.status).sort(),
      '三条打开着的行必须全部被关掉——留一条开着，任务就是终态而它的行还在跑',
    ).toEqual(['canceled', 'canceled', 'canceled'])
  })

  test('J 级联是**递归**的：孙任务也被取消', async () => {
    const seeded = await seedFixture(harness.db, {
      childStatus: 'running',
      grandchildStatus: 'running',
    })
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded)
    expect(outcome.code).toBe('no-throw')
    expect(outcome.status).toBe('canceled')
    const rows = await harness.db.select().from(tasks)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(seeded.childTaskId!)?.status, '子任务').toBe('canceled')
    expect(
      byId.get(seeded.grandchildTaskId!)?.status,
      '孙任务——级联只做一层的话这条会留在 running，而它的父已经终态了',
    ).toBe('canceled')
    expect(byId.get(seeded.grandchildTaskId!)?.errorMessage).toBe('canceled-by-parent-cascade')
  })

  test('G 级联撞上已终态的子任务 → 幂等空操作，父仍然取消成功', async () => {
    const seeded = await seedFixture(harness.db, { childStatus: 'done' })
    fixture = seeded
    const outcome = await cancelOutcome(harness, seeded)
    expect(outcome.code).toBe('no-throw')
    expect(outcome.status).toBe('canceled')
    const child = (
      await harness.db.select().from(tasks).where(eq(tasks.id, seeded.childTaskId!)).limit(1)
    )[0]
    // 已收场的子任务不被改写——它的 done 是真实结果，不是「被父取消」。
    expect(child?.status).toBe('done')
  })
})
