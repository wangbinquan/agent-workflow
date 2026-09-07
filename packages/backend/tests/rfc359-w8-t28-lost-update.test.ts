// LOCKS: RFC-359 W6-T28 —— 事务内「读—改—写、中间不锁」丢更新的**用户可见后果**。
//
// 这些用例锁的是什么
// ---------------------------------------------------------------------------
// 账本 `tests/architecture/rfc359-w6-t28-read-modify-write.test.ts` 只数「还剩几处」，
// 数不出「哪几处真会咬人」。这个文件是它的另一半：对判定**可达**的每一处，把两笔并发
// 摆到同一个聚合根上，断言**用户在接口 / 界面上看到的东西**——不是「有没有加锁」。
//
// 逐条对应（括号里是先红时用户看到的错结果）：
//   L1  digital-employee `blockCase`  ——「终止」返回 200 且回了一条 terminal 记录，案件列表
//       里却是 blocked（还能 resume 复活），terminalKind / terminalAt 却又留着终止的痕迹。
//   L2  digital-employee `terminateCase` —— 案件详情说「因 X 结束」，平台事件流里同一条
//       revision 的生命周期事件说「因 Y 结束」，两边永远对不上。
//   L3  event-center `settleObserver` —— 观察者跑的途中来的 nudge 被结算悄悄抹掉，
//       下一次扫描要等满一个 poll 间隔而不是立刻。
//   L4  memory `promote` —— 两个管理员同时审同一条候选记忆，一个批准一个拒绝，**两边都拿到
//       200**；库里只留下后写的那个，另一个人以为自己的裁决生效了。
//   L5  task-execution `recordAutoRecoveryAttempt` —— 自动恢复次数少记，用户配的
//       `maxAutoRecoveriesPerWindow` 闸门永不跳，任务被无限自动重跑。
//   L6  `services/taskDelete` —— 同一个父任务下的两个子任务同时删掉后，父行的物化列
//       `branch_started_at` **永久**停在某个已删子树的时间戳上：默认任务列表（按物化列排序）
//       与任何过滤视图（现算）从此行序不同且永不收敛。
//
// 为什么断言在 SQLite 上天然是绿的（重要，不是用例没写好）
// ---------------------------------------------------------------------------
// 这一族债的定义就是「只在 SQLite 上碰巧正确」：`platform/persistence/databaseTransaction.ts`
// 的 SQLite 会话是**进程内单写者租约 + `BEGIN IMMEDIATE` 全库独占**，两笔写事务之间没有任何
// 交错窗口；PostgreSQL 会话则是每笔事务一条独立连接、READ COMMITTED，读与写之间别人能挤进来。
// 所以下面每条用例：**修复前只在 PostgreSQL 上红，SQLite 上前后都绿**。SQLite 那一遍不是
// 冗余——它把「同一份实现搬到另一个引擎才暴雷」这件事本身钉住了。
//
// 怎么把交错窗口撑到「必然发生」（`holdAggregateRoot`）
// ---------------------------------------------------------------------------
// 外面先开一笔事务对聚合根行取 `lockAggregateRoot`：
//   · PostgreSQL 渲染 `select … for update`。两个写手的 SELECT 是普通 MVCC 读，**不被行锁挡**，
//     照常读到同一份旧值；它们的 UPDATE 排在同一把行锁后面，放行后按 FIFO 落地。读—改—写的
//     窗口于是被撑到必然发生，而不是靠 sleep 碰运气。
//   · SQLite 上它是 no-op，但这笔事务占着写者租约，两个写手连 BEGIN 都发不出；放行后依次跑完。
// 「两个写手都已经读完了」这件事经语句录制器观测（`harness.recordStatements()`），不是等墙钟；
// SQLite 上录不到（写手还没开始），等待自然走到上限后放行，两条路都不依赖时序。

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  employeeCases,
  employeeOsOutbox,
  eventObserverRuns,
  memories,
  observerActivations,
  tasks,
  workflows,
} from '@/db/schema'
import type { RuntimeCasePersistence } from '@/modules/digital-employee/application/ports/runtimeStore'
import type { EmployeeCaseRecord } from '@/modules/digital-employee/domain/runtimeModel'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'
import {
  eventContentDigest,
  eventTypeContentDigest,
  type EventSourceDescriptor,
  type EventTypeDescriptor,
} from '@/modules/event-center/domain/model'
import { createEventStore } from '@/modules/event-center/infrastructure/eventStore'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import {
  createTaskRecoveryOperations,
  type TaskRecoveryMutationOperations,
} from '@/modules/task-execution/infrastructure/taskRecoveryOperations'
import { deleteTask } from '@/services/taskDelete'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { memoryCatalogOf } from './helpers/memoryCatalog'
import type { StatementRecording } from './helpers/statementRecorder'

