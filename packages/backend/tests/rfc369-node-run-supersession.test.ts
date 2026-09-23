// RFC-369 —— node_run「旧代被取代」改由读侧推导（design/RFC-369-node-run-supersession-derived/）。
//
// 为什么这条测试存在：铸造事务里那次同帧范围读在 PostgreSQL SERIALIZABLE 下按索引页加谓词锁，同一
// 任务的任意两次并发铸造几乎必然互判读写依赖、其一被中止重放；CI 慢机器上连撞到把 10 次重放用光，
// 工作组回合报 internal error（`rfc185-leader-fanout` / `rfc359-w4-d19c` 间歇红）。本文件锁住：
//   ① 判据本身：纯函数（domain）逐格 + 与生产 SQL 谓词（infrastructure）双引擎对拍；
//   ② AC-2 冲突回归锁：同任务两笔并发铸造在 PG 上不再触发序列化重放；
//   ③ AC-4 迁移围栏：被取代的行在迁移时收成 abandoned 并**确实落库**、不写 extra、在外层事务帧里
//      调用直接拒绝；abandon 事件照常；NULL 行 begin-isolation 放行、在 mark-pending-merge 处被拦；
//   ④ 入口重放的 `excludeSuperseded`；
//   ⑤ AC-7 收紧情形（ULID 不单调的晚提交行、遗留行）与 AC-8 调度器跳过已被取代的 pending 行。

import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { IllegalMergeStateTransition, type MergeStateOrNull } from '@agent-workflow/shared'
import type { NodeRunStatus } from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, workflows } from '@/db/schema'
import {
  isStructurallySuperseded,
  isSupersedableMergeState,
  type SupersessionRow,
} from '@/modules/task-execution/domain/nodeRunSupersession'
import {
  resolveSchedulerRunRow,
  supersededPendingRows,
  type SchedulerRunRowCandidate,
} from '@/modules/task-execution/application/resolveSchedulerRunRow'
import type { NodeExecutionPersistence } from '@/modules/task-execution/application/ports/nodeExecutionPersistence'
import type {
  NodeRunLifecyclePersistence,
  NodeRunMintInput,
} from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import { structurallySupersededCondition } from '@/modules/task-execution/infrastructure/nodeRunSupersession'
import {
  withTaskExecutionSerializable,
  withTaskExecutionWrite,
} from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { describeEachProvider } from './helpers/eachProvider'
import { derivedSupersededIds, expectFencedToAbandoned } from './helpers/nodeRunSupersession'

/** 定长补零 id：字典序 = 数值序。 */
const mkId = (n: number): string => String(n).padStart(26, '0')

function row(
  n: number,
  opts: Partial<Omit<SupersessionRow, 'id'>> & { parent?: number } = {},
): SupersessionRow {
  return {
    id: mkId(n),
    nodeId: opts.nodeId ?? 'n',
    iteration: opts.iteration ?? 0,
    containerRunId: opts.containerRunId ?? null,
    parentNodeRunId: opts.parent === undefined ? (opts.parentNodeRunId ?? null) : mkId(opts.parent),
    shardKey: opts.shardKey ?? null,
  }
}

