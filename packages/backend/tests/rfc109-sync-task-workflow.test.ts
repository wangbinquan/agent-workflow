import { rimrafDir } from './helpers/cleanup'
// RFC-109 — syncTaskWorkflow: pull the latest workflow definition into a task's
// frozen snapshot and continue from the breakpoint. Locks the service contract:
//   - atomic snapshot + version swap inside the ownership CAS (AC-1)
//   - all six non-active statuses sync; running/pending reject (AC-3)
//   - workflow deleted / version TOCTOU / invalid / same-def noop / worktree
//     missing / concurrent each map to their error code (AC-8/9, Codex F5/F7)
//   - new node added to a done task is dispatched after sync (AC-2)
//   - selectSyncRollbackTargets adds canceled write nodes but spares wrappers (F4)

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  syncTaskWorkflow,
  selectSyncRollbackTargets,
  buildSyncRunSummary,
} from '../src/services/task'
import type { nodeRuns as nodeRunsTable } from '../src/db/schema'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type TaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_review'
  | 'awaiting_human'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted'

function defWith(
  nodes: WorkflowNode[],
  edges: WorkflowDefinition['edges'] = [],
): WorkflowDefinition {
  // input nodes must have their inputKey declared in workflow.inputs[]
  // (validator rule input-key-not-declared) — auto-derive so test defs stay valid.
  const inputs = nodes
    .filter((n) => n.kind === 'input')
    .map((n) => {
      const key = (n as unknown as { inputKey: string }).inputKey
      return { kind: 'text', key, label: key }
    })
  return { $schema_version: 4, inputs, nodes, edges } as unknown as WorkflowDefinition
}
function inputNode(id: string, inputKey: string = id): WorkflowNode {
  // input nodes dispatch via `inputKey` (scheduler.ts) — a node_run is minted
  // only when the key is present, so the AC-2 "new node dispatched" assertion
  // needs a real inputKey.
  return { id, kind: 'input', inputKey } as unknown as WorkflowNode
}

const DEF_A = defWith([inputNode('a')])

interface Harness {
  db: DbClient
  appHome: string
  workflowId: string
  taskId: string
  cleanup: () => void
}

async function buildHarness(
  status: TaskStatus,
  snapshot: WorkflowDefinition = DEF_A,
): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc109-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])

  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify(DEF_A),
    version: 1,
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(snapshot),
    workflowVersion: 1,
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status,
    inputs: '{}',
    startedAt: Date.now(),
    finishedAt: status === 'done' || status === 'failed' ? Date.now() : null,
  })
  return {
    db,
    appHome,
    workflowId,
    taskId,
    cleanup: () => rimrafDir(tmp),
  }
}

/** Bump the live workflow to a new definition + version (mirrors a PUT). */
async function bumpWorkflow(
  db: DbClient,
  workflowId: string,
  definition: WorkflowDefinition,
  version: number,
): Promise<void> {
  await db
    .update(workflows)
    .set({ definition: JSON.stringify(definition), version })
    .where(eq(workflows.id, workflowId))
}

function syncDeps(h: Harness, expectedVersion: number) {
  return { db: h.db, appHome: h.appHome, opencodeCmd: ['/usr/bin/env', 'true'], expectedVersion }
}
async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

