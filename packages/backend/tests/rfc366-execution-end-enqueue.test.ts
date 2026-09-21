// RFC-366 —— 两类新信号源的入队行为，以及准入门在**真实 store 上**的落地。
//
// `rfc366-distill-admission.test.ts` 锁的是纯判据；这里锁的是「判据接进
// enqueueDistillJob 之后，`memory_distill_jobs` 里到底落了什么行」——包括
// scope 收窄（D11）、去抖键（D8/D11）与热读策略（D10）。
//
// 覆盖 proposal §7 的 AC-1/2/3/4/5/6/7/8/10/11/12。

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import {
  DEFAULT_DISTILL_POLICY,
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
