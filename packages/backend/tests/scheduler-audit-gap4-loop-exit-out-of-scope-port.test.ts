// REGRESSION — design/scheduler-audit-2026-06-10.md §⑥ 缺口4 + 附录C-4 (WP-6a)
//
// loop 的 exitCondition 不应绕过包装器作用域。RFC-354 schema v6 起 exitCondition
// 只能指向 loop 自己的返回口，v5 里「exit 读体外节点」升级后变成一条 source 在
// 体外的 `wrapper-output` 返回边：
//
//   1. validator 以 `wrapper-loop-output-binding-out-of-scope` 拒绝，阻止新任务启动；
//   2. runTask 对直接播种的旧/非法快照 fail-closed：loop 在 prepare 阶段就以
//      `wrapper-loop-return-source-out-of-scope` 失败，不会去读一个 body 从未算出
//      的值——否则第 1 轮读到空串、`port-count-lt` 为真，静默绿掉（v5 时代的
//      同一缺口，当年靠「先等隐式来源完成再按 last-value 读」兜底）。

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'
import { validateWorkflowDef } from '../src/services/workflow.validator'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_OPENCODE = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

// Five findings lines — count=5 with the default '\n' separator. Under
// "read the latest value" semantics 5 < 3 is false on EVERY iteration.
const FINDINGS = 'f1\nf2\nf3\nf4\nf5'

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

function agentId(name: string): string {
  return `agent-${name}`
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-gap4-loop-exit-'))
  const worktreePath = join(appHome, 'wt')
  const stateDir = join(appHome, 'scenario-state')
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const planFile = join(appHome, 'plan.json')
  writeFileSync(
    planFile,
    JSON.stringify({
      lister: [{ output: { findings: FINDINGS } }],
      worker: [{ output: { out: 'iter-result' } }],
    }),
  )
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    stateDir,
    planFile,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: agentId(name),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

// exitCondition references 'lister' which lives OUTSIDE the loop body (v5
// shape; the upgrader turns it into a `wrapper-output` edge lister.findings →
// loop.findings). The validator rejects this definition; the runtime case
// bypasses the launch gate deliberately to lock old-snapshot fail-closed
// behavior.
function buildDefinition(): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    nodes: [
      {
        id: 'lister',
        kind: 'agent-single',
        agentId: agentId('lister'),
        agentName: 'lister',
      },
      {
        id: 'worker',
        kind: 'agent-single',
        agentId: agentId('worker'),
        agentName: 'worker',
      },
      {
        id: 'loop',
        kind: 'wrapper-loop',
        nodeIds: ['worker'],
        maxIterations: 4,
        exitCondition: { kind: 'port-count-lt', nodeId: 'lister', portName: 'findings', n: 3 },
        outputBindings: [{ name: 'final', bind: { nodeId: 'worker', portName: 'out' } }],
      },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [],
  }
}

async function seedWorkflowAndTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

describe('gap4 — wrapper-loop exitCondition referencing an out-of-loop node', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('validator rejects an exitCondition source outside the direct loop body', () => {
    const mkAgent = (name: string, outputs: string[]): Agent => ({
      id: `agent-${name}`,
      name,
      description: '',
      outputs,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    const res = validateWorkflowDef(buildDefinition(), {
      agents: [mkAgent('lister', ['findings']), mkAgent('worker', ['out'])],
      skills: [],
    })
    expect(res.ok).toBe(false)
    expect(res.issues.map((issue) => issue.code)).toEqual([
      'wrapper-loop-output-binding-out-of-scope',
    ])
  })

  // 15s is a WALL-CLOCK allowance, not tolerance for this test getting slower
  // (`gate:local` runs four shards in parallel; see docs/dev-gotchas.md on the
  // 5000ms family).
  test('an old invalid snapshot fails closed instead of false-exiting on an unread value', async () => {
    await seedAgent(h.db, 'lister', ['findings'])
    await seedAgent(h.db, 'worker', ['out'])
    const taskId = await seedWorkflowAndTask(h, buildDefinition())

    await withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        binaryOverride: ['bun', 'run', SCENARIO_OPENCODE],
      }),
    )

    // The loop never gets to read `lister.findings` as if it were its own
    // return value: it is rejected before its first round, and the task fails.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorMessage).toContain('wrapper-loop-return-source-out-of-scope')

    // No body round ran on the strength of a value the body never produced.
    const workerRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'worker')))
    expect(workerRuns).toHaveLength(0)
  }, 15_000)
})
