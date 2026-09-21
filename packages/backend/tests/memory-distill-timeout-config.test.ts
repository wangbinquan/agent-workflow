// 记忆蒸馏超时：默认值 + 可配置 + 全链路接线。
//
// 用户 2026-09-21 报障：「记忆提炼任务默认 120s 超时太短了，改成 1 小时超时，
// 配置内可修改默认值」。此前 `DEFAULT_TIMEOUT_MS` 硬编码 120_000 且**没有任何调用方
// 传 timeoutMs**——配置面上根本没有这个键，超时即整批蒸馏失败并退避重试，已经烧掉的
// token 白花。
//
// 本文件锁三件事：
//   1. 默认值就是 1 小时（改回 120s 或任何别的数字，第一条即红）；
//   2. 显式 timeoutMs 能覆盖默认值；
//   3. 调度器把 timeoutMs 一路透到 spawn —— 这是 config 真正走的那条路径，
//      只锁 runDistill 的默认值会漏掉「键加了但没接上」。
//
// start.ts 两条部署路径的接线（含 SQLite 侧由引导期快照改为每 tick 重读）锁在
// tests/memory-distill-timeout-wiring.test.ts —— 那是源码层守卫，本文件是行为层。

import { beforeEach, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { tasks, workflows } from '../src/db/schema'
import { distillTick, enqueueDistillJob } from '../src/modules/memory/application/distill/schedule'
import {
  runDistill,
  type RunDistillOptions,
} from '../src/modules/memory/application/distill/memoryDistiller'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'
import { rowToDistillJob } from '../src/modules/memory/application/distill/memoryDistiller'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { DatabaseCommittedReviewArtifactReader } from '../src/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { DrizzleMemoryDistillRuntimeResolver } from '../src/modules/memory/infrastructure/memoryDistillRuntimeResolver'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'

/** 用户指定的新默认值：1 小时。 */
const ONE_HOUR_MS = 3_600_000

function createContext(db: ProviderNeutralDatabase) {
  const previousHome = process.env.AGENT_WORKFLOW_HOME
  const root = mkdtempSync(join(tmpdir(), 'memory-distill-timeout-'))
  process.env.AGENT_WORKFLOW_HOME = root
  return {
    store: new DrizzleMemoryDistillWorkStore(db),
    runtimeResolver: new DrizzleMemoryDistillRuntimeResolver(db),
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(db, root),
    cleanup() {
      if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    },
  }
}

type Context = ReturnType<typeof createContext>

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const wfId = ulid()
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/wt',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    baseCommit: null,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

/** Captures the timeout the distiller hands its runtime child, then returns an
 *  empty-but-valid envelope so the run completes normally.
 *
 *  RFC-367 changed the seam (`spawnFn` → `runFn`) AND the meaning of the number
 *  being captured: `timeoutMs` is now the budget for the WHOLE distill — the
 *  first round plus every protocol follow-up share it — so the first round sees
 *  the configured value minus however long the round-setup took. Assertions
 *  below are bounded rather than exact; an exact match would be flaky by
 *  construction. See RFC-367 design §3.2 for why the budget moved. */
function capturingRun(seen: number[]): RunDistillOptions['runFn'] {
  return async (opts) => {
    seen.push(opts.timeoutMs ?? -1)
    const envelopeNonce = /nonce="([^"]+)"/.exec(opts.prompt)?.[1] ?? ''
    return {
      status: 'ok',
      exitCode: 0,
      eventText: `<workflow-output nonce="${envelopeNonce}"><port name="candidates">{"candidates":[]}</port></workflow-output>`,
      stderrTail: '',
      durationMs: 1,
      scratchDir: join(opts.scratchParent, opts.scratchName ?? 'unnamed'),
      scratchRetained: true,
      outputEvidence: emptySystemAgentOutputEvidence(),
      capturedSessionId: 'ses_timeout_probe',
    }
  }
}

/** The budget the child actually got, within a generous setup allowance. */
function expectBudget(seen: number[], configured: number): void {
  expect(seen).toHaveLength(1)
  expect(seen[0]).toBeLessThanOrEqual(configured)
  expect(seen[0]).toBeGreaterThan(configured - 10_000)
}

describeEachProvider('memory distill timeout — default and override', (harness) => {
  let db: ProviderNeutralDatabase
  let ctx: Context
  beforeEach(() => {
    db = harness.db
    ctx = createContext(db)
    resetBroadcastersForTests()
  })
  afterEach(() => ctx.cleanup())

  function jobFor(taskId: string) {
    return rowToDistillJob({
      id: ulid(),
      debounceKey: `${taskId}:clarify`,
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      scopeResolvedJson: JSON.stringify({
        agentIds: [],
        workflowId: null,
        repoId: null,
        includeGlobal: true,
      }),
      status: 'running',
      attempts: 0,
      nextRunAt: 0,
      lastError: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    })
  }

  test('runDistill without an explicit timeout gives the child one hour', async () => {
    const taskId = await seedTask(db)
    const seen: number[] = []
    const job = jobFor(taskId)
    await runDistill({
      store: ctx.store,
      reviewedArtifacts: ctx.reviewedArtifacts,
      job,
      siblings: [job],
      runFn: capturingRun(seen),
    })
    expectBudget(seen, ONE_HOUR_MS)
  })

  test('an explicit timeout overrides the default', async () => {
    const taskId = await seedTask(db)
    const seen: number[] = []
    const job = jobFor(taskId)
    await runDistill({
      store: ctx.store,
      reviewedArtifacts: ctx.reviewedArtifacts,
      job,
      siblings: [job],
      runFn: capturingRun(seen),
      timeoutMs: 45_000,
    })
    expectBudget(seen, 45_000)
  })
})

describeEachProvider('memory distill timeout — scheduler plumbing', (harness) => {
  let db: ProviderNeutralDatabase
  let ctx: Context
  beforeEach(() => {
    db = harness.db
    ctx = createContext(db)
    resetBroadcastersForTests()
  })
  afterEach(() => ctx.cleanup())

  function deps() {
    return {
      store: ctx.store,
      reviewedArtifacts: ctx.reviewedArtifacts,
      runtimeResolver: ctx.runtimeResolver,
    }
  }

  test('distillTick forwards config.memoryDistillTimeoutMs to the child', async () => {
    const taskId = await seedTask(db)
    await enqueueDistillJob(ctx.store, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 0,
    })
    const seen: number[] = []
    const r = await distillTick({
      ...deps(),
      runFn: capturingRun(seen),
      timeoutMs: 7_200_000,
    })
    expect(r.succeeded).toBe(1)
    expectBudget(seen, 7_200_000)
  })

  test('distillTick without the knob falls through to the one-hour default', async () => {
    const taskId = await seedTask(db)
    await enqueueDistillJob(ctx.store, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 0,
    })
    const seen: number[] = []
    const r = await distillTick({ ...deps(), runFn: capturingRun(seen) })
    expect(r.succeeded).toBe(1)
    expectBudget(seen, ONE_HOUR_MS)
  })
})
