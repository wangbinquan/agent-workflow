import { rimrafDir } from './helpers/cleanup'
// Locked regression: an exhausted wrapper-loop silently flips failed->done on resume.
//
// DEFECT (HIGH): a wrapper-loop that reaches maxIterations without satisfying
// its exit condition marks its node_run row 'exhausted' (terminal) and the
// wrapper runner returns kind:'failed' (scheduler.ts:2257-2264), so the FIRST
// runTask correctly fails the task. But on a SECOND runTask (resume):
//   - deriveFrontier treats an 'exhausted' latest row as COMPLETED
//     (scheduler.ts:1029-1033), and
//   - findResumableWrapperRun returns null for the terminal 'exhausted' row
//     (scheduler.ts:2042-2083), so it is never re-dispatched.
// With nothing re-dispatched and no fresh failure recorded, runScope sees
// f.allSettled === true with firstFailureDetail === undefined and returns
// { kind: 'ok' } (scheduler.ts:609-631), so the top-level handler flips the
// task to 'done' (scheduler.ts:388-391). resumeTask never re-validates this
// (task.ts:963-1048). Net effect: a workflow that genuinely exhausted its loop
// reports SUCCESS the second time it is run, with empty downstream data.
//
// RED until the scheduler stops reporting an exhausted top-level wrapper-loop
// as a completed/ok node on resume (i.e. the task must stay failed/exhausted).
//
// describe() title makes the locked regression obvious.
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { reenterScheduler } from './reenter-scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-red-loopexhaust-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rimrafDir(appHome),
  }
}
async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify(extra),
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}
async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<string> {
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
    inputs: JSON.stringify(inputs),
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

let h: Harness
beforeEach(() => {
  h = buildHarness()
})
afterEach(() => {
  h.cleanup()
})

describe('scheduler: an exhausted top-level wrapper-loop must NOT flip failed->done on resume', () => {
  test('exhausted loop stays failed on second runTask (resume sim)', async () => {
    await seedAgent(h.db, 'auditor', ['findings'])

    const definition: WorkflowDefinition = {
      $schema_version: 1,
      nodes: [
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'audit', portName: 'findings' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'audit', portName: 'findings' } }],
        },
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    } as unknown as WorkflowDefinition

    const taskId = await seedWorkflowAndTask(h, definition)

    const opencodeCmd = ['bun', 'run', MOCK_OPENCODE]
    const env = { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: 'still failing' }) }

    // Run #1 — the loop never satisfies port-empty (findings always non-empty),
    // so it exhausts maxIterations. This documents the correct starting state.
    await withEnv(env, () => runTask({ taskId, db: h.db, appHome: h.appHome, opencodeCmd }))

    const afterRun1 = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(afterRun1.status).toBe('failed')

    const loopRowAfterRun1 = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'loop'))
    )[0]!
    expect(loopRowAfterRun1.status).toBe('exhausted')

    // Run #2 — simulate a resume by re-entering runTask against the SAME db/task.
    // RFC-097: runTask's entry CAS only claims pending tasks, so reset to
    // pending first (the resumeTask equivalent) — otherwise run #2 silently
    // no-ops and the headline assertion below would be hollow-green. The run
    // must NOT end in 'done'.
    await reenterScheduler(h.db, taskId)
    await withEnv(env, () => runTask({ taskId, db: h.db, appHome: h.appHome, opencodeCmd }))

    const afterRun2 = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!

    // HEADLINE RED ASSERTION: a workflow that exhausted its loop must not report
    // success on resume. Today the exhausted wrapper row is treated as completed
    // -> allSettled -> task flips to 'done' -> this FAILS (and is the bug).
    expect(afterRun2.status).not.toBe('done')
  }, 120_000)
})
