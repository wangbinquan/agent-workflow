// RFC-167 T13 — generate→confirm→execute END TO END over the real engine
// stack (real runTask dispatch, real iso worktrees on a scratch git repo, real
// runNode spawning the mock-opencode fixture — no real LLM/opencode). Locks:
//
//   1. full chain: dynamic launch (scratch) → GENERATE pass (orchestrator run
//      emits the workflow JSON via the standard envelope; its iso delta is
//      discarded) → parked awaiting_review with dw.phase='awaiting_confirm' +
//      dw-gate holder → approve core (holder close + atomic swap via
//      resumeDynamicWorkflowExecution) → runScope executes the CONFIRMED DAG
//      (real node run, envelope port captured) → task done.
//   2. daemon-restart recovery in the executing phase: an interrupted
//      dynamic task is picked up by boot auto-resume (RFC-167 carve-out) and
//      runScope re-runs the swapped DAG to done — the recovery path Codex
//      impl-gate P1-3 unlocked, exercised end to end.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  DAEMON_RESTART_ERROR_SUMMARY,
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  initialDwState,
  WorkflowDefinitionSchema,
  type DwState,
} from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { nodeRuns, tasks, workflows, workgroupTaskState } from '../src/db/schema'
import { loadWorkgroupTaskState } from '../src/services/workgroup/state'
import { createAgent } from '../src/services/agent'
import { autoResumeInterruptedTasks } from '../src/services/autoResume'
import { DW_GATE_CAUSE, DW_GENERATE_CAUSE } from '../src/services/dynamicWorkflowRunner'
import { setNodeRunStatus } from '../src/services/lifecycle'
import { DW_ORCHESTRATOR_NODE_ID } from '../src/services/orchestratorAgent'
import {
  abortAllActiveTasks,
  resumeDynamicWorkflowExecution,
  resumeTask,
} from '../src/services/task'
import { createWorkgroup } from '../src/services/workgroups'
import { startWorkgroupTask } from '../src/services/workgroup/launch'
import { runTestGit } from './helpers/testCommand'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const OPENCODE_CMD = ['bun', 'run', MOCK_OPENCODE]
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 20_000

afterEach(() => abortAllActiveTasks('test-cleanup'))

function git(...args: string[]): Promise<string> {
  return runTestGit(args, GIT_TIMEOUT_MS)
}