describe('RFC-369 §3 取代判据（纯函数）', () => {
  const superseded = (target: SupersessionRow, rows: readonly SupersessionRow[]) =>
    isStructurallySuperseded(target, rows)

  test('(a) 顶层行：同帧存在 id 更大的行即被取代；自身与更老的行不算', () => {
    const old = row(1)
    expect(superseded(old, [old, row(2)])).toBe(true)
    expect(superseded(old, [old])).toBe(false)
    expect(superseded(row(3), [row(1), row(2), row(3)])).toBe(false)
  })

  test('(a) shard 收口：新行带 shard 只取代同 shard；不带 shard 取代全部', () => {
    const a = row(1, { shardKey: 'a' })
    expect(superseded(a, [a, row(2, { shardKey: 'a' })])).toBe(true)
    expect(superseded(a, [a, row(2, { shardKey: 'b' })])).toBe(false)
    expect(superseded(a, [a, row(2)])).toBe(true)
    // 旧行不带 shard、新行带 shard：不取代（今天铸造按新行的 shard 收口）。
    const none = row(1)
    expect(superseded(none, [none, row(2, { shardKey: 'a' })])).toBe(false)
  })

  test('(a) 帧维度：nodeId / iteration / container 任一不同都不取代；container NULL 与 NULL 相等', () => {
    const old = row(1)
    expect(superseded(old, [old, row(2, { nodeId: 'other' })])).toBe(false)
    expect(superseded(old, [old, row(2, { iteration: 1 })])).toBe(false)
    expect(superseded(old, [old, row(2, { containerRunId: 'c' })])).toBe(false)
    const inFrame = row(1, { containerRunId: 'c' })
    expect(superseded(inFrame, [inFrame, row(2, { containerRunId: 'c' })])).toBe(true)
    expect(superseded(inFrame, [inFrame, row(2)])).toBe(false)
  })

  test('(a) 不约束更新一代是否顶层（与改前铸造的闭包一致）', () => {
    const old = row(1)
    expect(superseded(old, [old, row(2, { parent: 9 }), row(9)])).toBe(true)
  })

  test('(b) 直接子行随父：只看父行结构，孙行不在内；父行未被取代 / 父行缺失则不取代', () => {
    const parent = row(1)
    const child = row(2, { parent: 1, nodeId: 'inner', containerRunId: mkId(1), shardKey: 's' })
    const grandchild = row(3, { parent: 2, nodeId: 'deep', containerRunId: mkId(2) })
    const newerParent = row(10)
    const all = [parent, child, grandchild, newerParent]
    expect(superseded(child, all)).toBe(true)
    expect(superseded(grandchild, all)).toBe(false)
    expect(superseded(child, [parent, child, grandchild])).toBe(false)
    expect(superseded(child, [child, newerParent])).toBe(false)
  })

  test('可取代状态恰为 isolating / pending-merge / conflict-human', () => {
    const states: MergeStateOrNull[] = [
      null,
      'isolating',
      'pending-merge',
      'conflict-human',
      'merged',
      'merge-failed',
      'abandoned',
    ]
    expect(states.filter(isSupersedableMergeState)).toEqual([
      'isolating',
      'pending-merge',
      'conflict-human',
    ])
  })
})

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: SNAPSHOT })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/nonexistent/rfc369/repo',
    worktreePath: '/nonexistent/rfc369/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  r: SupersessionRow,
  opts: { mergeState?: MergeStateOrNull; status?: NodeRunStatus; isoNodeTree?: string } = {},
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: r.id,
    taskId,
    nodeId: r.nodeId,
    iteration: r.iteration,
    retryIndex: 0,
    status: opts.status ?? 'done',
    mergeState: opts.mergeState ?? null,
    parentNodeRunId: r.parentNodeRunId,
    containerRunId: r.containerRunId,
    shardKey: r.shardKey,
    ...(opts.isoNodeTree === undefined ? {} : { isoNodeTree: opts.isoNodeTree }),
    startedAt: Date.now() - 10,
  })
  return r.id
}

