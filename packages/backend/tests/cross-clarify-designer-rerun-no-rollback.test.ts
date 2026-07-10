import { rimrafDir } from './helpers/cleanup'
// LOCKS: RFC-056 patch 2026-06-22 — the cross-clarify designer rerun must NOT
// roll the worktree back to pre_snapshot.
//
// Before the patch, the legacy designer-rerun mint unconditionally called
// `rollbackNodeRunWorktrees(..., { resetOnEmptySnapshot: false })`, i.e.
// `git reset --hard HEAD && git clean -fd && git stash apply <pre_snapshot>`
// against the designer's worktree — erasing the designer's output AND any
// downstream work written on top. The user reported this as unexpected: a
// cross-clarify `continue` is a *revise-with-feedback* continuation, not a
// retry, so the worktree must be preserved (the prior draft is re-supplied via
// the scheduler's `## Prior Output (to update or regenerate)` prompt block).
//
// RFC-132: the designer rerun is now minted by answering the awaiting cross
// round via the unified quick channel (autoDispatchClarifyRound →
// dispatchTaskQuestions frontier mint). The invariant is unchanged — the CROSS
// path never rolls the worktree back (the only rollback in the unified path is
// the SELF-clarify isolated-rerun branch, explicitly gated kind==='self').
//
// design/RFC-056-clarify-cross-agent/patch-2026-06-22-designer-rerun-no-rollback.md
//
// Determinism: pure local git (init / commit / stash create), no network / no
// clone / no stash push-pop — the non-flaky class per
// scheduler-audit-s11-stash-gc-prune-rollback.test.ts; NOT RUN_GIT_NETWORK-gated.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { gitStashSnapshot, runGit } from '../src/util/git'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

interface Repo {
  path: string
  cleanup: () => void
}

async function buildRepo(): Promise<Repo> {
  const path = mkdtempSync(join(tmpdir(), 'aw-designer-norollback-'))
  await runGit(path, ['init', '-q', '-b', 'main'])
  await runGit(path, ['config', 'user.email', 'test@example.com'])
  await runGit(path, ['config', 'user.name', 'Test'])
  writeFileSync(join(path, 'a.txt'), 'original\n')
  await runGit(path, ['add', '.'])
  await runGit(path, ['commit', '-q', '-m', 'init'])
  return { path, cleanup: () => rimrafDir(path) }
}

function makeQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `Question ${id}`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid: string): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

function triadDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
      {
        id: 'e_cross_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

/** Seed a workflow + task + a `done` designer node_run + a done questioner run. The task's
 *  worktreePath points at the REAL repo and the designer carries a REAL stash sha — so a
 *  future reintroduction of the rollback (which loads the target via
 *  `loadRollbackTarget(db, taskId)` → tasks.worktreePath) would actually fire
 *  and flip this test red. */
async function seedTaskAndDesigner(
  db: DbClient,
  taskId: string,
  worktreePath: string,
  preSnapshot: string,
): Promise<void> {
  const def = triadDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: worktreePath,
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: 1,
  })
  await db.insert(nodeRuns).values({
    id: 'nr_designer_done',
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot,
  })
  await db.insert(nodeRuns).values({
    id: 'nr_questioner_done',
    taskId,
    nodeId: 'questioner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
}

describe('RFC-056 patch 2026-06-22: cross-clarify designer rerun does not roll back the worktree', () => {
  let repo: Repo
  beforeEach(async () => {
    repo = await buildRepo()
  })
  afterEach(() => repo.cleanup())

  test('designer rerun preserves the worktree — designer + downstream output survive', async () => {
    // Dirty TRACKED change at snapshot time → non-empty stash sha (the value
    // the designer's pre_snapshot would hold in production).
    writeFileSync(join(repo.path, 'a.txt'), 'snapshot-state\n')
    const sha = await gitStashSnapshot(repo.path)
    expect(sha).toMatch(/^[a-f0-9]{40}$/)

    // The designer's output + a downstream node's output, written ON TOP as
    // untracked files. `git clean -fd` (the old rollback's second step) is
    // exactly what would delete these.
    writeFileSync(join(repo.path, 'design.md'), 'designer v1\n')
    writeFileSync(join(repo.path, 'downstream.txt'), 'coder output\n')

    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task_norollback'
    await seedTaskAndDesigner(db, taskId, repo.path, sha)

    // Seed an awaiting cross round (designer-scoped by default) and answer it — the
    // designer rerun comes out of the unified dispatch (res.dispatch.reruns).
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_questioner_done',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      actor,
    })

    // The answer ran to completion: a fresh pending designer row was minted.
    const designerRerun = res.dispatch.reruns.find((r) => r.targetNodeId === 'designer')
    expect(designerRerun).toBeDefined()
    const fresh = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, designerRerun!.nodeRunId))
    )[0]
    expect(fresh?.status).toBe('pending')

    // CORE LOCK: the worktree is untouched. The pre-patch rollback would have
    // `git clean -fd`'d both untracked files (RED). No rollback → both survive
    // with their post-snapshot content intact.
    expect(existsSync(join(repo.path, 'design.md'))).toBe(true)
    expect(existsSync(join(repo.path, 'downstream.txt'))).toBe(true)
    expect(readFileSync(join(repo.path, 'design.md'), 'utf8')).toBe('designer v1\n')
  })

  test('source guard: the cross-clarify service + the unified dispatch mint do not reference the rollback helpers', () => {
    // crossClarify.ts (readiness / stop / session logic) must stay rollback-free …
    const crossSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'crossClarify.ts'),
      'utf8',
    )
    expect(crossSrc).not.toContain('rollbackNodeRunWorktrees')
    expect(crossSrc).not.toContain('loadRollbackTarget')
    // … and so must the LIVE designer-rerun mint path (dispatchTaskQuestions). The only
    // rollback in the answer flow is autoDispatchClarifyRound's SELF-clarify branch
    // (gated kind==='self'), never the cross/designer dispatch.
    const dispatchSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'taskQuestionDispatch.ts'),
      'utf8',
    )
    expect(dispatchSrc).not.toContain('rollbackNodeRunWorktrees')
    expect(dispatchSrc).not.toContain('loadRollbackTarget')
  })
})
