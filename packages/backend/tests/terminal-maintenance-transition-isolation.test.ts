// LOCKS: 终态维护认领的「推进」（`DrizzleTerminalMaintenancePersistence.transition` / `complete`）
// 不参与跨认领的可串行化判定——两笔互不相干的认领，谁也不能把谁打回去重放。
//
// 这条回归从哪来
// ---------------------------------------------------------------------------
// 2026-11-13，CI run 43391298633（Backend tests ubuntu shard 20/44），
// `rfc359-w8-t28-lost-update.test.ts` 的 L6 [postgresql] 红：并发删同一个父任务下的两个子任务，
// 其中一笔删除在把认领推进到 `io-complete` 时拿到一个裸的 `40001 could not serialize access`。
// 同一个签名此前已经出现过（2026-11-02 run 41491898920，`docs/audit-backlog.md` 第十二条）。
//
// 那次 run 的数据库日志把过程记全了：同一条推进语句在 79 ms 内连败 10 次——第一次
// `Canceled on identification as a pivot, during commit attempt`，其后 9 次
// `... during write`——正好是 `postgresqlSerializationRetry.ts` 的全部预算，于是 40001 原样
// 漏给调用方（HTTP 上就是一次 500，认领停在 `claimed`）。成因是三件事叠在一起：
//
//   1. 推进当时走 `DatabaseSession.serializable`，而它只改**一行**认领。PostgreSQL 的 predicate
//      lock 是索引页粒度：小表上两笔认领的主键落在同一个叶子页，成员行的外键检查又要读这一页，
//      于是「不同认领」的事务互相记成读写依赖。
//   2. 推进的 UPDATE 带着 `state = …` 条件，在没有统计信息的新库上规划器选了
//      `(state, updated_at)` 索引：它扫过**所有** `claimed` 的认领行，包括另一笔删除刚插入、
//      还没提交的那一行——又多一条依赖。
//   3. 另一笔认领事务过了提交前的可串行化检查、还没提交完的那段时间里，这边每一次重放都会被
//      判成环上的枢纽而失败；退避上限 16 ms。按这条判定规则，那次 run 里对方停在这个状态的
//      时间合计盖住了全部 10 次尝试（CI 的库是缺省配置、开着 fsync；对方那次提交的耗时是由报文
//      推出来的，没有直接量到）。
//
// 本机用 `PREPARE TRANSACTION` 把第 3 点的状态原样摆出来（对方已过提交检查、尚未提交），
// 修复前推进 10/10 次失败，放行对方后一次成功。CI 的库没开 `max_prepared_transactions`，
// 所以下面的用例不依赖两阶段提交，而是锁住**成因本身**：推进不再是可串行化事务，
// 上面三件事就都不成立。
//
// 修法（`terminalMaintenancePersistence.ts`）：推进改走 `DatabaseSession.transaction` + 认领行的
// 聚合根锁（PostgreSQL 上是 READ COMMITTED + `FOR UPDATE`），判据仍是那一行上的 CAS。这是
// `docs/dev-gotchas.md`「SERIALIZABLE 的 predicate lock 是索引页粒度」那一条给单聚合读—改—写的
// 既定处置；`claim` / `snapshotTree` 是跨行判据，保持可串行化不变。
//
// 三条用例各锁什么
// ---------------------------------------------------------------------------
//   T1  推进途中有另一笔无关的认领提交 ⇒ 推进一次成功。修复前：推进读过主键索引页之后那一页
//       被另一笔认领写入并提交，推进写回时拿到 40001、整笔重放一次（提交慢时就是连败到耗尽）。
//   T2  另一笔无关的认领还没提交时完成推进 ⇒ 在途的那笔照常一次提交。修复前：推进提交时把
//       在途的认领判成枢纽，后者提交时拿到 40001、整笔重放。
//   T3  同一笔认领的两次并发推进 ⇒ 仍然只有一笔成功，另一笔拿
//       `task-terminal-maintenance-conflict`。降隔离级别不能把单笔认领的互斥一起降掉。
//
// 为什么 SQLite 那一半是顺序执行
// ---------------------------------------------------------------------------
// SQLite 的写事务是进程内单写者租约 + `BEGIN IMMEDIATE`，两笔写事务没有交错窗口——把一笔
// 事务停在半路、再让另一笔跑完，在它上面只会互相等死。所以按
// `harness.capabilities.isolation` 分：能交错的引擎把交错摆到必然发生，独占的引擎顺序跑同一组
// 操作，断言完全相同。

