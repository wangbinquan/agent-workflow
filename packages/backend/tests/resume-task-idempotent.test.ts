import { rimrafDir } from './helpers/cleanup'
// RFC-053 PR-A T1e — resumeTask behavior + idempotency + race.
//
// Locks the current contract:
//   - failed / interrupted / awaiting_review / awaiting_human → flip task to
//     pending, fire-and-forget runTask
//   - any other task status (pending / running / done / canceled) → 409
//   - non-existent task → 404
//   - done node_runs left untouched on resume (only failed/interrupted are
//     rolled back to preSnapshot — and even then only on the latest row per
//     nodeId)
//
// Calling resumeTask twice in fast succession will see task=pending on the
// second call and throw 409 — this is the idempotency story we have today
// (PR-D / PR-E may add outbox semantics later).

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { resumeTask } from '../src/services/task'
import { gitStashSnapshot, runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  taskId: string
  cleanup: () => void
}

async function buildHarness(
  taskStatus:
    | 'pending'
    | 'running'
    | 'awaiting_review'
    | 'awaiting_human'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'interrupted',
): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1e-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])

  const db = createInMemoryDb(MIGRATIONS)
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: taskStatus,
    inputs: '{}',
    startedAt: Date.now(),
    finishedAt: taskStatus === 'done' || taskStatus === 'failed' ? Date.now() : null,
    errorSummary: taskStatus === 'failed' ? 'boom' : null,
  })
  return {
    db,
    appHome,
    repoPath,
    taskId,
    cleanup: () => rimrafDir(tmp),
  }
}