async function withActiveTaskDeadline<T>(operation: () => Promise<T>): Promise<T> {
  const watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
  try {
    return await operation()
  } finally {
    clearTimeout(watchdog)
  }
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

async function seedPlannerAgent(db: DbClient): Promise<string> {
  const agent = await createAgent(db, {
    name: 'wg-planner',
    description: 'plans things',
    outputs: ['plan'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'plan the work',
  })
  return agent.id
}

// RFC-223 (PR-3b): the orchestrator emits opaque member tokens; the sole pool
// member (wg-planner) is member#1. The single conversion point stamps its frozen
// agentId into the generated def.
const GENERATED = {
  nodes: [{ id: 'plan-step', agentToken: 'member#1', promptTemplate: '拆解目标', inputs: [] }],
  edges: [],
}

describe('RFC-167 T13 — dynamic workflow end to end (mock opencode)', () => {
  test('generate → confirm → execute: one task crosses all three phases to done', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc167-e2e-'))
    const db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    try {
      const plannerId = await seedPlannerAgent(db)
      const group = await createWorkgroup(db, {
        name: 'dyn-e2e',
        description: '',
        instructions: '章程：小步快跑',
        mode: 'dynamic_workflow',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 5,
        completionGate: false,
        members: [
          { memberType: 'agent', agentId: plannerId, displayName: 'planner', roleDesc: '' },
        ],
      })
      const actor = buildActor({
        user: { id: 'u-e2e', username: 'e2e', displayName: 'e2e', role: 'admin', status: 'active' },
        source: 'daemon',
      })

      // ── phase 1: GENERATE — the orchestrator (mock) emits the workflow JSON.
      const task = await withActiveTaskDeadline(() =>
        withEnv(
          {
            MOCK_OPENCODE_OUTPUTS: JSON.stringify({ workflow: JSON.stringify(GENERATED) }),
          },
          () =>
            startWorkgroupTask(
              db,
              actor,
              group.id,
              { name: 'e2e', goal: '把回调竞态修掉', scratch: true },
              {
                db,
                appHome,
                opencodeCmd: OPENCODE_CMD,
                awaitScheduler: true,
                defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
                defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
              },
            ),
        ),
      )

      const afterGen = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(afterGen?.status).toBe('awaiting_review')
      // RFC-217 T2 — the dw checkpoint rides workgroup_task_state now.
      const stateGen = await loadWorkgroupTaskState(db, task.id)
      const dwGen = stateGen.dwState
      expect(dwGen?.phase).toBe('awaiting_confirm')
      const generatedDef = WorkflowDefinitionSchema.parse(dwGen?.generatedDef)
      expect(generatedDef.nodes.map((n) => n.id)).toEqual(['plan-step'])
      const runsGen = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
      const orchRun = runsGen.find((r) => r.rerunCause === DW_GENERATE_CAUSE)
      expect(orchRun?.status).toBe('done')
      // the generation run's iso delta is discarded, never merged (Codex P1)
      expect(orchRun?.mergeState).toBe('abandoned')
      const holder = runsGen.find((r) => r.rerunCause === DW_GATE_CAUSE)
      expect(holder?.status).toBe('awaiting_review')

      // ── phase 2: CONFIRM — approve core (route-tested elsewhere): close the
      // holder, swap the confirmed DAG + phase atomically, resume.
      await setNodeRunStatus({
        db,
        nodeRunId: holder!.id,
        to: 'done',
        allowedFrom: ['awaiting_review'],
        reason: 'dw-gate-approved',
      })
      const { rejectionComment: _c, ...dwRest } = dwGen as DwState
      const nextDw: DwState = { ...dwRest, phase: 'executing' }

      // ── phase 3: EXECUTE — runScope runs the confirmed DAG with the mock.
      await withActiveTaskDeadline(() =>
        withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ plan: '拆解完毕：三步走' }) }, () =>
          resumeDynamicWorkflowExecution(
            db,
            task.id,
            {
              db,
              appHome,
              opencodeCmd: OPENCODE_CMD,
              awaitScheduler: true,
              defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
              defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
            },
            {
              workflowSnapshot: JSON.stringify(generatedDef),
              dw: nextDw,
            },
          ),
        ),
      )

      const final = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(final?.status).toBe('done')
      expect(JSON.parse(final?.workflowSnapshot ?? '{}')).toEqual(generatedDef)
      const finalDw = (await loadWorkgroupTaskState(db, task.id)).dwState
      expect(finalDw?.phase).toBe('executing')
      const planRuns = await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, 'plan-step')))
      expect(planRuns.some((r) => r.status === 'done')).toBe(true)
      // the generation host node never ran again after the swap
      const orchRuns = runsGen.filter((r) => r.nodeId === DW_ORCHESTRATOR_NODE_ID)
      const orchRunsAfter = (
        await db
          .select()
          .from(nodeRuns)
          .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, DW_ORCHESTRATOR_NODE_ID)))
      ).length
      expect(orchRunsAfter).toBe(orchRuns.length)
    } finally {
      db.$client.close()
      rmSync(appHome, { recursive: true, force: true })
    }
  }, 30000)

  test('daemon-restart recovery: an interrupted EXECUTING dynamic task auto-resumes through runScope to done', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc167-e2e-rec-'))
    const repo = mkdtempSync(join(tmpdir(), 'aw-rfc167-e2e-repo-'))
    const db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    try {
      const plannerId = await seedPlannerAgent(db)
      await git('-C', repo, 'init', '-b', 'main', '-q')
      await git(
        '-C',
        repo,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--no-verify',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      )
      const def = {
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'plan-step',
            kind: 'agent-single',
            agentId: plannerId,
            agentName: 'wg-planner',
            promptTemplate: 'x',
          },
        ],
        edges: [],
      }
      const taskId = ulid()
      await db.insert(workflows).values({
        id: 'wf-anchor',
        name: 'anchor',
        definition: '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
        builtin: true,
      })
      await db.insert(tasks).values({
        id: taskId,
        name: 'rec',
        workflowId: 'wf-anchor',
        workflowSnapshot: JSON.stringify(def),
        repoPath: repo,
        worktreePath: repo,
        baseBranch: 'main',
        branch: `agent-workflow/${taskId}`,
        status: 'interrupted',
        errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
        inputs: '{}',
        startedAt: Date.now(),
        workgroupId: 'wg-rec',
        workgroupConfigJson: JSON.stringify({
          workgroupId: 'wg-rec',
          workgroupName: 'rec',
          mode: 'dynamic_workflow',
          leaderMemberId: null,
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          maxRounds: 5,
          completionGate: false,
          instructions: '',
          goal: 'g',
          members: [
            {
              id: 'm1',
              memberType: 'agent',
              agentId: plannerId,
              agentName: 'wg-planner',
              userId: null,
              displayName: 'planner',
              roleDesc: '',
            },
          ],
        }),
      })
      // RFC-217 T2 — the dispatch oracle reads the phase from
      // workgroup_task_state; the fixture seeds it like startTaskImpl would.
      await db.insert(workgroupTaskState).values({
        taskId,
        gateStatus: 'idle',
        dwStateJson: JSON.stringify({ ...initialDwState(), phase: 'executing' }),
        updatedAt: Date.now(),
      })

      const res = await withActiveTaskDeadline(() =>
        withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ plan: '恢复后完成' }) }, () =>
          autoResumeInterruptedTasks({
            db,
            breaker: { maxPerWindow: 3, windowMs: 3600_000 },
            resume: (id) =>
              resumeTask(db, id, {
                db,
                appHome,
                opencodeCmd: OPENCODE_CMD,
                awaitScheduler: true,
                defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
                defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
              }).then(() => undefined),
          }),
        ),
      )
      expect(res.resumed).toEqual([taskId])
      const final = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
      expect(final?.status).toBe('done')
      const planRuns = await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'plan-step')))
      expect(planRuns.some((r) => r.status === 'done')).toBe(true)
    } finally {
      db.$client.close()
      rmSync(appHome, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  }, 30000)
})
