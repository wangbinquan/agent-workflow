// RFC-366 —— 两类新信号源的入队行为，以及准入门在**真实 store 上**的落地。
//
// `rfc366-distill-admission.test.ts` 锁的是纯判据；这里锁的是「判据接进
// enqueueDistillJob 之后，`memory_distill_jobs` 里到底落了什么行」——包括
// scope 收窄（D11）、去抖键（D8/D11）与热读策略（D10）。
//
// 覆盖 proposal §7 的 AC-1/2/3/4/5/6/7/8/9/10/11/12/20。

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import {
  DEFAULT_CONFIG,
  DEFAULT_DISTILL_POLICY,
  resolveDistillPolicy,
  type Config,
  type DistillPolicy,
  type DistillSourceKind,
  type ResolvedDistillScope,
  type TaskLaunchOrigin,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { memoryDistillJobs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  enqueueDistillJob,
  resetMemoryDistillPolicyProviderForTest,
  setMemoryDistillPolicyProvider,
} from '../src/modules/memory/application/distill/schedule'
import { describeEachProvider } from './helpers/eachProvider'
import { createSqliteMemoryDistillTestContext } from './helpers/memoryDistill'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const AGENT_A = ulid()
const AGENT_B = ulid()

const SNAPSHOT = JSON.stringify({
  schemaVersion: 1,
  nodes: [
    { id: 'agent-a', kind: 'agent-single', agentId: AGENT_A, agentName: 'writer' },
    { id: 'agent-b', kind: 'agent-single', agentId: AGENT_B, agentName: 'auditor' },
    { id: 'named-only', kind: 'agent-single', agentName: 'legacy' },
    { id: 'out-1', kind: 'output' },
  ],
})

interface Fixture {
  readonly taskId: string
  readonly runIds: Record<string, string>
}

describeEachProvider('RFC-366 execution-end distill enqueue', (harness) => {
  let db: ProviderNeutralDatabase
  let memory: ReturnType<typeof createSqliteMemoryDistillTestContext>

  beforeEach(() => {
    db = harness.db
    memory = createSqliteMemoryDistillTestContext(db)
    resetBroadcastersForTests()
    resetMemoryDistillPolicyProviderForTest()
  })
  afterEach(() => {
    resetMemoryDistillPolicyProviderForTest()
  })

  function policy(overrides: Partial<DistillPolicy> = {}): void {
    setMemoryDistillPolicyProvider(() => ({ ...DEFAULT_DISTILL_POLICY, ...overrides }))
  }

  async function seedTask(
    overrides: {
      launchOrigin?: TaskLaunchOrigin
      catalogVisibility?: 'public' | 'internal'
      spaceKind?: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
      parentTaskId?: string
    } = {},
  ): Promise<Fixture> {
    const workflowId = ulid()
    await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: `wf-${workflowId}`,
        definition: SNAPSHOT,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    const taskId = ulid()
    await db
      .insert(tasks)
      .values({
        id: taskId,
        executionLineageId: taskId,
        lineageSlotPathJson: JSON.stringify([
          { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
        ]),
        name: 'rfc366-fixture',
        workflowId,
        workflowSnapshot: SNAPSHOT,
        repoPath: '/tmp/wt',
        worktreePath: '/tmp/wt',
        baseBranch: 'main',
        branch: `agent-workflow/${taskId}`,
        status: 'done',
        inputs: '{}',
        startedAt: Date.now(),
        ...(overrides.launchOrigin === undefined ? {} : { launchOrigin: overrides.launchOrigin }),
        ...(overrides.catalogVisibility === undefined
          ? {}
          : { catalogVisibility: overrides.catalogVisibility }),
        ...(overrides.spaceKind === undefined ? {} : { spaceKind: overrides.spaceKind }),
        ...(overrides.parentTaskId === undefined
          ? {}
          : { parentTaskId: overrides.parentTaskId, parentNodeRunId: ulid() }),
      })
      .run()
    const runIds: Record<string, string> = {}
    for (const nodeId of ['agent-a', 'agent-b', 'named-only']) {
      const runId = ulid()
      runIds[nodeId] = runId
      await db
        .insert(nodeRuns)
        .values({
          id: runId,
          taskId,
          nodeId,
          iteration: 0,
          retryIndex: 0,
          reviewIteration: 0,
          status: 'done',
          startedAt: Date.now(),
        })
        .run()
    }
    return { taskId, runIds }
  }

  const rowsOf = async (taskId: string) =>
    await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.taskId, taskId)).all()

  // --- AC-1 / AC-4 / AC-12 -------------------------------------------------

  test('AC-1: agent 运行结束落一行 agent-run，sourceEventId 是 node_run id', async () => {
    const fx = await seedTask()
    const result = await enqueueDistillJob(memory.store, {
      sourceKind: 'agent-run',
      sourceEventId: fx.runIds['agent-a']!,
      taskId: fx.taskId,
      nodeId: 'agent-a',
    })
    expect(result).not.toBeNull()
    const rows = await rowsOf(fx.taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sourceKind).toBe('agent-run')
    expect(rows[0]!.sourceEventId).toBe(fx.runIds['agent-a']!)
    expect(rows[0]!.taskId).toBe(fx.taskId)
    expect(rows[0]!.status).toBe('pending')
  })

  test('AC-4: 任务结束落一行 task-run，sourceEventId 是 task id', async () => {
    const fx = await seedTask()
    await enqueueDistillJob(memory.store, {
      sourceKind: 'task-run',
      sourceEventId: fx.taskId,
      taskId: fx.taskId,
    })
    const rows = await rowsOf(fx.taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sourceKind).toBe('task-run')
    expect(rows[0]!.sourceEventId).toBe(fx.taskId)
    expect(rows[0]!.debounceKey).toBe(`${fx.taskId}:task-run`)
  })

  test('AC-12: agent-run 的 scope 只含本次结束的那个 agent', async () => {
    const fx = await seedTask()
    await enqueueDistillJob(memory.store, {
      sourceKind: 'agent-run',
      sourceEventId: fx.runIds['agent-b']!,
      taskId: fx.taskId,
      nodeId: 'agent-b',
    })
    const rows = await rowsOf(fx.taskId)
    const scope = JSON.parse(rows[0]!.scopeResolvedJson) as { agentIds: string[] }
    expect(scope.agentIds).toEqual([AGENT_B])
  })

  test('其余四类源的 scope 不收窄（逐字保持 RFC-041 行为）', async () => {
    const fx = await seedTask()
    await enqueueDistillJob(memory.store, {
      sourceKind: 'feedback',
      sourceEventId: 'f1',
      taskId: fx.taskId,
    })
    const rows = await rowsOf(fx.taskId)
    const scope = JSON.parse(rows[0]!.scopeResolvedJson) as { agentIds: string[] }
    expect([...scope.agentIds].sort()).toEqual([AGENT_A, AGENT_B].sort())
  })

  test('解析不出 agent 的节点：不收窄 scope，去抖键回落到节点', async () => {
    const fx = await seedTask()
    const result = await enqueueDistillJob(memory.store, {
      sourceKind: 'agent-run',
      sourceEventId: fx.runIds['named-only']!,
      taskId: fx.taskId,
      nodeId: 'named-only',
    })
    expect(result!.debounceKey).toBe(`${fx.taskId}:agent-run:node:named-only`)
    const rows = await rowsOf(fx.taskId)
    const scope = JSON.parse(rows[0]!.scopeResolvedJson) as { agentIds: string[] }
    expect([...scope.agentIds].sort()).toEqual([AGENT_A, AGENT_B].sort())
  })

  // --- AC-10 / AC-11：去抖键合并 -------------------------------------------

  test('AC-10/11: 同一 agent 的多次运行（loop 轮次 / fanout 分片 / 重试）共用一个去抖键', async () => {
    const fx = await seedTask()
    const keys: string[] = []
    for (const suffix of ['r1', 'r2', 'r3']) {
      const runId = ulid()
      await db
        .insert(nodeRuns)
        .values({
          id: runId,
          taskId: fx.taskId,
          nodeId: 'agent-a',
          iteration: 0,
          retryIndex: 0,
          reviewIteration: 0,
          status: 'done',
          startedAt: Date.now(),
          shardKey: suffix,
        })
        .run()
      const r = await enqueueDistillJob(memory.store, {
        sourceKind: 'agent-run',
        sourceEventId: runId,
        taskId: fx.taskId,
        nodeId: 'agent-a',
      })
      keys.push(r!.debounceKey)
    }
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe(`${fx.taskId}:agent-run:${AGENT_A}`)
  })

  test('不变量：同一去抖键 ⇒ 同一 scope（不同 agent 必须是不同的键）', async () => {
    const fx = await seedTask()
    const a = await enqueueDistillJob(memory.store, {
      sourceKind: 'agent-run',
      sourceEventId: fx.runIds['agent-a']!,
      taskId: fx.taskId,
      nodeId: 'agent-a',
    })
    const b = await enqueueDistillJob(memory.store, {
      sourceKind: 'agent-run',
      sourceEventId: fx.runIds['agent-b']!,
      taskId: fx.taskId,
      nodeId: 'agent-b',
    })
    // 同键会被 distillTick 合并成一次运行，而 runDistill 只用 head 的 scope——
    // 两个 agent 落同一个键就意味着 B 的会话会产出挂在 A 名下的记忆。
    expect(a!.debounceKey).not.toBe(b!.debounceKey)
  })

  test('D8: agent-run 用更长的去抖窗口，其余四类仍是 5s', async () => {
    const fx = await seedTask()
    policy({ agentRunDebounceMs: 60_000 })
    const before = Date.now()
    const agentRun = await enqueueDistillJob(memory.store, {
      sourceKind: 'agent-run',
      sourceEventId: fx.runIds['agent-a']!,
      taskId: fx.taskId,
      nodeId: 'agent-a',
    })
    const taskRun = await enqueueDistillJob(memory.store, {
      sourceKind: 'task-run',
      sourceEventId: fx.taskId,
      taskId: fx.taskId,
    })
    expect(agentRun!.nextRunAt).toBeGreaterThanOrEqual(before + 60_000 - 200)
    expect(taskRun!.nextRunAt).toBeLessThanOrEqual(before + 5_000 + 200)
  })

  // --- AC-5 / AC-7 / AC-8：拒绝分支 ---------------------------------------

  test('AC-5: 定时任务在默认配置下五类源一律不入队（能力影响清单 C1–C3）', async () => {
    const fx = await seedTask({ launchOrigin: 'scheduled' })
    for (const kind of ['clarify', 'review', 'feedback', 'agent-run', 'task-run'] as const) {
      const result = await enqueueDistillJob(memory.store, {
        sourceKind: kind,
        sourceEventId: kind === 'agent-run' ? fx.runIds['agent-a']! : fx.taskId,
        taskId: fx.taskId,
        ...(kind === 'agent-run' ? { nodeId: 'agent-a' } : {}),
      })
      expect(result).toBeNull()
    }
    expect(await rowsOf(fx.taskId)).toHaveLength(0)
  })

  for (const origin of ['webhook', 'event', 'api'] as const) {
    test(`AC-5: ${origin} 任务默认不入队（能力影响清单 C4–C6）`, async () => {
      const fx = await seedTask({ launchOrigin: origin })
      expect(
        await enqueueDistillJob(memory.store, {
          sourceKind: 'task-run',
          sourceEventId: fx.taskId,
          taskId: fx.taskId,
        }),
      ).toBeNull()
      expect(await rowsOf(fx.taskId)).toHaveLength(0)
    })
  }

  test('AC-8: 内部任务两种标记各自都拒，且与白名单无关（能力影响清单 C7）', async () => {
    policy({ launchOrigins: ['manual', 'scheduled', 'event', 'webhook', 'api'] })
    for (const overrides of [
      { catalogVisibility: 'internal' as const },
      { spaceKind: 'internal' as const },
    ]) {
      const fx = await seedTask(overrides)
      for (const kind of ['clarify', 'review', 'feedback', 'task-run'] as const) {
        expect(
          await enqueueDistillJob(memory.store, {
            sourceKind: kind,
            sourceEventId: fx.taskId,
            taskId: fx.taskId,
          }),
        ).toBeNull()
      }
      expect(await rowsOf(fx.taskId)).toHaveLength(0)
    }
  })

  test('AC-7: 关掉 agentRun 开关只影响该源', async () => {
    const fx = await seedTask()
    policy({ sources: { ...DEFAULT_DISTILL_POLICY.sources, 'agent-run': false } })
    expect(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'agent-run',
        sourceEventId: fx.runIds['agent-a']!,
        taskId: fx.taskId,
        nodeId: 'agent-a',
      }),
    ).toBeNull()
    expect(
      await enqueueDistillJob(memory.store, {
        sourceKind: 'task-run',
        sourceEventId: fx.taskId,
        taskId: fx.taskId,
      }),
    ).not.toBeNull()
    const rows = await rowsOf(fx.taskId)
    expect(rows.map((r) => r.sourceKind)).toEqual(['task-run'])
  })

  // --- AC-6：热读 ---------------------------------------------------------

  test('AC-6: 策略在两次入队之间改变即刻生效（不需要重启 daemon）', async () => {
    const fx = await seedTask({ launchOrigin: 'scheduled' })
    let origins: readonly TaskLaunchOrigin[] = ['manual']
    setMemoryDistillPolicyProvider(() => ({ ...DEFAULT_DISTILL_POLICY, launchOrigins: origins }))

    const enqueue = async (kind: DistillSourceKind) =>
      await enqueueDistillJob(memory.store, {
        sourceKind: kind,
        sourceEventId: fx.taskId,
        taskId: fx.taskId,
      })

    expect(await enqueue('task-run')).toBeNull()
    origins = ['manual', 'scheduled']
    expect(await enqueue('task-run')).not.toBeNull()
    expect(await rowsOf(fx.taskId)).toHaveLength(1)
  })

  // --- AC-9 / AC-20 -------------------------------------------------------

  // RFC-366 AC-9。**继承这件事本身不在这里证**——「子任务原样复制父任务的
  // `launch_origin`」是 RFC-301 的法条，锁在
  // `tests/rfc301-task-launch-origin-inheritance.test.ts`。这里锁的是 RFC-366 欠的那一半：
  // 准入门读的是**任务自己那一行**的 launch_origin，对子任务不做任何特殊处理。
  // 漏掉它的形态很具体：如果哪天有人为「子任务是平台自己拉起的」加一条旁路
  // （把子任务当 internal，或按 parent_task_id 另判），定时任务的整棵子树就会
  // 悄悄恢复提炼 —— 而 C1–C6 的那几条用例只喂根任务，一条都不会红。
  test('AC-9: 子任务按自己那一行的 launch_origin 判，与父任务同进同出', async () => {
    const scheduledParent = await seedTask({ launchOrigin: 'scheduled' })
    const scheduledChild = await seedTask({
      launchOrigin: 'scheduled', // RFC-301：这一列是父任务值的逐字复制
      parentTaskId: scheduledParent.taskId,
    })
    for (const fx of [scheduledParent, scheduledChild]) {
      expect(
        await enqueueDistillJob(memory.store, {
          sourceKind: 'task-run',
          sourceEventId: fx.taskId,
          taskId: fx.taskId,
        }),
      ).toBeNull()
      expect(await rowsOf(fx.taskId)).toHaveLength(0)
    }

    // 反证：父任务是 manual 时，子任务同样照常入队——被拒的原因只能是 launch_origin
    // 本身，不能是「它是个子任务」。
    const manualParent = await seedTask({ launchOrigin: 'manual' })
    const manualChild = await seedTask({
      launchOrigin: 'manual',
      parentTaskId: manualParent.taskId,
    })
    for (const fx of [manualParent, manualChild]) {
      expect(
        await enqueueDistillJob(memory.store, {
          sourceKind: 'task-run',
          sourceEventId: fx.taskId,
          taskId: fx.taskId,
        }),
      ).not.toBeNull()
      const rows = await rowsOf(fx.taskId)
      expect(rows).toHaveLength(1)
      // 否则这半边会**假绿**：任务行要是没被 findTaskScope 找到（父链列写坏、夹具漏了
      // 某个必填列），准入门走的是「无任务放行」那条分支，`not.toBeNull()` 照样成立，
      // 而我们其实什么都没验证到。scope 里的 workflowId 只有真读到了行才会有值
      // ——对照上面那条 orphan 用例，它断言的正是全 null 的退化形态。
      const scope = JSON.parse(rows[0]!.scopeResolvedJson) as ResolvedDistillScope
      expect(scope.workflowId).not.toBeNull()
    }
  })

  // RFC-366 AC-20：`memoryDistillerEnabled=false` 关的是**蒸馏器**，不是**入队**。
  // 两者是两个阶段：那个开关只让 worker tick 变成空壳（`cli/start.ts` 的
  // `if (current.memoryDistillerEnabled === false) return`），队列照常积累、审计行照常写，
  // 重新打开后积压的行继续被消费。
  //
  // 现在它成立是靠构造——`resolveDistillPolicy` 的入参 `Pick` 里根本没有这个键，所以
  // 准入门物理上读不到它。但「靠构造成立」不等于「有锁」：把它塞进 policy 并在闸里顺手
  // 一判，是完全写得出来的一行，而那会让关掉蒸馏器的部署**静默丢掉**这段时间的全部信号，
  // 重新打开也补不回来。所以在这里把它钉死。
  test('AC-20: memoryDistillerEnabled=false 时五类源仍照常入队（那个开关只闸 worker）', async () => {
    const fx = await seedTask({ launchOrigin: 'manual' })
    // 经**完整 Config** 交进去，不是手搓一个只含三个键的字面量：`resolveDistillPolicy`
    // 的入参是 `Pick<Config, …>`，直接塞 `{ …, memoryDistillerEnabled: false }` 会被
    // 多余属性检查拦在编译期——那正是本用例要锁的事实（这个键根本不在准入门的可视面里），
    // 但编译不过就没有运行期断言了，所以先落成一个真正的 Config 再交。
    const config: Config = { ...DEFAULT_CONFIG, memoryDistillerEnabled: false }
    setMemoryDistillPolicyProvider(() => resolveDistillPolicy(config))
    const kinds: readonly DistillSourceKind[] = [
      'clarify',
      'review',
      'feedback',
      'agent-run',
      'task-run',
    ]
    for (const sourceKind of kinds) {
      expect(
        await enqueueDistillJob(memory.store, {
          sourceKind,
          sourceEventId: `${sourceKind}-${fx.taskId}`,
          taskId: fx.taskId,
          ...(sourceKind === 'agent-run' ? { nodeId: 'agent-a' } : {}),
        }),
      ).not.toBeNull()
    }
    expect((await rowsOf(fx.taskId)).map((row) => row.sourceKind).sort()).toEqual([...kinds].sort())
  })

  test('任务行不存在时仍放行（scope 退化为 global-only，与既有行为一致）', async () => {
    const orphanTaskId = ulid()
    const result = await enqueueDistillJob(memory.store, {
      sourceKind: 'task-run',
      sourceEventId: orphanTaskId,
      taskId: orphanTaskId,
    })
    expect(result).not.toBeNull()
    const rows = await rowsOf(orphanTaskId)
    const scope = JSON.parse(rows[0]!.scopeResolvedJson) as ResolvedDistillScope
    expect(scope).toEqual({ agentIds: [], workflowId: null, repoId: null, includeGlobal: true })
  })
})