const NOW = 1_788_364_800_000
const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

let appHome: string
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env.AGENT_WORKFLOW_HOME
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w8-t28-'))
  process.env.AGENT_WORKFLOW_HOME = appHome
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = previousHome
  rmSync(appHome, { recursive: true, force: true })
})

const openRecordings: StatementRecording[] = []
afterEach(() => {
  for (const recording of openRecordings.splice(0)) recording.stop()
})

function id(prefix: string): string {
  return `${prefix}_${ulid()}`
}

/** `services/*` 的形参仍写着 legacy 的 bun:sqlite 句柄类型；事务面早已中立。 */
function legacy(db: ProviderNeutralDatabase): DbClient {
  return db as unknown as DbClient
}

/** 让出若干个真实的事件循环任务。 */
async function settle(ticks = 2): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

interface Brake {
  /** 放行并等这笔占位事务收尾。 */
  readonly release: () => Promise<void>
}

/**
 * 占住一个聚合根行，把并发写手停在各自的 UPDATE 上（文件头注释解释了两个引擎各自的形态）。
 */
async function holdAggregateRoot(
  harness: ProviderHarness,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  rowId: string,
): Promise<Brake> {
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  let acquired: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const held = harness.session.transaction(async (tx) => {
    await harness.capabilities.lockAggregateRoot(tx, table, idColumn, rowId)
    acquired()
    await gate
  })
  // 占位事务自己失败时不要把调用方永远挂在 ready 上。
  void held.catch(() => {
    acquired()
  })
  await ready
  return {
    release: async () => {
      open()
      await held
    },
  }
}

function recorderFor(harness: ProviderHarness): StatementRecording {
  const recording = harness.recordStatements()
  openRecordings.push(recording)
  return recording
}

/** 已录到的、命中 `pattern` 的 SELECT 条数（占位事务自己的 `for update` 不算）。 */
function readsMatching(recording: StatementRecording, pattern: RegExp): number {
  return recording.statements.filter(
    (statement) =>
      /^\s*select/i.test(statement.sql) &&
      pattern.test(statement.sql) &&
      !/for\s+update/i.test(statement.sql),
  ).length
}

/**
 * 等到 `count` 条匹配的读落地。等不到就放弃——SQLite 上写手被写者租约挡在 BEGIN 之前，
 * 本来就录不到任何语句；那一侧靠全序列化保证正确，不需要这个观测点。
 */
async function waitForReads(
  recording: StatementRecording,
  pattern: RegExp,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (readsMatching(recording, pattern) >= count) return
    await settle(1)
  }
}

// ---------------------------------------------------------------------------
// L1 / L2 —— modules/digital-employee/infrastructure/runtimeStore.ts
// ---------------------------------------------------------------------------

function employeeCaseRecord(caseId: string): EmployeeCaseRecord {
  return {
    id: caseId,
    name: `Case ${caseId}`,
    employeeRef: { id: 'employee-1', revision: 1 },
    typeRef: { typeId: 'development', revision: 10 },
    primaryContextId: `${caseId}-context`,
    executionPolicyRevision: 1,
    maxDurationMs: null,
    consumedDurationMs: 0,
    maxTotalTokens: null,
    consumedTotalTokens: 0,
    ownerUserId: 'owner-1',
    launchOrigin: 'manual',
    state: 'active',
    terminalKind: null,
    blockReason: null,
    currentWorkItemRef: 'analyze-implement',
    activeRoundId: null,
    revision: 1,
    writerGeneration: 1,
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
  }
}