import { afterEach, expect, test } from 'bun:test'
import { type Column, type Table, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { TaskExecutionError } from '@/modules/task-execution/application/taskExecutionError'
import type { TerminalMaintenanceClaim } from '@/modules/task-execution/domain/ownership'
import { DrizzleTerminalMaintenancePersistence } from '@/modules/task-execution/infrastructure/terminalMaintenancePersistence'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { taskFixture, workflowFixture } from './helpers/model'
import type { StatementRecording } from './helpers/statementRecorder'

const NOW = 1_794_556_800_000
const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
/** 交错摆不出来时给出可读的失败，而不是等到用例超时；远小于下面各用例的超时（60 s）。 */
const STAGING_WAIT_MS = 20_000

function id(prefix: string): string {
  return `${prefix}_${ulid()}`
}

/** 两个互不相干的终态任务（各自是自己的维护树根）。 */
async function seedTwoTerminalTasks(
  db: PersistenceDb,
): Promise<{ readonly first: string; readonly second: string }> {
  const workflowId = id('wf')
  await workflowFixture(db, {
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  const seed = async (): Promise<string> => {
    const taskId = id('task')
    await taskFixture(db, {
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
    })
    return taskId
  }
  return { first: await seed(), second: await seed() }
}

function store(db: PersistenceDb): DrizzleTerminalMaintenancePersistence {
  return new DrizzleTerminalMaintenancePersistence(db)
}

/** 与 `deleteTask` 同形的一次删除认领：快照整棵树、认领、返回 capability。 */
async function claimDelete(db: PersistenceDb, taskId: string): Promise<TerminalMaintenanceClaim> {
  const maintenance = store(db)
  return await maintenance.claim({
    rootTaskId: taskId,
    operation: 'delete',
    members: await maintenance.snapshotTree(taskId),
    cleanupPlanJson: '{}',
  })
}

async function claimRow(
  db: PersistenceDb,
  claim: TerminalMaintenanceClaim,
): Promise<{ readonly state: string; readonly revision: number } | undefined> {
  const { taskExecutionMaintenanceClaims } = tablesOf(db)
  const rows = await db
    .select({
      state: taskExecutionMaintenanceClaims.state,
      revision: taskExecutionMaintenanceClaims.revision,
    })
    .from(taskExecutionMaintenanceClaims)
    .where(eq(taskExecutionMaintenanceClaims.id, claim.claimId))
  return rows[0]
}

/** 让出一个真实的事件循环任务。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1))
}

type Outcome =
  | { readonly state: 'pending' }
  | { readonly state: 'fulfilled' }
  | { readonly state: 'rejected'; readonly reason: unknown }

interface Observed<T> {
  /** 原 promise：结果与拒绝原样保留，交给调用方最后 await。 */
  readonly result: Promise<T>
  readonly outcome: () => Outcome
}

/**
 * 给一笔还没 await 的操作挂上观测：它的拒绝从此有人接（不会变成「未处理的拒绝」），
 * 等待方随时能看到它是否已经结束、因何结束。
 */
function observe<T>(result: Promise<T>): Observed<T> {
  let outcome: Outcome = { state: 'pending' }
  void result.then(
    () => {
      outcome = { state: 'fulfilled' }
    },
    (reason: unknown) => {
      outcome = { state: 'rejected', reason }
    },
  )
  return { result, outcome: () => outcome }
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** 命中认领表的写、或对它取行锁的读——推进被认领行的行锁挡住时，最后派发的就是这样一条。 */
const CLAIM_ROW_WRITE_OR_LOCK =
  /^\s*update\s+"?(agent_workflow"\.")?task_execution_maintenance_claims"|task_execution_maintenance_claims"[\s\S]*\bfor\s+update\b/i

/**
 * 等到 `operations` 一共派发出 `count` 条命中 `pattern` 的语句——每笔操作被行锁挡住时，最后派发的
 * 正是这样一条。有操作先结束了就立刻报出真实情况：它本该停在行锁上；不这样做，「交错没摆出来」
 * 会被当成通过。
 */
async function waitForDispatch(
  recording: StatementRecording,
  pattern: RegExp,
  count: number,
  operations: readonly Observed<unknown>[],
  what: string,
): Promise<void> {
  const deadline = performance.now() + STAGING_WAIT_MS
  for (;;) {
    const dispatched = recording.dispatched.filter((statement) => pattern.test(statement.sql))
    if (dispatched.length >= count) return
    for (const operation of operations) {
      const outcome = operation.outcome()
      if (outcome.state === 'rejected') {
        throw new Error(`${what}：操作在停到行锁之前就失败了——${reasonText(outcome.reason)}`, {
          cause: outcome.reason,
        })
      }
      if (outcome.state === 'fulfilled') {
        throw new Error(`${what}：操作没有被行锁挡住就结束了，交错没有摆出来`)
      }
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `${what}：${String(STAGING_WAIT_MS)}ms 内只等到 ${String(dispatched.length)}/${String(count)} 条停在行锁上的语句`,
      )
    }
    await tick()
  }
}

interface Brake {
  /** 放行并等这笔占位事务收尾。 */
  readonly release: () => Promise<void>
}

/** 在一笔单独的事务里占住一行的行锁，直到 `release()`。 */
async function holdRow(
  harness: ProviderHarness,
  table: Table,
  idColumn: Column,
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

const openRecordings: StatementRecording[] = []
afterEach(() => {
  for (const recording of openRecordings.splice(0)) recording.stop()
})

/** 开始录制；用例无论怎么结束，录制都在 afterEach 里停掉。 */
function recorderFor(harness: ProviderHarness): StatementRecording {
  const recording = harness.recordStatements()
  openRecordings.push(recording)
  return recording
}

/** 录到的、执行失败的语句（带 SQLSTATE），用于断言「没有任何一条被打回」。 */
function failedStatements(recording: StatementRecording): string[] {
  return recording.dispatched
    .filter((statement) => statement.failedWith !== undefined)
    .map((statement) => `${String(statement.failedWith)}: ${statement.sql.slice(0, 96)}`)
}

describeEachProvider('终态维护认领的推进不参与跨认领的可串行化判定', (harness) => {
  test('T1 推进途中有另一笔无关的认领提交 ⇒ 推进一次成功，没有任何语句被打回重放', async () => {
    const db = harness.db
    const { first, second } = await seedTwoTerminalTasks(db)
    const maintenance = store(db)
    const claimSecond = await claimDelete(db, second)

    let advanced: TerminalMaintenanceClaim
    let recording: StatementRecording
    if (harness.capabilities.isolation === 'read-committed') {
      // 占住第二笔认领那一行：推进停在这把行锁上，事务开着（修复前是读完认领行、写回时才停）。
      const { taskExecutionMaintenanceClaims: claims } = tablesOf(db)
      const brake = await holdRow(harness, claims, claims.id, claimSecond.claimId)
      recording = recorderFor(harness)
      try {
        const advancing = observe(
          maintenance.transition({ claim: claimSecond, to: 'io-complete', now: NOW }),
        )
        await waitForDispatch(
          recording,
          CLAIM_ROW_WRITE_OR_LOCK,
          1,
          [advancing],
          '第二笔认领的推进',
        )
        // 这时另一笔删除走完自己的认领并提交：它往认领表主键索引的同一页写入，
        // 成员行的外键检查再读这一页。
        await claimDelete(db, first)
        await brake.release()
        advanced = await advancing.result
      } catch (error) {
        await brake.release().catch(() => {})
        throw error
      }
    } else {
      recording = recorderFor(harness)
      await claimDelete(db, first)
      advanced = await maintenance.transition({ claim: claimSecond, to: 'io-complete', now: NOW })
    }

    expect(
      failedStatements(recording),
      '另一笔认领与这笔推进互不相干；推进被 40001 打回，就是把两笔认领又绑进了同一次可串行化判定',
    ).toEqual([])
    expect(advanced.revision).toBe(claimSecond.revision + 1)
    expect(await claimRow(db, advanced)).toEqual({ state: 'io-complete', revision: 2 })
  }, 60_000)

  test('T2 另一笔无关的认领还没提交时完成推进 ⇒ 在途的那笔照常一次提交，不被打回重放', async () => {
    const db = harness.db
    const { first, second } = await seedTwoTerminalTasks(db)
    const maintenance = store(db)
    const claimSecond = await claimDelete(db, second)
    const membersFirst = await maintenance.snapshotTree(first)
    const claimFirst = async (): Promise<TerminalMaintenanceClaim> =>
      await maintenance.claim({
        rootTaskId: first,
        operation: 'delete',
        members: membersFirst,
        cleanupPlanJson: '{}',
      })

    const recording = recorderFor(harness)
    let claimAttempts = 0
    let firstClaim: TerminalMaintenanceClaim | undefined
    if (harness.capabilities.isolation === 'read-committed') {
      let open: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        open = resolve
      })
      let entered: () => void = () => {}
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      // 外层开一笔可串行化事务，认领在里面复用同一笔（会话的重入合同），写完之后先不提交。
      const claiming = observe(
        harness.session.serializable(async () => {
          claimAttempts += 1
          firstClaim = await claimFirst()
          entered()
          await gate
        }),
      )
      void claiming.result.catch(() => {
        entered()
      })
      await ready
      try {
        // 认领自己先失败了就把它的错误原样抛出来，不再往下摆。
        if (claiming.outcome().state === 'rejected') await claiming.result
        // 对方还没提交；这笔推进必须能直接完成。
        await maintenance.transition({ claim: claimSecond, to: 'io-complete', now: NOW })
      } finally {
        open()
      }
      await claiming.result
    } else {
      claimAttempts += 1
      firstClaim = await claimFirst()
      await maintenance.transition({ claim: claimSecond, to: 'io-complete', now: NOW })
    }

    expect(
      claimAttempts,
      '在途的认领被打回重放了：推进把一笔与它无关的认领判成了可串行化环上的枢纽',
    ).toBe(1)
    expect(failedStatements(recording)).toEqual([])
    expect(await claimRow(db, claimSecond)).toEqual({ state: 'io-complete', revision: 2 })
    expect(firstClaim).toBeDefined()
    expect(await claimRow(db, firstClaim as TerminalMaintenanceClaim)).toEqual({
      state: 'claimed',
      revision: 1,
    })
  }, 60_000)

  test('T3 同一笔认领的两次并发推进 ⇒ 只有一笔成功，另一笔拿 task-terminal-maintenance-conflict', async () => {
    const db = harness.db
    const { first } = await seedTwoTerminalTasks(db)
    const maintenance = store(db)
    const claim = await claimDelete(db, first)
    const advance = async (): Promise<TerminalMaintenanceClaim> =>
      await maintenance.transition({ claim, to: 'io-complete', now: NOW })

    let settled: PromiseSettledResult<TerminalMaintenanceClaim>[]
    if (harness.capabilities.isolation === 'read-committed') {
      // 两笔推进都排到认领行的行锁后面再一起放行——对「先读后写」最不利的交错。
      const { taskExecutionMaintenanceClaims: claims } = tablesOf(db)
      const brake = await holdRow(harness, claims, claims.id, claim.claimId)
      const recording = recorderFor(harness)
      const racing = [observe(advance()), observe(advance())]
      try {
        await waitForDispatch(recording, CLAIM_ROW_WRITE_OR_LOCK, 2, racing, '同一笔认领的两次推进')
      } finally {
        await brake.release()
      }
      settled = await Promise.allSettled(racing.map((attempt) => attempt.result))
    } else {
      settled = await Promise.allSettled([advance(), advance()])
    }

    const won = settled.filter((result) => result.status === 'fulfilled')
    const lost = settled.filter((result) => result.status === 'rejected')
    expect(won, '同一笔认领只能被推进一次').toHaveLength(1)
    expect(lost).toHaveLength(1)
    const reason = (lost[0] as PromiseRejectedResult).reason as unknown
    expect(reason, `落败的那笔必须是领域冲突，实际：${reasonText(reason)}`).toBeInstanceOf(
      TaskExecutionError,
    )
    expect((reason as TaskExecutionError).code).toBe('task-terminal-maintenance-conflict')
    expect(await claimRow(db, claim)).toEqual({ state: 'io-complete', revision: 2 })
  }, 60_000)
})
