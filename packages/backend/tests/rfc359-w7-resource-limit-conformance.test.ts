// RFC-359 W7 —— 资源上限持久化端口的双引擎对拍。
//
// 为什么存在：合一之前 `sqliteResourceLimitPersistence.ts` / `postgresqlResourceLimitPersistence.ts`
// 是两份逐字复制的实现，`rfc359-w5-provider-pair-conformance.test.ts` 把这一对记成
// **unverified**——PG 侧只有 `rfc349-resource-limit-provider.test.ts` 里那个 SQL 文本 fixture
// （断言拼出的语句长什么样），两个引擎上**真实的读写行为**从来没有被同一批断言量过。
// 现在实现只剩一份（`infrastructure/resourceLimitPersistence.ts`），这份文件就是它的行为判据：
// 同一批场景经同一个 `ResourceLimitPersistence` 端口在 SQLite 与真实 PostgreSQL 上各跑一遍。
//
// 重点盯三处**引擎真的会分叉**的地方：
//   · `sumTaskTokens` 的 `sum(tok_total)`：PG 驱动把 bigint 聚合交回**字符串**、SQLite 交回
//     number，空集两边都是 NULL —— 归一由 `decodeResourceLimitTokenTotal` 兜（RFC-349 陷阱）。
//   · `writeLimitReason` 的 `WHERE status='canceled'` 门：只覆盖终态原因文案、抢不到即空操作，
//     两个引擎必须同样「不翻状态、不误伤 running 行」。
//   · `recordLimitCancellation` 的降级：审计写失败只告警，**不能**把取消动作本身拖红。

import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, recoveryEvents, tasks } from '@/db/schema'
import { DrizzleResourceLimitPersistence } from '@/modules/system-operations/infrastructure/resourceLimitPersistence'
import { __resetRecoveryCountersForTest, recoveryCountersSnapshot } from '@/services/recovery'
import { describeEachProvider } from './helpers/eachProvider'

type TaskStatus = 'pending' | 'running' | 'done' | 'canceled'

interface SeedTask {
  readonly status?: TaskStatus
  readonly maxDurationMs?: number | null
  readonly maxTotalTokens?: number | null
  readonly runningMs?: number
  readonly runningSince?: number | null
  readonly errorSummary?: string | null
  readonly errorMessage?: string | null
}

async function seedTask(db: ProviderNeutralDatabase, input: SeedTask = {}): Promise<string> {
  const taskId = `task-${ulid()}`
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: 'workflow-w7',
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: input.status ?? 'running',
    inputs: '{}',
    maxDurationMs: input.maxDurationMs ?? null,
    maxTotalTokens: input.maxTotalTokens ?? null,
    startedAt: 1,
    runningMs: input.runningMs ?? 0,
    runningSince: input.runningSince ?? null,
    finishedAt: null,
    errorSummary: input.errorSummary ?? null,
    errorMessage: input.errorMessage ?? null,
    executionLineageId: taskId,
  })
  return taskId
}

async function seedRun(
  db: ProviderNeutralDatabase,
  input: {
    readonly taskId: string
    readonly tokTotal?: number | null
    readonly childTaskId?: string | null
    readonly wrapperProgressJson?: string | null
  },
): Promise<string> {
  const runId = `run-${ulid()}`
  await db.insert(nodeRuns).values({
    id: runId,
    taskId: input.taskId,
    nodeId: 'node-w7',
    status: 'done',
    tokTotal: input.tokTotal ?? null,
    childTaskId: input.childTaskId ?? null,
    wrapperProgressJson: input.wrapperProgressJson ?? null,
  })
  return runId
}

/** 审计 sink 挂掉的样子：只有 `.insert` 抛，其余照常走真库。 */
function withFailingInsert(db: ProviderNeutralDatabase): ProviderNeutralDatabase {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'insert') {
        return () => {
          throw new Error('audit sink is down')
        }
      }
      const value = Reflect.get(target, property) as unknown
      return typeof value === 'function'
        ? (value as (...args: never[]) => unknown).bind(target)
        : value
    },
  })
}