async function seedCase(store: RuntimeCasePersistence, caseId: string): Promise<void> {
  await store.createCase({
    caseRecord: employeeCaseRecord(caseId),
    primaryContext: {
      id: `${caseId}-context`,
      caseId,
      typeId: 'development.primary',
      schemaVersion: 1,
      revision: 1,
      lifecycleState: 'active',
      stateJson: '{}',
      artifactRefs: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    contextDigest: '0'.repeat(64),
    externalSubject: { typeId: 'test.subject', subjectRef: `subject:${caseId}` },
    eventOrigin: null,
    uploadClaims: [],
    initialMembers: [],
  })
}

const EMPLOYEE_CASE_READ = /employee_cases/i

describeEachProvider('RFC-359 W6-T28 L1 —— 终止过的案件不得被并发的 blockCase 翻回', (harness) => {
  test('terminate 先落地、block 后落地 ⇒ 案件仍是 terminal，不会带着 terminalKind 变回可 resume 的 blocked', async () => {
    const db = harness.db
    const store = createRuntimePersistence(db)
    const caseId = id('case')
    await seedCase(store, caseId)

    const recording = recorderFor(harness)
    const brake = await holdAggregateRoot(harness, employeeCases, employeeCases.id, caseId)
    // 用户点「终止」。
    const terminating = store.terminateCase(caseId, 'completed', NOW + 1)
    await waitForReads(recording, EMPLOYEE_CASE_READ, 1)
    // 与此同时运行时 tick 判定该案件规划失败，要把它 block 掉。
    const blocking = store.blockCase(caseId, 'reaction-planning-failed', NOW + 2)
    await waitForReads(recording, EMPLOYEE_CASE_READ, 2)
    await brake.release()

    const terminated = await terminating
    await blocking
    expect(terminated.state).toBe('terminal')

    const row = await db.select().from(employeeCases).where(eq(employeeCases.id, caseId)).get()
    expect(
      row?.state,
      '「终止」已经返回了一条 terminal 记录：案件不得在并发的 block 之后回到 blocked（那样还能被 resume 复活）',
    ).toBe('terminal')
    expect(row?.terminalKind).toBe('completed')
    expect(row?.blockReason, '终态案件不该同时挂着 blockReason').toBeNull()
  })
})

describeEachProvider('RFC-359 W6-T28 L2 —— 案件行与生命周期事件必须说同一件事', (harness) => {
  test('两笔并发终止 ⇒ 只有先落地的那个 terminalKind 生效，事件流与案件详情不得互相矛盾', async () => {
    const db = harness.db
    const store = createRuntimePersistence(db)
    const caseId = id('case')
    await seedCase(store, caseId)

    const recording = recorderFor(harness)
    const brake = await holdAggregateRoot(harness, employeeCases, employeeCases.id, caseId)
    // 用户点「终止」，同一时刻运行时 tick 按预算耗尽也要终止它。
    const byUser = store.terminateCase(caseId, 'completed', NOW + 1)
    await waitForReads(recording, EMPLOYEE_CASE_READ, 1)
    const byBudget = store.terminateCase(caseId, 'case-budget-exhausted', NOW + 2)
    await waitForReads(recording, EMPLOYEE_CASE_READ, 2)
    await brake.release()

    const [first, second] = await Promise.all([byUser, byBudget])
    const row = await db.select().from(employeeCases).where(eq(employeeCases.id, caseId)).get()
    expect(row?.state).toBe('terminal')
    expect(row?.terminalKind, '先落地的那笔终止才是真相').toBe('completed')
    expect(second.terminalKind, '两次调用不得各自回一个不同的终止原因').toBe(first.terminalKind)

    // 生命周期 outbox 的 id / dedupeKey 都由 (caseId, revision) 决定：两笔并发算出同一个
    // revision 时，后一条会被去重悄悄丢掉，于是事件流里只剩先落地那笔的 terminalKind。
    const outbox = await db
      .select()
      .from(employeeOsOutbox)
      .where(eq(employeeOsOutbox.caseId, caseId))
    const lifecycle = outbox.filter((entry) => entry.id.startsWith(`case-lifecycle:${caseId}:`))
    const terminalEvents = lifecycle.filter((entry) =>
      (JSON.parse(entry.payloadJson) as { routingFactsJson: string }).routingFactsJson.includes(
        '"state":"terminal"',
      ),
    )
    expect(terminalEvents).toHaveLength(1)
    const facts = JSON.parse(
      (JSON.parse(terminalEvents[0]!.payloadJson) as { routingFactsJson: string }).routingFactsJson,
    ) as { terminalKind: string | null }
    expect(facts.terminalKind, '平台事件说的终止原因必须与案件行一致').toBe(
      row?.terminalKind ?? null,
    )
  })
})

// ---------------------------------------------------------------------------
// L3 —— modules/event-center/infrastructure/eventStore.ts
// ---------------------------------------------------------------------------

function observerFixture(tag: string): {
  source: EventSourceDescriptor
  eventType: EventTypeDescriptor
} {
  const source: EventSourceDescriptor = {
    schemaVersion: 1,
    sourceRef: { id: `t28.source-${tag}`, revision: 1 },
    ownerTypeId: 't28.owner',
    displayName: { 'zh-CN': '测试源', 'en-US': 'Fixture source' },
    description: { 'zh-CN': '用于测试', 'en-US': 'Used by the dual-engine oracle' },
    observationMode: 'active',
    observerProgramRef: null,
    // 故意取大：nudge 被吞掉时下一次扫描会被推到 10 分钟后，与 nudge 时刻天差地别。
    pollIntervalMs: 600_000,
    batchSize: 10,
  }
  const eventType: EventTypeDescriptor = {
    schemaVersion: 1,
    eventTypeRef: { id: `t28.event-${tag}.changed`, revision: 1 },
    sourceRef: source.sourceRef,
    ownerTypeId: 't28.owner',
    subjectTypeId: 't28.subject',
    payloadSchemaId: 't28.payload',
    displayName: { 'zh-CN': '发生变更', 'en-US': 'Changed' },
    description: { 'zh-CN': '用于测试', 'en-US': 'Used by the dual-engine oracle' },
    deliveryClass: 't28.delivery',
    triggerParameters: null,
  }
  return { source, eventType }
}

describeEachProvider('RFC-359 W6-T28 L3 —— 观察者结算不得吞掉运行途中的 nudge', (harness) => {
  test('nudge 落在「读完 activation、还没写回 nextScanAt」之间 ⇒ 下一次扫描仍立刻发生', async () => {
    const db = harness.db
    const store = createEventStore(db)
    const tag = ulid().toLowerCase()
    const { source, eventType } = observerFixture(tag)
    await store.registerSource(source, eventContentDigest(source), NOW)
    await store.registerEventType(eventType, eventTypeContentDigest(eventType), NOW)
    await store.subscribe({
      id: `t28.sub-${tag}`,
      eventType,
      source,
      subject: { typeId: 't28.subject', subjectRef: `subject-${tag}` },
      subscriber: { kind: 'automation', subscriberRef: `automation-${tag}` },
      identityKey: `identity-${tag}`,
      replayLatest: false,
      now: NOW,
    })
    const run = await store.claimDueObserver({
      now: NOW + 10,
      leaseOwner: 'observer-1',
      leaseMs: 600_000,
      runId: `t28.run-${tag}`,
    })
    if (run === null) throw new Error('observer run was not claimed')

    const nudgeAt = NOW + 20
    const settleAt = NOW + 30
    const settleInput = {
      run,
      now: settleAt,
      cursorJson: '{"page":2}',
      observations: [],
      nextId: () => `t28.delivery-${ulid()}`,
      errorCode: null,
      errorDetail: null,
    }

    if (harness.capabilities.isolation === 'exclusive') {
      // SQLite：写事务全库独占，nudge 物理上挤不进结算事务中间（真挤进来会被
      // `CrossContextTransactionError` 当场拦下）。按它唯一可能的时序跑，断言相同。
      expect(await store.nudgeObserver(source.sourceRef, nudgeAt)).toBe(true)
      expect(await store.settleObserver(settleInput)).toBe('completed')
    } else {
      // PostgreSQL：nudge 是一条普通的自动提交更新，能落在结算事务的读与写之间。
      // 刹车挂在**运行行**上（结算在读完 activation 之后、写回 activation 之前会写它），
      // 于是 nudge 走的那张表完全不被挡——这正是生产里的时序。
      const recording = recorderFor(harness)
      const brake = await holdAggregateRoot(
        harness,
        eventObserverRuns,
        eventObserverRuns.id,
        run.runId,
      )
      const settling = store.settleObserver(settleInput)
      await waitForReads(recording, /observer_activations/i, 1)
      const nudging = store.nudgeObserver(source.sourceRef, nudgeAt)
      // 等 nudge 真的落库（wakeEpoch 前进）再放行；修好之后 nudge 会被结算持有的行锁挡住，
      // 这个等待自然走到上限，放行后它排在结算之后落地——两种时序下断言相同。
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const row = await db
          .select({ wakeEpoch: observerActivations.wakeEpoch })
          .from(observerActivations)
          .where(eq(observerActivations.sourceId, source.sourceRef.id))
          .get()
        if ((row?.wakeEpoch ?? 0) > run.wakeEpoch) break
        await settle(1)
      }
      await brake.release()
      expect(await settling).toBe('completed')
      expect(await nudging).toBe(true)
    }

    const activation = await db
      .select()
      .from(observerActivations)
      .where(eq(observerActivations.sourceId, source.sourceRef.id))
      .get()
    // 「立刻」的两种合法写法：nudge 自己写的 `nudgeAt`（它排在结算之后落地），或结算看见
    // `wakeEpoch` 前进后写的 `settleAt`。丢掉这一笔的症状只有一个——`settleAt + pollIntervalMs`。
    expect(
      activation?.nextScanAt,
      '跑到一半来的 nudge 不能被结算抹掉：下一次扫描应当立刻发生（≤ 结算时刻），' +
        `而不是被推到 ${String(settleAt + source.pollIntervalMs)}（整整一个 poll 间隔之后）`,
    ).toBeLessThanOrEqual(settleAt)
  })
})