describe('RFC-109 syncTaskWorkflow — swap + continue', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('AC-1: failed task — swaps snapshot + version atomically, flips pending', async () => {
    h = await buildHarness('failed')
    const DEF_B = defWith([inputNode('a'), inputNode('b')])
    await bumpWorkflow(h.db, h.workflowId, DEF_B, 2)

    const after = await syncTaskWorkflow(h.db, h.taskId, syncDeps(h, 2))
    expect(after.status).toBe('pending')
    expect(after.workflowVersion).toBe(2)
    const row = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    expect(JSON.parse(row.workflowSnapshot)).toEqual(DEF_B as unknown as Record<string, unknown>)
    expect(row.workflowVersion).toBe(2)
  })

  test('AC-3: each non-active status syncs (done/canceled/awaiting_review/awaiting_human/interrupted)', async () => {
    for (const status of [
      'done',
      'canceled',
      'awaiting_review',
      'awaiting_human',
      'interrupted',
    ] as const) {
      const hh = await buildHarness(status)
      try {
        await bumpWorkflow(hh.db, hh.workflowId, defWith([inputNode('a'), inputNode('c')]), 2)
        const after = await syncTaskWorkflow(hh.db, hh.taskId, syncDeps(hh, 2))
        expect(after.status).toBe('pending')
      } finally {
        hh.cleanup()
      }
    }
  })

  test('AC-3: running and pending reject with task-not-syncable (scheduler holds the lock)', async () => {
    for (const status of ['running', 'pending'] as const) {
      const hh = await buildHarness(status)
      try {
        await bumpWorkflow(hh.db, hh.workflowId, defWith([inputNode('a'), inputNode('c')]), 2)
        expect(await codeOf(() => syncTaskWorkflow(hh.db, hh.taskId, syncDeps(hh, 2)))).toBe(
          'task-not-syncable',
        )
      } finally {
        hh.cleanup()
      }
    }
  })

  test('AC-8: workflow deleted → workflow-deleted (defensive; FK normally prevents this)', async () => {
    h = await buildHarness('failed')
    // The tasks.workflowId FK (RESTRICT) blocks deleting a referenced workflow
    // in production, so this guard is defensive — exercise it by dropping FK
    // enforcement for the test to confirm a missing workflow yields a clean 409.
    h.db.run(sql`PRAGMA foreign_keys = OFF`)
    await h.db.delete(workflows).where(eq(workflows.id, h.workflowId))
    expect(await codeOf(() => syncTaskWorkflow(h.db, h.taskId, syncDeps(h, 1)))).toBe(
      'workflow-deleted',
    )
  })

  test('F5: expectedVersion stale → workflow-sync-preview-stale (no swap)', async () => {
    h = await buildHarness('failed')
    await bumpWorkflow(h.db, h.workflowId, defWith([inputNode('a'), inputNode('b')]), 2)
    expect(await codeOf(() => syncTaskWorkflow(h.db, h.taskId, syncDeps(h, 1)))).toBe(
      'workflow-sync-preview-stale',
    )
    const row = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    expect(row.workflowVersion).toBe(1) // unchanged
    expect(row.status).toBe('failed')
  })

  test('F7: same definition (version bumped, content identical) → workflow-sync-noop, no status churn', async () => {
    h = await buildHarness('done')
    await bumpWorkflow(h.db, h.workflowId, DEF_A, 2) // identical content, new version
    expect(await codeOf(() => syncTaskWorkflow(h.db, h.taskId, syncDeps(h, 2)))).toBe(
      'workflow-sync-noop',
    )
    const row = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    expect(row.status).toBe('done') // not churned
  })

  test('AC-8: invalid latest definition → workflow-invalid', async () => {
    h = await buildHarness('failed')
    const INVALID = defWith(
      [inputNode('a')],
      [
        {
          id: 'e',
          source: { nodeId: 'ghost', portName: 'p' },
          target: { nodeId: 'a', portName: 'q' },
        },
      ],
    )
    await bumpWorkflow(h.db, h.workflowId, INVALID, 2)
    expect(await codeOf(() => syncTaskWorkflow(h.db, h.taskId, syncDeps(h, 2)))).toBe(
      'workflow-invalid',
    )
  })

  test('AC-10: worktree missing → worktree-missing', async () => {
    h = await buildHarness('failed')
    await h.db.update(tasks).set({ worktreePath: '' }).where(eq(tasks.id, h.taskId))
    await bumpWorkflow(h.db, h.workflowId, defWith([inputNode('a'), inputNode('b')]), 2)
    expect(await codeOf(() => syncTaskWorkflow(h.db, h.taskId, syncDeps(h, 2)))).toBe(
      'worktree-missing',
    )
  })

  test('AC-9: concurrent sync — second loses with task-not-syncable, no double swap', async () => {
    h = await buildHarness('failed')
    await bumpWorkflow(h.db, h.workflowId, defWith([inputNode('a'), inputNode('b')]), 2)
    await syncTaskWorkflow(h.db, h.taskId, syncDeps(h, 2)) // first wins → pending
    expect(await codeOf(() => syncTaskWorkflow(h.db, h.taskId, syncDeps(h, 2)))).toBe(
      'task-not-syncable',
    )
  })

  test('task-not-found on unknown task', async () => {
    h = await buildHarness('failed')
    expect(await codeOf(() => syncTaskWorkflow(h.db, 'nope', syncDeps(h, 1)))).toBe(
      'task-not-found',
    )
  })

  test('AC-2: a node added to a done task is dispatched after sync', async () => {
    h = await buildHarness('done')
    // seed the original node as a completed run
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId: h.taskId,
      nodeId: 'a',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
    })
    const DEF_B = defWith([inputNode('a'), inputNode('b')])
    await bumpWorkflow(h.db, h.workflowId, DEF_B, 2)

    await syncTaskWorkflow(h.db, h.taskId, { ...syncDeps(h, 2), awaitScheduler: true })
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, h.taskId))
    // the new node 'b' got a run (the scheduler picked it up from the new graph)
    expect(runs.some((r) => r.nodeId === 'b')).toBe(true)
  })
})

