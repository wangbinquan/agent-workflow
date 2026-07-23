// REGRESSION — design/scheduler-audit-2026-06-10.md §⑥ 缺口4 + 附录C-4 (WP-6a)
//
// loop 的 exitCondition 是隐式依赖，不应绕过包装器作用域：
//
//   1. validator 拒绝引用 loop 体外节点，阻止新任务启动；
//   2. runTask 仍对直接播种的旧/非法快照 fail-safe：先等待隐式来源完成，再按
//      last-value 读取 iteration <= 当前轮的最新 done 行。这样旧快照不会在第
//      2 轮把外层 iteration=0 的真实值误读成空串并静默绿掉。

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
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

// exitCondition references 'lister' which lives OUTSIDE the loop body. The
// validator rejects this definition; the runtime case bypasses the launch
// gate deliberately to lock old-snapshot fail-safe behavior.
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
    expect(res.issues.map((issue) => issue.code)).toEqual(['wrapper-loop-exit-node-out-of-scope'])
  })

  test('an old invalid snapshot keeps the latest outer value instead of false-exiting', async () => {
    await seedAgent(h.db, 'lister', ['findings'])
    await seedAgent(h.db, 'worker', ['out'])
    const taskId = await seedWorkflowAndTask(h, buildDefinition())

    await withEnv({ SCENARIO_PLAN_FILE: h.planFile, SCENARIO_STATE_DIR: h.stateDir }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
      }),
    )

    // Sanity: the referenced out-of-loop port really held 5 lines (count=5,
    // so 5 < 3 should NEVER be true under last-value semantics).
    const listerRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'lister')))
    expect(listerRuns.length).toBe(1)
    expect(listerRuns[0]?.iteration).toBe(0)
    const listerOut = (
      await h.db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(
            eq(nodeRunOutputs.nodeRunId, listerRuns[0]!.id),
            eq(nodeRunOutputs.portName, 'findings'),
          ),
        )
    )[0]
    expect(listerOut?.content).toBe(FINDINGS)

    // Every loop round sees lister@0 as the latest visible value, so 5 < 3
    // stays false. The invalid snapshot fails closed after maxIterations.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(`${t?.status}:${t?.errorSummary ?? ''}`).toBe(
      'failed:wrapper-loop loop exhausted after 4 iterations',
    )

    const loopRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'loop')))
    )[0]
    expect(loopRun?.status).toBe('exhausted')

    const workerRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'worker')))
    expect(workerRuns.map((r) => r.iteration).sort()).toEqual([0, 1, 2, 3])
  })
})
