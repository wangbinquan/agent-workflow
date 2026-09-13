// RFC-130 PR-E — orphan iso worktree GC. A node run normally discardNodeIso's its
// iso worktree on completion, but a crash / kept conflict-human iso / daemon restart
// can leave {appHome}/iso/{taskId}/* behind. runIsoWorktreeGc removes the iso
// containers of TERMINAL tasks (and iso dirs with no task row = deleted task), and
// keeps ACTIVE tasks' iso worktrees (they may be in flight).

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { tasks, workflows } from '../src/db/schema'
import { runIsoWorktreeGc } from '../src/services/gc'

async function seedWorkflow(db: ProviderNeutralDatabase): Promise<string> {
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
  db: ProviderNeutralDatabase,
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

describeEachProvider('RFC-130 PR-E — orphan iso worktree GC', (harness) => {
  test('no iso root → no-op', async () => {
    const db = harness.db
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-isogc-'))
    expect(await runIsoWorktreeGc(db, appHome)).toEqual({ scanned: 0, removed: [] })
    rmSync(appHome, { recursive: true, force: true })
  })

  test('removes terminal + orphan-row iso containers, keeps active', async () => {
    const db = harness.db
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
    rmSync(appHome, { recursive: true, force: true })
  })
})
