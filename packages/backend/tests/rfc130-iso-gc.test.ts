// RFC-395 II-pre：GC 改接生产 workspaceMaintenance，断言其回执及实际目录 / 行状态。
// RFC-130 PR-E — orphan iso worktree GC. A node run normally discardNodeIso's its
// iso worktree on completion, but a crash / kept conflict-human iso / daemon restart
// can leave {appHome}/iso/{taskId}/* behind. runIsoWorktreeGc removes the iso
// containers of TERMINAL tasks (and iso dirs with no task row = deleted task), and
// keeps ACTIVE tasks' iso worktrees (they may be in flight).

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { workspaceMaintenanceForTest } from './helpers/workspaceMaintenance'
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
async function seedWorkflow(db: PersistenceDb): Promise<string> {
  const id = ulid()
  const { workflows } = tablesOf(db)
  await insertOne(db, workflows, {
    id,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

async function seedTask(
  db: PersistenceDb,
  id: string,
  workflowId: string,
  status: 'done' | 'running',
): Promise<void> {
  const { tasks } = tablesOf(db)
  await insertOne(db, tasks, {
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
    expect(
      await workspaceMaintenanceForTest(db, appHome).runGcPhase({
        phase: 'iso',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...{ worktreeAutoGc: { enabled: true } },
      }),
    ).toEqual({ scanned: 0, removed: 0, skipped: 0 })
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

    const res = await workspaceMaintenanceForTest(db, appHome).runGcPhase({
      phase: 'iso',
      activeTaskIds: [],
      gitCloneTimeoutMs: 30 * 60 * 1000,
      now: Date.now(),
      ...{ worktreeAutoGc: { enabled: true } },
    })
    expect(res.scanned).toBe(3)
    // Terminal (done) + orphan-row (deleted) removed; active (running) kept.
    expect(res.removed).toBe(2)
    expect(existsSync(join(appHome, 'iso', doneTask))).toBe(false)
    expect(existsSync(join(appHome, 'iso', deletedTask))).toBe(false)
    expect(existsSync(join(appHome, 'iso', runningTask))).toBe(true)
    rmSync(appHome, { recursive: true, force: true })
  })
})
