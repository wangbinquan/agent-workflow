// RFC-359 W10 —— 三个**效应观察者**（local / process / code-host）的双引擎对拍。
//
// # 这份文件为什么存在
//
// 效应账本分两层：下层是 `TaskExecutionEffectPersistence` 端口（`rfc359-w8-effect-persistence-
// conformance.test.ts` 已经把它在两个引擎上逐方法对拍过），上层是**观察者**——把一次真实动作
// （改工作区 / 起进程 / 打 code host）编排成「record-before-act → 结算」的那段协调逻辑：
// 决定这次算第几代（`nextOperationGeneration`）、决定结算成哪个 attempt state、决定重试授权
// 怎么带到下一次 attempt 上。**上层此前只有 SQLite 一侧被跑过。**
//
// 具体形态：`application/{local,process,codeHost}EffectObserver.ts` 是生产路径
// （`public/participants.ts` 转出的就是它们仨），而 `infrastructure/sqlite{Local,Process,
// CodeHost}EffectObserver.ts` 是同一段编排的第二份**同步**写法。1495 行的
// `rfc328-durable-ownership.test.ts` 里唯一一条锁「代际跟着保留家族走、不跟着任务续跑计数走」
// 的用例，import 的是 `infrastructure/sqliteLocalEffectObserver`——也就是说 RFC-328 的这条
// 判据**只锁住了那份没人调用的实现**，生产用的中立版在两个引擎上都是零行为覆盖
// （`rfc359-w5-t19d-coverage-parity.test.ts` 顶部把这条倒挂点了名）。
//
// 所以这份对拍先补上、再让那三份 SQLite 孪生退役：判据从「被删的那份」搬到「真在跑的那份」，
// 并且两个引擎各跑一遍。删除本身零生产风险（三份文件的**全部**引用只有一个同样零调用方的
// composition 再导出壳 `composition/sqliteEffectObservers.ts` 和上面那条 RFC-328 用例）。
//
// # 每条用例都带正向对照
//
// 只断言「都被拒绝 / 都为空」的用例，一个「永远什么都不写」的实现也能满足。所以每条拒绝类判据
// 旁边都钉一条「正常路径确实落了行、且落成什么样」。

import { expect, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  tasks,
  workflows,
} from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import type { TaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createLocalEffectAttemptObserver } from '@/modules/task-execution/application/localEffectObserver'
import { createProcessEffectAttemptObserver } from '@/modules/task-execution/application/processEffectObserver'
import { createCodeHostEffectAttemptObserver } from '@/modules/task-execution/application/codeHostEffectObserver'
import type { TaskExecutionEffectPersistence } from '@/modules/task-execution/application/ports/taskExecutionEffectStore'
import { sha256Hex } from '@/modules/task-execution/domain/digest'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import { buildCodeHostRecoveryDescriptor } from '@/modules/task-execution/domain/codeHostRecovery'
import {
  canonicalJson,
  encodeLineageSlotPath,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import type { OwnershipToken } from '@/modules/task-execution/domain/ownership'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

/** 每条用例都自带超时：`waitForEffectResourceTurn` 在资源围栏冲突上是**无限**退避重试，
 *  一旦编排把围栏留在手上，用例会挂而不是红——显式超时把「挂」变回「红」。 */
const CASE_TIMEOUT_MS = 30_000

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

function continuation(taskId: string): CanonicalContinuationRequest {
  return {
    taskId,
    kind: 'launch',
    source: 'rest',
    actorUserId: 'actor-w10',
    expectedTaskRevision: 1,
    scope: {
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPath: rootPath(taskId),
      operationGeneration: 0,
    },
    payload: { v: 1 },
  }
}

interface Fixture {
  readonly db: ProviderNeutralDatabase
  readonly taskId: string
  readonly runId: string
  readonly intentId: string
  readonly token: OwnershipToken
  readonly persistence: TaskExecutionEffectPersistence
  readonly context: TaskExecutionContext
  readonly slotPathJson: string
  reset(): void
}

async function seed(db: ProviderNeutralDatabase): Promise<Fixture> {
  const taskId = `w10_${ulid()}`
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-w10',
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now() - 1_000,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(rootPath(taskId)),
  })
  // 直插的 node_run 必须自带 `continuationSlotKey` / `lineageSlotPathJson`：SQLite 的迁移 0210
  // 给直写者装了补齐触发器，PostgreSQL 没有（schema 面的差异，不在本对之内）。
  const runId = ulid()
  const slotPathJson = encodeLineageSlotPath(rootPath(taskId))
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'worker',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    continuationSlotKey: `${taskId}:root`,
    lineageSlotPathJson: slotPathJson,
  })
  const persistence = createTaskExecutionPersistence(db)
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `gen-${ulid()}`,
    persistence,
  })
  const intentId = `intent_${ulid()}`
  await persistence.intents.submit({ request: continuation(taskId), intentId })
  const claimed = await module.claimPersisted({ intentId })
  module.claimGate.leave(claimed.permit)
  const context = createTaskExecutionContext({ intentId, token: claimed.token, persistence })
  return {
    db,
    taskId,
    runId,
    intentId,
    token: claimed.token,
    persistence: persistence.effects,
    context,
    slotPathJson,
    reset: () => module.resetForTesting(),
  }
}

