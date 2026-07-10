import { rimrafDir } from './helpers/cleanup'
// RFC-130 PR-E — orphan iso worktree GC. A node run normally discardNodeIso's its
// iso worktree on completion, but a crash / kept conflict-human iso / daemon restart
// can leave {appHome}/iso/{taskId}/* behind. runIsoWorktreeGc removes the iso
// containers of TERMINAL tasks (and iso dirs with no task row = deleted task), and
// keeps ACTIVE tasks' iso worktrees (they may be in flight).

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { runIsoWorktreeGc } from '../src/services/gc'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedWorkflow(db: ReturnType<typeof createInMemoryDb>): Promise<string> {
  const id = ulid()
  await db.insert(workflows).values({
    id,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

async function seedTask(
  db: ReturnType<typeof createInMemoryDb>,
  id: string,
  workflowId: string,
  status: 'done' | 'running',
): Promise<void> {
  await db.insert(tasks).values({
    id,
    name: 'x',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/nonexistent-repo',
    worktreePath: '/tmp/nonexistent-wt',
    baseBranch: 'main',
    branch: `b/${id}`,
    status,
    inputs: '{}',
    startedAt: Date.now(),
  })
}

describe('RFC-130 PR-E — orphan iso worktree GC', () => {
  test('no iso root → no-op', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-isogc-'))
    expect(await runIsoWorktreeGc(db, appHome)).toEqual({ scanned: 0, removed: [] })
    rimrafDir(appHome)
  })

  test('removes terminal + orphan-row iso containers, keeps active', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-isogc-'))
    const wf = await seedWorkflow(db)
    const doneTask = ulid()
    const runningTask = ulid()
    const deletedTask = ulid() // iso dir present but NO task row (deleted task)
    await seedTask(db, doneTask, wf, 'done')
    await seedTask(db, runningTask, wf, 'running')
    for (const id of [doneTask, runningTask, deletedTask]) {
      mkdirSync(join(appHome, 'iso', id, 'noderun'), { recursive: true })
    }

    const res = await runIsoWorktreeGc(db, appHome)
    expect(res.scanned).toBe(3)
    // Terminal (done) + orphan-row (deleted) removed; active (running) kept.
    expect(res.removed.sort()).toEqual([doneTask, deletedTask].sort())
    expect(existsSync(join(appHome, 'iso', doneTask))).toBe(false)
    expect(existsSync(join(appHome, 'iso', deletedTask))).toBe(false)
    expect(existsSync(join(appHome, 'iso', runningTask))).toBe(true)
    rimrafDir(appHome)
  })
})