describeEachProvider('RFC-359 W7 —— 资源上限持久化端口在两个引擎上同形', (harness) => {
  beforeEach(() => {
    __resetRecoveryCountersForTest()
  })

  test('① listRunningTasks 只取 running 行，五个投影列原样交回（含 NULL 上限）', async () => {
    const persistence = new DrizzleResourceLimitPersistence(harness.db)
    const running = await seedTask(harness.db, {
      status: 'running',
      maxDurationMs: 5_000,
      maxTotalTokens: 900,
      runningMs: 1_200,
      runningSince: 7_000,
    })
    // 无上限的 running 行也必须进扫描面：上限是 NULL 不等于「不扫」。
    const uncapped = await seedTask(harness.db, { status: 'running' })
    await seedTask(harness.db, { status: 'done', maxDurationMs: 1 })
    await seedTask(harness.db, { status: 'canceled', maxDurationMs: 1 })
    await seedTask(harness.db, { status: 'pending', maxDurationMs: 1 })

    const rows = await persistence.listRunningTasks()
    expect(rows.map((row) => row.id).sort()).toEqual([running, uncapped].sort())
    expect(rows.find((row) => row.id === running)).toEqual({
      id: running,
      maxDurationMs: 5_000,
      maxTotalTokens: 900,
      runningMs: 1_200,
      runningSince: 7_000,
    })
    expect(rows.find((row) => row.id === uncapped)).toEqual({
      id: uncapped,
      maxDurationMs: null,
      maxTotalTokens: null,
      runningMs: 0,
      runningSince: null,
    })
  })

  test('② listCallRows 只取本任务里带 child_task_id 的行，wrapper 进度原样透传', async () => {
    const persistence = new DrizzleResourceLimitPersistence(harness.db)
    const taskId = await seedTask(harness.db)
    const otherId = await seedTask(harness.db)
    const childId = await seedTask(harness.db)
    await seedRun(harness.db, {
      taskId,
      childTaskId: childId,
      wrapperProgressJson: '{"callHumanWaitMs":1000}',
    })
    // 没有 child_task_id 的普通 run 不是 call，必须被 isNotNull 挡掉。
    await seedRun(harness.db, { taskId })
    // 别的任务的 call 行不能串进来。
    await seedRun(harness.db, { taskId: otherId, childTaskId: childId })

    expect(await persistence.listCallRows(taskId)).toEqual([
      { childTaskId: childId, wrapperProgressJson: '{"callHumanWaitMs":1000}' },
    ])
    // wrapper_progress_json 允许为空：调用方自己兜 NULL，不是这里过滤。
    const bare = await seedTask(harness.db)
    await seedRun(harness.db, { taskId: bare, childTaskId: childId })
    expect(await persistence.listCallRows(bare)).toEqual([
      { childTaskId: childId, wrapperProgressJson: null },
    ])
    expect(await persistence.listCallRows(`task-missing-${ulid()}`)).toEqual([])
  })

  test('③ listTaskStatuses：空入参短路成 []，多 id 取回状态，缺失 id 只是不出现', async () => {
    const persistence = new DrizzleResourceLimitPersistence(harness.db)
    const done = await seedTask(harness.db, { status: 'done' })
    const running = await seedTask(harness.db, { status: 'running' })

    expect(await persistence.listTaskStatuses([])).toEqual([])
    expect([...(await persistence.listTaskStatuses([done, running]))].sort()).toEqual([
      'done',
      'running',
    ])
    // 缺失 id 不抛、不占位——调用方按「拿回来几条」判子任务是否已终态。
    expect(await persistence.listTaskStatuses([`task-missing-${ulid()}`])).toEqual([])
    expect(await persistence.listTaskStatuses([done, `task-missing-${ulid()}`])).toEqual(['done'])
  })

  test('④ sumTaskTokens：跨引擎的聚合解码——空集 0、NULL 跳过、只算本任务', async () => {
    const persistence = new DrizzleResourceLimitPersistence(harness.db)
    const taskId = await seedTask(harness.db)
    const otherId = await seedTask(harness.db)

    // 一条 run 都没有：SUM 交回 NULL，两个引擎都必须解码成 0 而不是 NaN / null。
    expect(await persistence.sumTaskTokens(taskId)).toBe(0)
    expect(await persistence.sumTaskTokens(`task-missing-${ulid()}`)).toBe(0)

    await seedRun(harness.db, { taskId, tokTotal: 120 })
    await seedRun(harness.db, { taskId, tokTotal: null })
    await seedRun(harness.db, { taskId, tokTotal: 3 })
    await seedRun(harness.db, { taskId: otherId, tokTotal: 10_000 })

    const total = await persistence.sumTaskTokens(taskId)
    // PG 的 bigint 聚合经驱动回来是字符串；这里 toBe(123) 同时锁住类型与数值。
    expect(total).toBe(123)
    expect(typeof total).toBe('number')
    expect(await persistence.sumTaskTokens(otherId)).toBe(10_000)
  })

  test('⑤ readTaskClock：取到 running 时钟两列；任务不存在回 null 而不是抛', async () => {
    const persistence = new DrizzleResourceLimitPersistence(harness.db)
    const ticking = await seedTask(harness.db, { runningMs: 4_500, runningSince: 60_000 })
    const parked = await seedTask(harness.db, { runningMs: 900, runningSince: null })

    expect(await persistence.readTaskClock(ticking)).toEqual({
      runningMs: 4_500,
      runningSince: 60_000,
    })
    expect(await persistence.readTaskClock(parked)).toEqual({ runningMs: 900, runningSince: null })
    expect(await persistence.readTaskClock(`task-missing-${ulid()}`)).toBeNull()
  })

  test('⑥ writeLimitReason 只覆盖已 canceled 的行，不翻状态；running 行完全不动', async () => {
    const persistence = new DrizzleResourceLimitPersistence(harness.db)
    const canceled = await seedTask(harness.db, {
      status: 'canceled',
      errorSummary: 'canceled-by-user',
      errorMessage: 'old message',
    })
    const running = await seedTask(harness.db, {
      status: 'running',
      errorSummary: null,
      errorMessage: null,
    })

    const read = async (taskId: string) =>
      (
        await harness.db
          .select({
            status: tasks.status,
            errorSummary: tasks.errorSummary,
            errorMessage: tasks.errorMessage,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
      )[0]

    await persistence.writeLimitReason({
      taskId: canceled,
      summary: 'task-time-limit-exceeded',
      message: 'exceeded 5000ms',
    })
    expect(await read(canceled)).toEqual({
      status: 'canceled',
      errorSummary: 'task-time-limit-exceeded',
      errorMessage: 'exceeded 5000ms',
    })

    // 还没取消的行抢不到写入门 —— 空操作，不是错误，也绝不翻状态。
    await persistence.writeLimitReason({
      taskId: running,
      summary: 'task-token-limit-exceeded',
      message: 'exceeded 900 tokens',
    })
    expect(await read(running)).toEqual({
      status: 'running',
      errorSummary: null,
      errorMessage: null,
    })

    // 任务根本不存在同样是空操作。
    await persistence.writeLimitReason({
      taskId: `task-missing-${ulid()}`,
      summary: 's',
      message: 'm',
    })
  })

  test('⑦ recordLimitCancellation 追加一条 limit-cancel 审计行，并计数', async () => {
    const persistence = new DrizzleResourceLimitPersistence(harness.db)
    const taskId = await seedTask(harness.db, { status: 'canceled' })

    await persistence.recordLimitCancellation({
      taskId,
      reason: 'task-time-limit-exceeded',
      now: 1_700,
    })

    const events = await harness.db
      .select()
      .from(recoveryEvents)
      .where(eq(recoveryEvents.taskId, taskId))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      taskId,
      nodeRunId: null,
      actor: 'system',
      kind: 'limit-cancel',
      reason: 'task-time-limit-exceeded',
      beforeJson: '{"status":"running"}',
      afterJson: '{"status":"canceled"}',
      createdAt: 1_700,
    })
    expect(recoveryCountersSnapshot()['limit-cancel']).toBe(1)

    // 追加语义：同一任务两次取消审计各留一行（id 各自新铸，不是 upsert）。
    await persistence.recordLimitCancellation({
      taskId,
      reason: 'task-token-limit-exceeded',
      now: 1_800,
    })
    expect(
      await harness.db.select().from(recoveryEvents).where(eq(recoveryEvents.taskId, taskId)),
    ).toHaveLength(2)
    expect(recoveryCountersSnapshot()['limit-cancel']).toBe(2)
  })

  test('⑧ 审计写失败只降级告警：不抛给调用方，计数照旧', async () => {
    const persistence = new DrizzleResourceLimitPersistence(withFailingInsert(harness.db))
    const taskId = await seedTask(harness.db, { status: 'canceled' })

    await expect(
      persistence.recordLimitCancellation({
        taskId,
        reason: 'task-time-limit-exceeded',
        now: 2_000,
      }),
    ).resolves.toBeUndefined()

    expect(
      await harness.db.select().from(recoveryEvents).where(eq(recoveryEvents.taskId, taskId)),
    ).toHaveLength(0)
    // 取消本身发生了 —— 健康计数不因审计沉底而丢。
    expect(recoveryCountersSnapshot()['limit-cancel']).toBe(1)
  })
})