/** 账本快照：按代际排序的 effect 行 + 每行的 attempt 结算面。判据全部读它，不读实现内部状态。 */
async function ledger(fixture: Fixture): Promise<
  readonly {
    readonly generation: number
    readonly kind: string
    readonly state: string
    readonly operationKey: string
    readonly attempts: readonly {
      readonly attemptNo: number
      readonly state: string
      readonly evidence: string | null
      readonly retryAuthority: string
      readonly failureCode: string | null
    }[]
  }[]
> {
  const effects = await fixture.db
    .select()
    .from(taskExecutionEffects)
    .where(eq(taskExecutionEffects.taskId, fixture.taskId))
    .orderBy(asc(taskExecutionEffects.operationGeneration))
  const out = []
  for (const effect of effects) {
    const attempts = await fixture.db
      .select()
      .from(taskExecutionEffectAttempts)
      .where(eq(taskExecutionEffectAttempts.effectId, effect.id))
      .orderBy(asc(taskExecutionEffectAttempts.attemptNo))
    out.push({
      // PostgreSQL 的数值列经 sqlite-proxy 回来可能是字符串，判据前显式归一。
      generation: Number(effect.operationGeneration),
      kind: String(effect.kind),
      state: String(effect.state),
      operationKey: String(effect.operationKey),
      attempts: attempts.map((attempt) => ({
        attemptNo: Number(attempt.attemptNo),
        state: String(attempt.state),
        evidence: attempt.applicationEvidence === null ? null : String(attempt.applicationEvidence),
        retryAuthority: String(attempt.retryAuthority),
        failureCode: attempt.failureCode === null ? null : String(attempt.failureCode),
      })),
    })
  }
  return out
}