// ---------------------------------------------------------------------------
// L4 —— modules/memory/infrastructure/memoryCatalogOperations.ts
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W6-T28 L4 —— 同一条候选记忆只能被裁决一次', (harness) => {
  test('并发「批准」与「拒绝」⇒ 只有一个人拿到 200，另一个拿 memory-not-candidate', async () => {
    const db = harness.db
    const catalog = memoryCatalogOf(db as never)
    const candidate = await catalog.commands.createManual({
      scopeType: 'global',
      scopeId: null,
      title: `t_${ulid()}`,
      bodyMd: 'body',
    })

    const recording = recorderFor(harness)
    const brake = await holdAggregateRoot(harness, memories, memories.id, candidate.id)
    const approving = catalog.commands.promote(candidate.id, { action: 'approve' }, 'u_admin_a')
    await waitForReads(recording, /\bmemories\b/i, 1)
    const rejecting = catalog.commands.promote(candidate.id, { action: 'reject' }, 'u_admin_b')
    await waitForReads(recording, /\bmemories\b/i, 2)
    await brake.release()

    const outcomes = await Promise.allSettled([approving, rejecting])
    const settled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    expect(
      settled.length,
      '两个管理员同时裁决同一条候选：只能有一个成功，另一个必须收到冲突而不是也拿 200',
    ).toBe(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'memory-not-candidate',
    })
    const row = await db.select().from(memories).where(eq(memories.id, candidate.id)).get()
    expect(row?.status, '库里的状态必须就是那个成功者的裁决').toBe('approved')
  })
})

