import { rimrafDir } from './helpers/cleanup'
// Regression: resuming a wrapper node from 'interrupted' (post daemon restart)
// throws ConflictError -> runTask rejects -> task stuck status='running'.
//
// DEFECT (HIGH): after a daemon restart, reapOrphanRuns sets the mid-execution
// wrapper node_run to 'interrupted'. On resume the scheduler treats it as
// dispatchable (isDispatchable(interrupted)===true, dispatchFrontier.ts:139),
// findResumableWrapperRun returns the non-terminal interrupted row
// (scheduler.ts:2062-2069 only filters done/failed/canceled/exhausted), then
// the wrapper enter-running call setNodeRunStatus({to:'running',
// allowedFrom:['pending','awaiting_review','awaiting_human']}) runs —
//   * wrapper-loop  -> scheduler.ts:2167-2173
//   * wrapper-fanout-> scheduler.ts:2342-2348
//   * wrapper-git   -> scheduler.ts:3036-3043
// 'interrupted' is NOT in allowedFrom, so lifecycle.ts:159 throws ConflictError.
// There is NO try/catch on the wrapper path, so runTask rejects and the task is
// left status='running' (set at scheduler.ts:262 with no top-level recovery).
//
// In production the caller is resumeTask -> runTask; calling runTask directly
// reproduces the exact throw (resumeTask just re-enters the same scope).
//
// RED until the wrapper resume paths add 'interrupted' to allowedFrom (or
// otherwise legalize interrupted -> running on resume). Once fixed, the wrapper
// resumes cleanly, the inner can complete, and the task reaches a terminal
// state instead of being wedged on 'running'.
//
// The headline assertion below is finalTask.status !== 'running'.

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

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-red-wrapresume-'))
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

// Simulate reapOrphanRuns (daemon restart): drop the wrapper's own node_run row
// in the non-terminal 'interrupted' state, exactly as the reaper leaves it.
async function seedInterruptedWrapperRun(
  h: Harness,
  taskId: string,
  wrapperNodeId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const wrapperRunId = ulid()
  const now = Date.now()
  await h.db.insert(nodeRuns).values({
    id: wrapperRunId,
    taskId,
    nodeId: wrapperNodeId,
    status: 'interrupted',
    retryIndex: 0,
    iteration: 0,
    parentNodeRunId: null,
    shardKey: null,
    startedAt: now,
    finishedAt: now,
    ...extra,
  })
  return wrapperRunId
}

describe('wrapper resume from interrupted must not throw / wedge task on running (daemon-restart regression)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  test('wrapper-loop: resume of interrupted row reaches terminal status, not stuck running', async () => {
    await seedAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [],
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
    }
    const taskId = await seedWorkflowAndTask(h, def)
    await seedInterruptedWrapperRun(h, taskId, 'loop')

    let threw = false
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: '' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    ).catch(() => {
      threw = true
    })

    const finalTask = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(finalTask?.status).not.toBe('running')
    expect(threw).toBe(false)
  })

  test('wrapper-git: resume of interrupted row reaches terminal status, not stuck running', async () => {
    await seedAgent(h.db, 'writer', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [],
      nodes: [
        { id: 'wrap', kind: 'wrapper-git', nodeIds: ['wA'] },
        { id: 'wA', kind: 'agent-single', agentName: 'writer' },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const taskId = await seedWorkflowAndTask(h, def)
    await seedInterruptedWrapperRun(h, taskId, 'wrap')

    let threw = false
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    ).catch(() => {
      threw = true
    })

    const finalTask = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(finalTask?.status).not.toBe('running')
    expect(threw).toBe(false)
  })

  test('wrapper-fanout: resume of interrupted row reaches terminal status, not stuck running', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        {
          id: 'inner',
          kind: 'agent-single',
          agentName: 'worker',
          promptTemplate: 'Process {{doc}}',
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'inp', portName: 'docs' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
        {
          id: 'eB',
          source: { nodeId: 'fan', portName: 'docs' },
          target: { nodeId: 'inner', portName: 'doc' },
          boundary: 'wrapper-input',
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { docs: 'a.md\nb.md' })
    await seedInterruptedWrapperRun(h, taskId, 'fan')

    let threw = false
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'done' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    ).catch(() => {
      threw = true
    })

    const finalTask = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(finalTask?.status).not.toBe('running')
    expect(threw).toBe(false)
  })
})