async function mergeStateOf(db: ProviderNeutralDatabase, id: string) {
  return (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
}

/** 确定性伪随机（LCG）：对拍的样本可复现。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

describeEachProvider('RFC-369 §3 判据：生产 SQL 谓词与纯函数对拍', (harness) => {
  test('随机样本上两者判出的结构性被取代集合逐行一致', async () => {
    for (const seed of [1, 7, 42, 2026, 369]) {
      const db = harness.db
      const taskId = await seedTask(db)
      const random = lcg(seed)
      const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!
      const rows: SupersessionRow[] = []
      for (let n = 1; n <= 30; n += 1) {
        const parent = rows.length > 0 && random() < 0.3 ? pick(rows).id : null
        const r: SupersessionRow = {
          id: mkId(seed * 1000 + n),
          nodeId: pick(['a', 'b']),
          iteration: pick([0, 1]),
          containerRunId: rows.length > 0 && random() < 0.35 ? pick(rows).id : null,
          parentNodeRunId: parent,
          shardKey: pick([null, null, 's1', 's2']),
        }
        rows.push(r)
        await seedRun(db, taskId, r, { mergeState: 'pending-merge' })
      }
      const sqlSet = (
        await db
          .select({ id: nodeRuns.id })
          .from(nodeRuns)
          .where(and(eq(nodeRuns.taskId, taskId), structurallySupersededCondition(db)))
      )
        .map((r) => r.id)
        .sort()
      const pureSet = rows
        .filter((r) => isStructurallySuperseded(r, rows))
        .map((r) => r.id)
        .sort()
      expect({ seed, ids: sqlSet }).toEqual({ seed, ids: pureSet })
      // 样本必须真的覆盖两类结果，否则对拍是空洞绿。
      expect(pureSet.length).toBeGreaterThan(0)
      expect(pureSet.length).toBeLessThan(rows.length)
    }
  })
})

describeEachProvider('RFC-369 AC-2 —— 同任务并发铸造不再互相中止（PG SERIALIZABLE）', (harness) => {
  test('两笔都铸完再提交：每笔事务体只执行一次（无序列化重放）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    // 同一任务里已有若干行，让两次铸造落在同一批索引页上（改前的同帧范围读就在这里互判读写依赖）。
    for (let n = 1; n <= 4; n += 1) {
      await seedRun(db, taskId, row(n, { nodeId: n % 2 === 0 ? 'a' : 'b' }), {
        mergeState: 'isolating',
      })
    }
    const concurrent = harness.applicationBinding.provider === 'postgresql'
    let arrived = 0
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolveBarrier) => {
      releaseBarrier = resolveBarrier
    })
    const bodyRuns = { a: 0, b: 0 }
    const mintIn = async (nodeId: 'a' | 'b', id: string) =>
      await withTaskExecutionSerializable(db, async (tx) => {
        bodyRuns[nodeId] += 1
        await createNodeRunMintParticipantInTx(tx).mint({
          id,
          taskId,
          nodeId,
          iteration: 0,
          status: 'pending',
          cause: 'initial',
        })
        // 只在第一次执行时等对方：两笔都已铸完、都还没提交——改前这里必然互判读写依赖。
        if (concurrent && bodyRuns[nodeId] === 1) {
          arrived += 1
          if (arrived === 2) releaseBarrier()
          await barrier
        }
      })
    // SQLite 的 BEGIN IMMEDIATE 全库独占，两笔只能先后执行；判据在那里同样成立（各执行一次）。
    if (concurrent) {
      await Promise.all([mintIn('a', mkId(10)), mintIn('b', mkId(11))])
    } else {
      await mintIn('a', mkId(10))
      await mintIn('b', mkId(11))
    }
    expect(bodyRuns).toEqual({ a: 1, b: 1 })
    expect(
      (await db.select({ id: nodeRuns.id }).from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
        .length,
    ).toBe(6)
  })
})

describeEachProvider('RFC-369 AC-4 —— 迁移围栏：被取代即收成 abandoned 并落库', (harness) => {
  test('非 abandon 迁移被拦：abandoned 在事务提交后才抛出，且本次迁移的 extra 不落到被取代行上', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const old = await seedRun(db, taskId, row(1), {
      mergeState: 'isolating',
      isoNodeTree: 'old-tree',
    })
    await seedRun(db, taskId, row(2))
    const failure = await new DrizzleMergeStateLifecyclePersistence(db)
      .transition({
        nodeRunId: old,
        event: { kind: 'mark-pending-merge' },
        extra: { isoNodeTree: 'stale-tree' },
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(IllegalMergeStateTransition)
    const after = await mergeStateOf(db, old)
    expect(after.mergeState).toBe('abandoned')
    expect(after.isoNodeTree).toBe('old-tree')
  })

  test('tryTransition：被取代 → false，同样落 abandoned', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const old = await seedRun(db, taskId, row(1), { mergeState: 'pending-merge' })
    await seedRun(db, taskId, row(2))
    await expect(
      new DrizzleMergeStateLifecyclePersistence(db).tryTransition({
        nodeRunId: old,
        event: { kind: 'mark-merged' },
      }),
    ).resolves.toBe(false)
    expect((await mergeStateOf(db, old)).mergeState).toBe('abandoned')
  })

  test('abandon 事件照常迁移并返回（不抛）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const old = await seedRun(db, taskId, row(1), { mergeState: 'conflict-human' })
    await seedRun(db, taskId, row(2))
    await expect(
      new DrizzleMergeStateLifecyclePersistence(db).transition({
        nodeRunId: old,
        event: { kind: 'abandon', reason: 'test' },
      }),
    ).resolves.toEqual({ from: 'conflict-human', to: 'abandoned' })
  })

  test('merge_state 为 NULL 的被取代行：begin-isolation 放行，在 mark-pending-merge 处被拦（碰 canonical 之前）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const old = await seedRun(db, taskId, row(1))
    await seedRun(db, taskId, row(2))
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    await expect(
      persistence.transition({ nodeRunId: old, event: { kind: 'begin-isolation' } }),
    ).resolves.toEqual({ from: null, to: 'isolating' })
    await expectFencedToAbandoned(db, old)
  })

  test('子行随父被取代，与父行自身的 merge_state 无关（扇出父行常为 NULL / merged）', async () => {
    for (const [offset, parentState] of [
      [0, null],
      [100, 'merged'],
    ] as const) {
      const db = harness.db
      const taskId = await seedTask(db)
      const parent = await seedRun(db, taskId, row(offset + 1), { mergeState: parentState })
      const child = await seedRun(
        db,
        taskId,
        row(offset + 2, {
          parent: offset + 1,
          nodeId: 'inner',
          containerRunId: mkId(offset + 1),
          shardKey: 's',
        }),
        { mergeState: 'pending-merge' },
      )
      await seedRun(db, taskId, row(offset + 3))
      expect(await derivedSupersededIds(db, taskId)).toEqual([child])
      await expectFencedToAbandoned(db, child)
      expect((await mergeStateOf(db, parent)).mergeState).toBe(parentState)
    }
  })

  test('在外层事务帧里调用直接拒绝（否则收尾会随外层回滚）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const live = await seedRun(db, taskId, row(1), { mergeState: 'isolating' })
    await expect(
      withTaskExecutionWrite(db, async () =>
        new DrizzleMergeStateLifecyclePersistence(db).transition({
          nodeRunId: live,
          event: { kind: 'mark-pending-merge' },
        }),
      ),
    ).rejects.toThrow('RFC-369 §4.2')
    expect((await mergeStateOf(db, live)).mergeState).toBe('isolating')
  })

  test('未被取代的行不受影响（最新一代照常前进）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    await seedRun(db, taskId, row(1), { mergeState: 'merged' })
    const fresh = await seedRun(db, taskId, row(2), { mergeState: 'isolating' })
    await expect(
      new DrizzleMergeStateLifecyclePersistence(db).transition({
        nodeRunId: fresh,
        event: { kind: 'mark-pending-merge' },
      }),
    ).resolves.toEqual({ from: 'isolating', to: 'pending-merge' })
  })
})

describeEachProvider('RFC-369 §4.3 / AC-7 —— 入口重放排除已被取代的行', (harness) => {
  test('excludeSuperseded：遗留的被取代 pending-merge 行（含随父的子行）不进重放集合', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    // 遗留行：改前未被 0076 / 铸造 abandon 过的旧代（AC-7 情形 3）。
    const legacy = await seedRun(db, taskId, row(1), { mergeState: 'pending-merge' })
    const legacyChild = await seedRun(
      db,
      taskId,
      row(2, { parent: 1, nodeId: 'inner', containerRunId: mkId(1), shardKey: 's' }),
      { mergeState: 'pending-merge' },
    )
    const freshest = await seedRun(db, taskId, row(3), { mergeState: 'pending-merge' })
    const otherNode = await seedRun(db, taskId, row(4, { nodeId: 'other' }), {
      mergeState: 'pending-merge',
    })
    const persistence = new DrizzleNodeExecutionPersistence(db)
    const all = await persistence.list({ taskId, mergeState: 'pending-merge' })
    expect(all.map((r) => r.id)).toEqual([legacy, legacyChild, freshest, otherNode])
    const live = await persistence.list({
      taskId,
      mergeState: 'pending-merge',
      excludeSuperseded: true,
    })
    expect(live.map((r) => r.id)).toEqual([freshest, otherNode])
  })

  test('AC-7 情形 2：ULID 不严格单调——id 更小、提交更晚的行一出现即被视为旧代', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    // 先提交 id 更大的一代，再提交 id 更小的一行（先 ulid() 后提交）。
    await seedRun(db, taskId, row(20))
    const lateButSmaller = await seedRun(db, taskId, row(10))
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    await persistence.transition({ nodeRunId: lateButSmaller, event: { kind: 'begin-isolation' } })
    await expectFencedToAbandoned(db, lateButSmaller)
  })
})

// ---- AC-8：调度器跳过已被取代的 pending 行 --------------------------------------------------

interface FakeRow extends SchedulerRunRowCandidate {
  readonly nodeId: string
}

function candidate(
  n: number,
  status: NodeRunStatus,
  opts: {
    shardKey?: string | null
    containerRunId?: string | null
    retryIndex?: number
    parent?: number
  } = {},
): FakeRow {
  return {
    id: mkId(n),
    nodeId: 'n',
    status,
    retryIndex: opts.retryIndex ?? 0,
    reviewIteration: 0,
    shardKey: opts.shardKey ?? null,
    parentNodeRunId: opts.parent === undefined ? null : mkId(opts.parent),
    ...(opts.containerRunId === undefined ? {} : { containerRunId: opts.containerRunId }),
  }
}

function fakes() {
  const calls: {
    transitions: Array<{ nodeRunId: string; kind: string }>
    mints: NodeRunMintInput[]
    patches: string[]
    canceled: string[]
    pending: string[]
  } = { transitions: [], mints: [], patches: [], canceled: [], pending: [] }
  const lifecycle = {
    async mint(input: NodeRunMintInput) {
      calls.mints.push(input)
      return mkId(99)
    },
    async transition(input: Parameters<NodeRunLifecyclePersistence['transition']>[0]) {
      calls.transitions.push({ nodeRunId: input.nodeRunId, kind: input.event.kind })
      return { from: 'pending' as const, to: 'canceled' as const }
    },
    async set() {
      throw new Error('not used')
    },
    async loadEnvelopeNonce() {
      throw new Error('not used')
    },
  } satisfies NodeRunLifecyclePersistence
  const projections = {
    async patch(input: { nodeRunId: string }) {
      calls.patches.push(input.nodeRunId)
      return true
    },
  } as unknown as NodeExecutionPersistence
  return { calls, lifecycle, projections }
}

async function resolveWith(
  rows: readonly FakeRow[],
  containerRunId: string | null = null,
  transitionError?: unknown,
) {
  const f = fakes()
  if (transitionError !== undefined) {
    f.lifecycle.transition = async () => {
      throw transitionError
    }
  }
  const result = await resolveSchedulerRunRow({
    lifecycle: f.lifecycle,
    projections: f.projections,
    taskId: 't',
    nodeId: 'n',
    containerRunId,
    iteration: 0,
    consumedUpstreamJson: '{}',
    rows,
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastPending: (id) => f.calls.pending.push(id),
    broadcastCanceled: (id) => f.calls.canceled.push(id),
  })
  return { result, calls: f.calls }
}

describe('RFC-369 AC-8 —— 调度器跳过已被同帧更新一代取代的 pending 行', () => {
  test('较老 pending 行 + 同帧更新的 failed 占位行：不采纳、终结为 canceled、新铸一行（revival，retryIndex=max+1）', async () => {
    const { result, calls } = await resolveWith([
      candidate(1, 'pending', { retryIndex: 0 }),
      candidate(2, 'failed', { retryIndex: 1 }),
    ])
    expect(calls.transitions).toEqual([{ nodeRunId: mkId(1), kind: 'cancel-by-supersede' }])
    expect(calls.canceled).toEqual([mkId(1)])
    expect(calls.patches).toEqual([])
    expect(calls.mints).toHaveLength(1)
    expect(calls.mints[0]!.cause).toBe('revival')
    expect(calls.mints[0]!.retryIndex).toBe(2)
    expect(result).toEqual({
      nodeRunId: mkId(99),
      retryIndex: 2,
      latestExisting: expect.objectContaining({ id: mkId(2) }),
      adopted: false,
    })
  })

  test('反向：最新一行本身是 pending ⇒ 照常采纳，不终结任何行', async () => {
    const { result, calls } = await resolveWith([
      candidate(1, 'failed'),
      candidate(2, 'pending', { retryIndex: 1 }),
    ])
    expect(calls.transitions).toEqual([])
    expect(calls.mints).toEqual([])
    expect(calls.patches).toEqual([mkId(2)])
    expect(result.nodeRunId).toBe(mkId(2))
  })

  test('反向：兄弟 shard 的更新行不取代本 shard 的 pending 行', async () => {
    const { result, calls } = await resolveWith([
      candidate(1, 'pending', { shardKey: 'a' }),
      candidate(2, 'failed', { shardKey: 'b' }),
    ])
    expect(calls.transitions).toEqual([])
    expect(result.nodeRunId).toBe(mkId(1))
  })

  test('反向：另一帧（container 不同）的更新行不取代；containerRunId 缺省按 NULL', async () => {
    const { result, calls } = await resolveWith([
      candidate(1, 'pending'),
      candidate(2, 'failed', { containerRunId: 'other-frame' }),
    ])
    expect(calls.transitions).toEqual([])
    expect(result.nodeRunId).toBe(mkId(1))
  })

  test('实现门 P3-2：终结时行已被别处改走（CAS 不中 / 非法迁移）⇒ 跳过、不广播，照常新铸', async () => {
    for (const code of ['concurrent-node-run-transition', 'illegal-node-run-transition']) {
      const { result, calls } = await resolveWith(
        [candidate(1, 'pending'), candidate(2, 'failed', { retryIndex: 1 })],
        null,
        Object.assign(new Error('moved'), { code }),
      )
      expect(calls.canceled).toEqual([])
      expect(calls.mints).toHaveLength(1)
      expect(result.nodeRunId).toBe(mkId(99))
    }
    await expect(
      resolveWith(
        [candidate(1, 'pending'), candidate(2, 'failed')],
        null,
        new Error('database down'),
      ),
    ).rejects.toThrow('database down')
  })

  test('实现门 P3-3：唯一更新一代是子行时，刚终结的最新顶层行按 canceled 定 cause（revival）', async () => {
    const { calls } = await resolveWith([
      candidate(1, 'pending'),
      candidate(2, 'done', { parent: 5 }),
    ])
    expect(calls.canceled).toEqual([mkId(1)])
    expect(calls.mints[0]!.cause).toBe('revival')
  })

  test('比较集合是全部行：子行（非顶层）作为更新一代同样取代较老的顶层 pending 行', () => {
    expect([
      ...supersededPendingRows({
        nodeId: 'n',
        iteration: 0,
        rows: [candidate(1, 'pending'), candidate(2, 'done', { parent: 5 })],
      }),
    ]).toEqual([mkId(1)])
  })
})

describeEachProvider(
  'RFC-369 AC-8 反向（真库）—— 既有「先铸 pending 再调度」路径照常采纳新铸行',
  (harness) => {
    // 重试级联 / 反问回答重跑 / 评审驳回重跑 / 中断续跑：都是先铸一条**最新**的 pending 行、再交给调度器。
    // 它不被任何更新一代取代，必须照常被采纳；更老的各代一行都不动。
    test.each(['retry-node-cascade', 'clarify-answer', 'review-reject', 'revival'] as const)(
      '%s：采纳新铸的 pending 行，不终结任何行、不新铸',
      async (cause) => {
        const db = harness.db
        const taskId = await seedTask(db)
        await seedRun(db, taskId, row(1), { status: 'done', mergeState: 'merged' })
        await seedRun(db, taskId, row(2), { status: 'failed' })
        await seedRun(db, taskId, row(3), { status: 'interrupted' })
        const lifecycle = new DrizzleNodeRunLifecyclePersistence(db)
        const projections = new DrizzleNodeExecutionPersistence(db)
        const minted = await lifecycle.mint({
          taskId,
          nodeId: 'n',
          status: 'pending',
          cause,
          retryIndex: 1,
          containerRunId: null,
          iteration: 0,
        })
        const canceled: string[] = []
        const result = await resolveSchedulerRunRow({
          lifecycle,
          projections,
          taskId,
          nodeId: 'n',
          containerRunId: null,
          iteration: 0,
          consumedUpstreamJson: '{}',
          rows: await projections.list({ taskId, nodeId: 'n', iteration: 0 }),
          inheritReviewIteration: true,
          clearAgentOverride: true,
          trackRetryIndex: true,
          broadcastPending: null,
          broadcastCanceled: (id) => canceled.push(id),
        })
        expect(result).toMatchObject({ nodeRunId: minted, adopted: false })
        expect(canceled).toEqual([])
        const statuses = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
          .map((r) => [r.id === minted ? 'minted' : r.id, r.status])
          .sort()
        expect(statuses).toEqual(
          [
            [mkId(1), 'done'],
            [mkId(2), 'failed'],
            [mkId(3), 'interrupted'],
            ['minted', 'pending'],
          ].sort(),
        )
      },
    )

    test('跨帧：另一帧里被取代的 pending 行不采纳、也不由本帧终结（留给它自己的调度器）', async () => {
      const db = harness.db
      const taskId = await seedTask(db)
      const frame = await seedRun(db, taskId, row(1, { nodeId: 'wrap' }))
      const otherFrameStale = await seedRun(db, taskId, row(2, { containerRunId: frame }), {
        status: 'pending',
      })
      await seedRun(db, taskId, row(3, { containerRunId: frame }), { status: 'failed' })
      const lifecycle = new DrizzleNodeRunLifecyclePersistence(db)
      const projections = new DrizzleNodeExecutionPersistence(db)
      const canceled: string[] = []
      const result = await resolveSchedulerRunRow({
        lifecycle,
        projections,
        taskId,
        nodeId: 'n',
        containerRunId: null,
        iteration: 0,
        consumedUpstreamJson: '{}',
        rows: await projections.list({ taskId, nodeId: 'n', iteration: 0 }),
        inheritReviewIteration: true,
        clearAgentOverride: true,
        trackRetryIndex: true,
        broadcastPending: null,
        broadcastCanceled: (id) => canceled.push(id),
      })
      expect(result.nodeRunId).not.toBe(otherFrameStale)
      expect(canceled).toEqual([])
      expect((await mergeStateOf(db, otherFrameStale)).status).toBe('pending')
    })
  },
)