// ---------------------------------------------------------------------------
// L5 —— modules/task-execution/infrastructure/taskRecoveryOperations.ts
// ---------------------------------------------------------------------------

const NO_OP_RECOVERY_MUTATIONS: TaskRecoveryMutationOperations = {
  async interruptBootOrphanTask() {
    return true
  },
  async interruptNodeRun() {
    return true
  },
  async repairRuntimeSessionLeaseAfterOrphanReap() {
    return 0
  },
  async interruptPeriodicTaskIfIdle() {
    return true
  },
}

function recoveryOperations(db: ProviderNeutralDatabase): TaskRecoveryOperations {
  return createTaskRecoveryOperations(db, NO_OP_RECOVERY_MUTATIONS)
}

async function seedWorkflow(db: ProviderNeutralDatabase): Promise<string> {
  const workflowId = id('wf')
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  return workflowId
}

async function seedTask(
  db: ProviderNeutralDatabase,
  workflowId: string,
  over: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const taskId = (over.id as string | undefined) ?? id('task')
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: NOW - 10_000,
    finishedAt: NOW - 5_000,
    executionLineageId: taskId,
    ...over,
  })
  return taskId
}

const TASKS_READ = /from\s+"?(agent_workflow"\.")?tasks"/i

describeEachProvider('RFC-359 W6-T28 L5 —— 自动恢复的滑动窗口必须每次都记上', (harness) => {
  test('两次并发尝试 ⇒ 计数记成 2 且闸门跳闸，不是少记一次让任务被无限重跑', async () => {
    const db = harness.db
    const workflowId = await seedWorkflow(db)
    const taskId = await seedTask(db, workflowId, { status: 'interrupted' })
    const operations = recoveryOperations(db)
    const config = { maxPerWindow: 1, windowMs: 3_600_000 }

    const recording = recorderFor(harness)
    const brake = await holdAggregateRoot(harness, tasks, tasks.id, taskId)
    // auto-repair 与 heartbeat-kill 是两条各自定时的 loop，可以同时盯上同一个任务。
    const byRepair = operations.recordAutoRecoveryAttempt({ taskId, config, now: NOW })
    await waitForReads(recording, TASKS_READ, 1)
    const byHeartbeat = operations.recordAutoRecoveryAttempt({ taskId, config, now: NOW })
    await waitForReads(recording, TASKS_READ, 2)
    await brake.release()

    const results = await Promise.all([byRepair, byHeartbeat])
    expect(
      results.map((result) => result.attempts).sort((left, right) => left - right),
      '两次尝试必须各记一次；少记一次就等于用户配的重试上限被架空',
    ).toEqual([1, 2])
    expect(
      results.some((result) => result.suspended),
      'maxPerWindow = 1 时第二次尝试必须触发隔离',
    ).toBe(true)

    const row = await db
      .select({
        attempts: tasks.autoRecoveryAttempts,
        suspended: tasks.autoRecoverySuspended,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()
    expect(row?.attempts).toBe(2)
    expect(row?.suspended, '闸门跳了就必须落库，否则下一轮 loop 还会继续自动重跑').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// L6 —— services/taskDelete.ts
// ---------------------------------------------------------------------------

const CHILD_MAX_READ = /coalesce\(max\(/i

describeEachProvider('RFC-359 W6-T28 L6 —— 并发删兄弟任务后父行的物化列必须收敛', (harness) => {
  test('同一父下的两个子任务同时删掉 ⇒ branch_started_at 退回父自己的 started_at，不停在已删子树的时间戳上', async () => {
    const db = harness.db
    const workflowId = await seedWorkflow(db)
    const parentId = await seedTask(db, workflowId, {
      startedAt: NOW - 30_000,
      branchStartedAt: NOW - 1_000,
    })
    const firstChild = await seedTask(db, workflowId, {
      parentTaskId: parentId,
      startedAt: NOW - 1_000,
      branchStartedAt: NOW - 1_000,
    })
    const secondChild = await seedTask(db, workflowId, {
      parentTaskId: parentId,
      startedAt: NOW - 2_000,
      branchStartedAt: NOW - 2_000,
    })

    // 先把两笔删除卡在各自的**每任务**写锁上（两个子任务 id 不同 ⇒ 两把不同的锁，
    // 它们之间没有任何串行化），让认领链先走完，之后才进事务。
    const releaseFirst = await getTaskWriteSem(firstChild).acquire()
    const releaseSecond = await getTaskWriteSem(secondChild).acquire()
    const deletingFirst = deleteTask(legacy(db), firstChild)
    const deletingSecond = deleteTask(legacy(db), secondChild)
    await settle(20)

    const recording = recorderFor(harness)
    const brake = await holdAggregateRoot(harness, tasks, tasks.id, parentId)
    releaseFirst()
    releaseSecond()
    await waitForReads(recording, CHILD_MAX_READ, 2)
    await brake.release()

    await Promise.all([deletingFirst, deletingSecond])

    const parent = await db
      .select({ branchStartedAt: tasks.branchStartedAt })
      .from(tasks)
      .where(eq(tasks.id, parentId))
      .get()
    expect(
      parent?.branchStartedAt,
      '两个子任务都删光之后，父行的物化列必须退回它自己的 started_at——' +
        '停在已删子树的时间戳上会让默认任务列表与任何过滤视图永远排出两种顺序',
    ).toBe(NOW - 30_000)
  })
})