describe('RFC-053 PR-A T1e — resumeTask idempotency + race', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('R1 resume from failed flips task→pending and clears error fields', async () => {
    h = await buildHarness('failed')
    await h.db
      .update(tasks)
      .set({ errorSummary: 'boom', errorMessage: 'detail', failedNodeId: 'doc' })
      .where(eq(tasks.id, h.taskId))

    const after = await resumeTask(h.db, h.taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['/usr/bin/env', 'true'],
    })
    expect(after.status).toBe('pending')
    expect(after.errorSummary).toBeNull()
    expect(after.errorMessage).toBeNull()
    expect(after.failedNodeId).toBeNull()
    expect(after.finishedAt).toBeNull()
  })

  test('R2 resume from interrupted: same path', async () => {
    h = await buildHarness('interrupted')
    const after = await resumeTask(h.db, h.taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['/usr/bin/env', 'true'],
    })
    expect(after.status).toBe('pending')
  })

  test('R3 resume from awaiting_review: same path (post-approve / fix-up)', async () => {
    h = await buildHarness('awaiting_review')
    const after = await resumeTask(h.db, h.taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['/usr/bin/env', 'true'],
    })
    expect(after.status).toBe('pending')
  })

  test('R4 resume from awaiting_human: same path (post-clarify-answer)', async () => {
    h = await buildHarness('awaiting_human')
    const after = await resumeTask(h.db, h.taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['/usr/bin/env', 'true'],
    })
    expect(after.status).toBe('pending')
  })

  test('R5 resume twice rapidly: second call throws 409 (task-not-resumable)', async () => {
    h = await buildHarness('failed')
    await resumeTask(h.db, h.taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['/usr/bin/env', 'true'],
    })
    let code: string | undefined
    try {
      await resumeTask(h.db, h.taskId, {
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['/usr/bin/env', 'true'],
      })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('task-not-resumable')
  })

  test('R6 resume from done throws 409', async () => {
    h = await buildHarness('done')
    let code: string | undefined
    try {
      await resumeTask(h.db, h.taskId, {
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['/usr/bin/env', 'true'],
      })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('task-not-resumable')
  })

  test('R7 resume on non-existent task throws 404', async () => {
    h = await buildHarness('failed')
    let code: string | undefined
    try {
      await resumeTask(h.db, 'no-such-task', {
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['/usr/bin/env', 'true'],
      })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('task-not-found')
  })

  // RFC-098 B2 (design 修订#5): the old R8 used a FAKE sha ('sha-fake-failed')
  // on the failed row, which only stayed green because the pre-fix rollback was
  // warn-and-continue even when `git stash apply` blew up. The WP-9 fail-closed
  // rollback turns a missing snapshot into a task-level 'snapshot-lost'
  // escalation, so the case is split:
  //   R8a — the happy half with a REAL stash sha (done rows untouched, failed
  //         row stays historical, resume proceeds);
  //   R8b — the snapshot-lost half (resumeTask throws 409 'snapshot-lost',
  //         task flips failed with errorSummary='snapshot-lost', and the
  //         worktree is byte-for-byte untouched — fail-closed means the
  //         destructive reset/clean never ran).
  test('R8a resume with a REAL stash sha: done node_runs untouched, failed row stays historical, resume proceeds', async () => {
    h = await buildHarness('failed')
    const doneId = ulid()
    const finishedAt = Date.now() - 500
    await h.db.insert(nodeRuns).values({
      id: doneId,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      // Done rows are never rolled back — a fake sha here proves it: were the
      // rollback to touch this row, fail-closed would 409 the whole resume.
      preSnapshot: 'sha-fake-done',
      startedAt: Date.now() - 1000,
      finishedAt,
    })
    // A subsequent failed retry attempt with a REAL stash snapshot.
    writeFileSync(join(h.repoPath, 'README.md'), '# snapshot-time\n')
    const realSha = await gitStashSnapshot(h.repoPath)
    expect(realSha).not.toBe('')
    const failedId = ulid()
    await h.db.insert(nodeRuns).values({
      id: failedId,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'failed',
      retryIndex: 1,
      iteration: 0,
      preSnapshot: realSha,
      startedAt: Date.now() - 200,
      finishedAt: Date.now() - 100,
      errorMessage: 'boom',
    })

    const after = await resumeTask(h.db, h.taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['/usr/bin/env', 'true'],
    })
    expect(after.status).toBe('pending')

    // Done row preserved (status + finishedAt unchanged).
    const doneAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, doneId)))[0]!
    expect(doneAfter.status).toBe('done')
    expect(doneAfter.finishedAt).toBe(finishedAt)
    // Failed row stays as historical (resumeTask doesn't change its status
    // — the scheduler will mint a fresh retry on dispatch).
    const failedAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, failedId)))[0]!
    expect(failedAfter.status).toBe('failed')
    // The rollback actually restored the snapshot-time worktree state.
    expect(readFileSync(join(h.repoPath, 'README.md'), 'utf-8')).toBe('# snapshot-time\n')
  })

  test("R8b snapshot lost: resumeTask throws 409 'snapshot-lost', task flips failed (errorSummary='snapshot-lost'), worktree untouched", async () => {
    h = await buildHarness('failed')
    const failedId = ulid()
    await h.db.insert(nodeRuns).values({
      id: failedId,
      taskId: h.taskId,
      nodeId: 'doc',
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      // Well-formed sha that exists in NO odb — deterministic stand-in for a
      // gc-pruned snapshot (same shape git-snapshot.test.ts uses).
      preSnapshot: 'deadbeef'.repeat(5),
      startedAt: Date.now() - 200,
      finishedAt: Date.now() - 100,
      errorMessage: 'boom',
    })
    // Dirty worktree state that the pre-fix destroy-then-fail rollback would
    // have eaten (tracked mutation + untracked stray).
    writeFileSync(join(h.repoPath, 'README.md'), '# DIRTY\n')
    writeFileSync(join(h.repoPath, 'stray.txt'), 'keep-me\n')

    let code: string | undefined
    try {
      await resumeTask(h.db, h.taskId, {
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['/usr/bin/env', 'true'],
      })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('snapshot-lost')

    // Task escalated pending → failed with the snapshot-lost summary + detail.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    expect(t.status).toBe('failed')
    expect(t.errorSummary).toBe('snapshot-lost')
    expect(t.errorMessage).toContain(failedId)
    expect(t.errorMessage).toContain('pre-snapshot lost')
    expect(t.failedNodeId).toBe('doc')

    // Fail-closed: the worktree was never reset/cleaned.
    expect(readFileSync(join(h.repoPath, 'README.md'), 'utf-8')).toBe('# DIRTY\n')
    expect(existsSync(join(h.repoPath, 'stray.txt'))).toBe(true)
  })
})