async function errorOf(body: () => Promise<unknown>): Promise<Error> {
  try {
    await body()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to throw')
}

function codeOf(error: Error): string {
  return (error as { readonly code?: string }).code ?? `<no-code:${error.constructor.name}>`
}

describeEachProvider('RFC-359 W10 —— 效应观察者双引擎对拍', (harness) => {
  // ───────────────────────────────────────────────────────────────────────────
  // local effect observer
  // ───────────────────────────────────────────────────────────────────────────

  test(
    'local：代际跟着**保留家族**走——同一动作第二次准备拿到下一代，且第一代已结算成 succeeded/applied',
    async () => {
      const fixture = await seed(harness.db)
      const prepare = () =>
        createLocalEffectAttemptObserver({
          persistence: fixture.persistence,
          taskId: fixture.taskId,
          kind: 'workspace-rollback',
          stableActionOrdinal: 'workspace-rollback',
          candidateId: 'generation-fixture',
          request: { v: 1, target: 'snapshot-a' },
          resourceKeys: ['workspace:/tmp/worktree'],
          context: fixture.context,
        })!

      const first = prepare()
      await first.beforeAct()
      await first.succeed({ snapshot: 'snapshot-a' })
      // 正向对照：第一代不是「什么都没写」，而是一条已结算的成功行。
      expect(await ledger(fixture)).toEqual([
        {
          generation: 0,
          kind: 'workspace-rollback',
          state: 'succeeded',
          operationKey: `${fixture.taskId}:root:workspace-rollback:workspace-rollback`,
          attempts: [
            {
              attemptNo: 1,
              state: 'succeeded',
              evidence: 'applied',
              retryAuthority: 'none',
              failureCode: null,
            },
          ],
        },
      ])

      const second = prepare()
      await second.beforeAct()
      expect((await ledger(fixture)).map((row) => row.generation)).toEqual([0, 1])
      await second.succeed({ snapshot: 'snapshot-b' })
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )

  test(
    'local：retry(authority) 把上一 attempt 结算成 retry-authorized 并原样把授权带到下一次准备上',
    async () => {
      const fixture = await seed(harness.db)
      const observer = createLocalEffectAttemptObserver({
        persistence: fixture.persistence,
        taskId: fixture.taskId,
        kind: 'repository',
        stableActionOrdinal: 'clone',
        candidateId: 'retry-fixture',
        request: { v: 1, remote: 'origin' },
        resourceKeys: [`repo:${fixture.taskId}`],
        context: fixture.context,
      })!
      await observer.beforeAct()
      await observer.retry(new Error('transient network'), 'transport-policy')

      const afterRetry = await ledger(fixture)
      // 第一代被结算成 retry-authorized（授权照写），第二代是重试后新准备出来的那一笔。
      expect(afterRetry.map((row) => [row.generation, row.state])).toEqual([
        [0, 'open'],
        [1, 'open'],
      ])
      expect(afterRetry[0]?.attempts).toEqual([
        {
          attemptNo: 1,
          state: 'retry-authorized',
          evidence: 'ambiguous',
          retryAuthority: 'transport-policy',
          failureCode: 'local-effect-retry-authorized',
        },
      ])
      // `prepareAndAcquire` 记账的同时就拿下资源围栏，所以在飞的 attempt 落库即 `acting`
      // ——「已准备但还没开始动手」这一档在账本上不单独存在。
      expect(afterRetry[1]?.attempts).toEqual([
        {
          attemptNo: 1,
          state: 'acting',
          evidence: null,
          retryAuthority: 'transport-policy',
          failureCode: null,
        },
      ])

      await observer.succeed({ retriedOnce: true })
      expect((await ledger(fixture))[1]?.attempts[0]?.state).toBe('succeeded')
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )

  test(
    'local：fail() 落 recovery-required + local-effect-threw，错误串进 receipt',
    async () => {
      const fixture = await seed(harness.db)
      const observer = createLocalEffectAttemptObserver({
        persistence: fixture.persistence,
        taskId: fixture.taskId,
        kind: 'isolation-merge',
        stableActionOrdinal: 'merge-back',
        candidateId: 'fail-fixture',
        request: { v: 1 },
        resourceKeys: [`merge:${fixture.taskId}`],
        context: fixture.context,
      })!
      await observer.beforeAct()
      await observer.fail(new Error('merge conflict'))

      const rows = await ledger(fixture)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.attempts).toEqual([
        {
          attemptNo: 1,
          state: 'recovery-required',
          evidence: 'ambiguous',
          retryAuthority: 'none',
          failureCode: 'local-effect-threw',
        },
      ])
      // effect 本身仍留在 open（等待任务级清算），不是被就地判死。
      expect(rows[0]?.state).toBe('open')

      // 结算两次要在**内存里**就被拦下，不许再动账本。
      const twice = await errorOf(async () => await observer.fail(new Error('again')))
      expect(twice.message).toContain('settled twice')
      expect((await ledger(fixture))[0]?.attempts).toHaveLength(1)
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )

  test(
    'local：任务 / 意图不成对时 beforeAct 抛 task-continuation-stale，且一行都不写',
    async () => {
      const fixture = await seed(harness.db)
      const observer = createLocalEffectAttemptObserver({
        persistence: fixture.persistence,
        taskId: `${fixture.taskId}_missing`,
        kind: 'workspace-prepare',
        stableActionOrdinal: 'prepare',
        candidateId: 'stale-fixture',
        request: { v: 1 },
        resourceKeys: ['workspace:/tmp/missing'],
        context: fixture.context,
      })!
      const stale = await errorOf(async () => await observer.beforeAct())
      expect(codeOf(stale)).toBe('task-continuation-stale')
      expect(await ledger(fixture)).toEqual([])
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )

  test(
    'local：没有执行上下文时工厂返回 undefined（调用方据此跳过记账，而不是裸写）',
    async () => {
      const fixture = await seed(harness.db)
      const observer = createLocalEffectAttemptObserver({
        persistence: fixture.persistence,
        taskId: fixture.taskId,
        kind: 'workspace-cleanup',
        stableActionOrdinal: 'cleanup',
        candidateId: 'no-context',
        request: { v: 1 },
        resourceKeys: ['workspace:/tmp/worktree'],
      })
      expect(observer).toBeUndefined()
      expect(await ledger(fixture)).toEqual([])
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )

  // ───────────────────────────────────────────────────────────────────────────
  // process effect observer
  // ───────────────────────────────────────────────────────────────────────────

  test(
    'process：spawn 前记账 → 落 spawn 回执 → 正常退出结算成 succeeded/applied',
    async () => {
      const fixture = await seed(harness.db)
      const observer = createProcessEffectAttemptObserver({
        persistence: fixture.persistence,
        taskId: fixture.taskId,
        nodeRunId: fixture.runId,
        processKind: 'agent',
        argv: ['opencode', 'run'],
        cwd: '/tmp/worktree',
        context: fixture.context,
      })!
      await observer.beforeSpawn()
      await observer.recordSpawnReceipt({
        pid: 4242,
        spawnBinaryPath: '/usr/local/bin/opencode',
        launchNonce: `nonce_${ulid()}`,
      })
      await observer.settle({ outcome: 'exited', exitCode: 0, pid: 4242 })

      const rows = await ledger(fixture)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('process')
      expect(rows[0]?.operationKey).toBe(`${fixture.taskId}:root:process:agent`)
      expect(rows[0]?.attempts).toEqual([
        {
          attemptNo: 1,
          state: 'succeeded',
          evidence: 'applied',
          retryAuthority: 'none',
          failureCode: null,
        },
      ])
      // spawn 回执投影到 node_run 上：用户在任务详情里看到的 pid 就是这一列。
      const runRows = await fixture.db
        .select({ pid: nodeRuns.pid })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, fixture.runId))
      expect(Number(runRows[0]?.pid)).toBe(4242)
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )

  test(
    'process：spawn-failed 判 definitely-not-applied，unreaped 判 recovery-required（两档失败不同码）',
    async () => {
      for (const [outcome, state, evidence, failureCode] of [
        ['spawn-failed', 'failed-not-applied', 'definitely-not-applied', 'process-not-activated'],
        ['unreaped', 'recovery-required', 'ambiguous', 'process-child-unkillable'],
      ] as const) {
        const fixture = await seed(harness.db)
        const observer = createProcessEffectAttemptObserver({
          persistence: fixture.persistence,
          taskId: fixture.taskId,
          nodeRunId: fixture.runId,
          processKind: 'script',
          argv: ['bash', '-lc', 'true'],
          cwd: '/tmp/worktree',
          context: fixture.context,
        })!
        await observer.beforeSpawn()
        await observer.settle({ outcome, exitCode: null, pid: null })
        expect([outcome, (await ledger(fixture))[0]?.attempts[0]]).toEqual([
          outcome,
          { attemptNo: 1, state, evidence, retryAuthority: 'none', failureCode },
        ])
        fixture.reset()
      }
    },
    CASE_TIMEOUT_MS,
  )

  test(
    'process：没有 launchNonce 的 spawn 回执被拒；结算前的回执也被拒；账本都不动',
    async () => {
      const fixture = await seed(harness.db)
      const early = createProcessEffectAttemptObserver({
        persistence: fixture.persistence,
        taskId: fixture.taskId,
        nodeRunId: fixture.runId,
        processKind: 'agent',
        argv: ['opencode'],
        cwd: '/tmp/worktree',
        context: fixture.context,
      })!
      const beforePrepare = await errorOf(
        async () =>
          await early.recordSpawnReceipt({
            pid: 1,
            spawnBinaryPath: '/bin/true',
            launchNonce: 'n',
          }),
      )
      expect(beforePrepare.message).toContain('preceded effect preparation')
      expect(await ledger(fixture)).toEqual([])

      await early.beforeSpawn()
      const noNonce = await errorOf(
        async () => await early.recordSpawnReceipt({ pid: 1, spawnBinaryPath: '/bin/true' }),
      )
      expect(noNonce.message).toContain('launch nonce')
      // 正向对照：记账那一行确实在（所以上面两条拒绝不是「什么都没发生」）。
      expect((await ledger(fixture))[0]?.attempts[0]?.state).toBe('acting')
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )

  // ───────────────────────────────────────────────────────────────────────────
  // code-host effect observer
  // ───────────────────────────────────────────────────────────────────────────

  test(
    'code-host：GET 不进账本；写请求 2xx 走 settleTerminal 结成 succeeded',
    async () => {
      const fixture = await seed(harness.db)
      const observer = codeHostObserverOf(fixture)
      expect(await observer.beforeSend(sendInfo('GET'))).toBeNull()
      expect(await ledger(fixture)).toEqual([])

      const handle = await observer.beforeSend(sendInfo('POST'))
      expect(handle).not.toBeNull()
      await observer.afterSend(handle, {
        ...sendInfo('POST'),
        result: 'response',
        status: 201,
        willRetry: false,
        retryKind: 'none',
      })
      expect(observer.outcomeUnknown()).toBe(false)
      // 终态在 settleTerminal 之前**不入账**：attempt 还停在 `acting`（围栏未释放），
      // 这一步才是「把结论写下去」。
      expect((await ledger(fixture))[0]?.attempts[0]?.state).toBe('acting')

      expect(
        await observer.settleTerminal({
          nodeRunId: fixture.runId,
          status: 'done',
          reason: 'code-host-mutation',
          finishedAt: Date.now(),
          outputs: [{ portName: 'pr_url', content: 'https://example/pull/1' }],
        }),
      ).toBe(true)
      expect((await ledger(fixture))[0]?.attempts[0]).toEqual({
        attemptNo: 1,
        state: 'succeeded',
        evidence: 'applied',
        retryAuthority: 'none',
        failureCode: null,
      })
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )

  test(
    'code-host：willRetry 的传输失败当场结算成 retry-authorized，并把授权带到下一次 beforeSend',
    async () => {
      const fixture = await seed(harness.db)
      const observer = codeHostObserverOf(fixture)
      const first = await observer.beforeSend(sendInfo('POST', 1))
      await observer.afterSend(first, {
        ...sendInfo('POST', 1),
        result: 'network-error',
        willRetry: true,
        retryKind: 'transport-policy',
        errorMessage: 'ECONNRESET',
      })
      expect((await ledger(fixture))[0]?.attempts[0]).toEqual({
        attemptNo: 1,
        state: 'retry-authorized',
        evidence: 'ambiguous',
        retryAuthority: 'transport-policy',
        failureCode: 'code-host-network-error',
      })

      const second = await observer.beforeSend(sendInfo('POST', 2))
      expect((await ledger(fixture))[0]?.attempts[1]).toEqual({
        attemptNo: 2,
        state: 'acting',
        evidence: null,
        retryAuthority: 'transport-policy',
        failureCode: null,
      })

      // 网络失败之后的终态非 2xx ⇒ 结果未知：这是「不许自动重放」的用户可见后果。
      await observer.afterSend(second, {
        ...sendInfo('POST', 2),
        result: 'response',
        status: 409,
        willRetry: false,
        retryKind: 'none',
      })
      expect(observer.outcomeUnknown()).toBe(true)
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )

  test(
    'code-host：终态探针判定 not-applied 时立刻结算成 retry-authorized/probe 并解除未知',
    async () => {
      const fixture = await seed(harness.db)
      const observer = codeHostObserverOf(fixture)
      const handle = await observer.beforeSend(sendInfo('POST'))
      await observer.afterSend(handle, {
        ...sendInfo('POST'),
        result: 'network-error',
        willRetry: false,
        retryKind: 'none',
        errorMessage: 'ETIMEDOUT',
      })
      expect(observer.outcomeUnknown()).toBe(true)
      expect(observer.terminalRecoveryDescriptor()).not.toBeNull()

      expect(
        await observer.resolveTerminalProbe({
          kind: 'definitely-not-applied',
          proofCode: 'absent',
          responseStatus: 404,
          responseBody: '{}',
        }),
      ).toBe('retry-authorized')
      expect(observer.outcomeUnknown()).toBe(false)
      expect((await ledger(fixture))[0]?.attempts[0]).toEqual({
        attemptNo: 1,
        state: 'retry-authorized',
        evidence: 'definitely-not-applied',
        retryAuthority: 'probe',
        failureCode: null,
      })
      // 终态已被探针消费掉，settleTerminal 不再有第二次结算可写。
      expect(
        await observer.settleTerminal({
          nodeRunId: fixture.runId,
          status: 'done',
          reason: 'code-host-mutation',
          finishedAt: Date.now(),
        }),
      ).toBe(false)
      expect((await ledger(fixture))[0]?.attempts).toHaveLength(1)
      fixture.reset()
    },
    CASE_TIMEOUT_MS,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// code-host 夹具：identity 由调用方给定（生产里是 `planCodeHostAttempt` 算出来的），
// 这里固定成一组常量，判据才能只看编排。
// ─────────────────────────────────────────────────────────────────────────────

function sendInfo(method: string, transportAttempt = 1) {
  return {
    candidateId: 'w10-candidate',
    transportAttempt,
    method,
    pathname: '/repos/o/r/pulls',
    recoveryDescriptor: buildCodeHostRecoveryDescriptor({
      provider: 'github',
      action: 'mr.create',
      candidateId: 'w10-candidate',
      method,
      pathname: '/repos/o/r/pulls',
      query: {},
      body: { title: 'w10' },
      baseUrl: 'https://api.github.example',
    }),
  } as const
}

function codeHostObserverOf(fixture: Fixture) {
  const slotPath = rootPath(fixture.taskId)
  const slotPathJson = encodeLineageSlotPath(slotPath)
  return createCodeHostEffectAttemptObserver({
    persistence: fixture.persistence,
    context: fixture.context,
    action: 'mr.create',
    identity: {
      executionLineageId: fixture.taskId,
      operationFamilyKey: operationFamilyKey({
        executionLineageId: fixture.taskId,
        slotPath,
        effectKind: 'code-host-mutation',
        stableActionOrdinal: 'create-pr',
      }),
      operationGeneration: 0,
      operationKey: `${fixture.taskId}:root:code-host-mutation:create-pr`,
      requestHash: requestHash({ v: 1, action: 'create-pr' }),
      slotPathJson,
      slotPathDigest: sha256Hex(slotPathJson),
      resourceKeys: [`code-host:${fixture.taskId}`],
    },
  })
}
