// RFC-023 bug 13 — scheduler rescan + no-fail-fast aggregation.
//
// Locks two related behaviours that fix the "answer clarify while task is
// running → orphaned pending rerun row" bug:
//
//   1. After every Promise.all batch, runScope rescans node_runs for the
//      task. If a pending row appeared with a higher (retryIndex,
//      clarifyIteration) than the cached latest, the node is pulled back
//      into `remaining` so the next loop iteration dispatches it.
//
//   2. runScope no longer short-circuits on `failed` while sibling branch
//      results are still being aggregated. Priority order is
//      canceled > awaiting_human > awaiting_review > failed > ok — so a
//      wrapper-loop sibling exhausting its budget never silently swallows
//      a parallel branch's awaiting_human signal.
//
// We exercise the first behaviour via a stub agent that pauses long enough
// for us to inject a fresh pending row, then completes; the scheduler's
// next batch must dispatch the injected row.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
const ulid = monotonicFactory() // RFC-074 PR-C: monotonic ids for synchronous test seeding (pure-id freshness)
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'
import { canonicalizeWorkflowAgentIds } from './helpers/canonicalWorkflowFixture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-sched-midbatch-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  await runGit(repoPath, ['init', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-m', 'init'])
  await runGit(worktreePath, ['init', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'r.md'), '# r\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    repoPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<{ taskId: string }> {
  const canonicalDefinition = await canonicalizeWorkflowAgentIds(h.db, definition)
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(canonicalDefinition),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(canonicalDefinition),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
    startedAt: Date.now(),
  })
  return { taskId }
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

describe('runScope — mid-batch rescan + no-fail-fast (RFC-023 bug 13)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('rescan picks up a pending row minted between the first agent batch and the scheduler stall check', async () => {
    // Single-agent scope: input → agent. The agent runs once and is done.
    // Mid-execution we have NO good API hook in the running test, so we
    // simulate the "user answers clarify while task is running" race by
    // pre-seeding two rows for the agent: the original `done` row (as if
    // the first attempt finished), plus a fresh `pending` row with
    // clarifyIteration=1 (as if the answer arrived during the running
    // scope). With the fix, the rescan should observe the pending row,
    // pull the node back into remaining, and dispatch it on the next
    // batch — without the rescan, the scope would have already moved on
    // and the pending row would sit orphaned.
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'd', portName: 'req' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'first' })

    // Pre-seed: the agent's first run "completed" with empty output (as
    // if a previous scheduler invocation finished + paused). The
    // rerun-equivalent row sits pending with clarifyIteration=1.
    const firstRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: firstRunId,
      taskId,
      nodeId: 'd',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 1000,
    })
    const rerunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: rerunId,
      taskId,
      nodeId: 'd',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      startedAt: null,
      // RFC-098 WP-10: synthesized as the clarify-answer rerun the unified
      // dispatch mints — incl. the rerun_cause column the scheduler's gate-2
      // now reads.
      rerunCause: 'clarify-answer',
    })

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'ok-after-clarify' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // The rerun row must have been dispatched and completed.
    const rerunRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunId)))[0]
    expect(rerunRow?.status).toBe('done')
    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(taskRow?.status).toBe('done')
  })

  test('aggregation priority: parallel awaiting_human + failed sibling → scope returns awaiting_human (not failed)', async () => {
    // Two top-level agents in parallel. One emits clarify (awaiting_human),
    // the other fails (no output envelope). Pre-fix the for-loop saw
    // failed first and short-circuited; awaiting_human was lost and the
    // task ended up `failed`. Post-fix awaiting_human outranks failed and
    // the task pauses awaiting human input — letting the user answer the
    // clarify and resume.
    await seedAgent(h.db, 'asker', ['design'])
    await seedAgent(h.db, 'crasher', ['out'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'a', kind: 'agent-single', agentName: 'asker' } as WorkflowNode,
        { id: 'c1', kind: 'clarify', title: 'Q' } as WorkflowNode,
        { id: 'b', kind: 'agent-single', agentName: 'crasher' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in_a',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'a', portName: 'req' },
        },
        {
          id: 'e_in_b',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'b', portName: 'req' },
        },
        {
          id: 'e_ask',
          source: { nodeId: 'a', portName: '__clarify__' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
        {
          id: 'e_ans',
          source: { nodeId: 'c1', portName: 'answers' },
          target: { nodeId: 'a', portName: '__clarify_response__' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    // The mock emits a clarify envelope for any agent when MOCK_OPENCODE_CLARIFY_BODY
    // is set, and emits no envelope (causing failure) when MOCK_OPENCODE_CRASH=1.
    // We need different behaviour per agent; use mock-opencode's
    // MOCK_OPENCODE_PER_AGENT split (agent-name → behaviour).
    const askerBody = JSON.stringify({
      questions: [
        {
          id: 'qx',
          title: 'pick',
          kind: 'single',
          options: [
            { label: 'A', description: '', recommended: false, recommendationReason: '' },
            { label: 'B', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
    })
    await withEnv(
      {
        MOCK_OPENCODE_CLARIFY_BODY_FOR_asker: askerBody,
        MOCK_OPENCODE_CRASH_FOR_crasher: '1',
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    // Both sibling branches finished. asker → awaiting_human; crasher → failed.
    // The aggregation contract: awaiting_human outranks failed.
    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(taskRow?.status).toBe('awaiting_human')

    // Verify each branch ran.
    const askerRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'a')))
    expect(askerRuns.length).toBeGreaterThan(0)
    const crasherRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'b')))
    expect(crasherRuns.length).toBeGreaterThan(0)
    expect(crasherRuns.find((r) => r.status === 'failed')).toBeDefined()
  })
})