describe('RFC-109 selectSyncRollbackTargets (Codex F4)', () => {
  const row = (id: string, nodeId: string, status: string, parent: string | null = null) => ({
    id,
    nodeId,
    parentNodeRunId: parent,
    status,
  })

  test('adds canceled write nodes but spares wrapper-canceled revival rows', () => {
    const isWrapper = (n: string) => n === 'wrap'
    const runs = [
      row('01A', 'writer', 'canceled'), // write node → rolled back
      row('01B', 'wrap', 'canceled'), // wrapper revival → spared
      row('01C', 'other', 'failed'), // failed → rolled back
    ]
    const picked = selectSyncRollbackTargets(runs, ['failed', 'interrupted', 'canceled'], isWrapper)
    expect(picked.map((r) => r.nodeId).sort()).toEqual(['other', 'writer'])
  })

  test('resume status set ([failed,interrupted]) excludes canceled entirely', () => {
    const runs = [row('01A', 'w', 'canceled'), row('01B', 'x', 'failed')]
    const picked = selectSyncRollbackTargets(runs, ['failed', 'interrupted'], () => false)
    expect(picked.map((r) => r.nodeId)).toEqual(['x'])
  })

  test('child rows (parentNodeRunId set) never selected; freshest top-level per node wins', () => {
    const runs = [
      row('01A', 'n', 'failed'),
      row('01C', 'n', 'failed'), // newer id → wins
      row('01D', 'n', 'failed', '01A'), // child → ignored
    ]
    const picked = selectSyncRollbackTargets(runs, ['failed'], () => false)
    expect(picked).toHaveLength(1)
    expect(picked[0]!.id).toBe('01C')
  })
})

describe('RFC-109 buildSyncRunSummary — live wrapper state (Codex re-review P2)', () => {
  type Row = typeof nodeRunsTable.$inferSelect
  const wrun = (over: Partial<Row>): Row =>
    ({
      id: ulid(),
      taskId: 't',
      nodeId: 'w',
      parentNodeRunId: null,
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      wrapperProgressJson: null,
      ...over,
    }) as unknown as Row
  const live = (rows: Row[], nodeId: string) =>
    buildSyncRunSummary(rows).get(nodeId)?.hasLiveWrapperState ?? false

  test('terminal-breadcrumb wrappers (done/failed/exhausted + progress) are NOT live', () => {
    for (const status of ['done', 'failed', 'exhausted'] as const) {
      expect(live([wrun({ status, wrapperProgressJson: '{"iter":2}' })], 'w')).toBe(false)
    }
  })

  test('resumable wrappers with parked progress ARE live (awaiting/canceled/interrupted)', () => {
    for (const status of [
      'awaiting_human',
      'awaiting_review',
      'canceled',
      'interrupted',
    ] as const) {
      expect(live([wrun({ status, wrapperProgressJson: '{"iter":2}' })], 'w')).toBe(true)
    }
  })

  test('a non-terminal child row marks its parent wrapper live; a terminal child does not', () => {
    const parent = wrun({ id: '01P', nodeId: 'w', status: 'done', wrapperProgressJson: null })
    const liveChild = wrun({
      id: '01C',
      nodeId: 'inner',
      parentNodeRunId: '01P',
      status: 'running',
    })
    const doneChild = wrun({ id: '01D', nodeId: 'inner', parentNodeRunId: '01P', status: 'done' })
    expect(live([parent, liveChild], 'w')).toBe(true)
    expect(live([parent, doneChild], 'w')).toBe(false)
  })
})
