import { rimrafDir } from './helpers/cleanup'
// P-4-09: worktree GC scan.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { runWorktreeGc } from '../src/services/gc'
import { createWorktree, runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-gc-'))
  const repoPath = join(appHome, 'repo')
  // init a real repo so createWorktree works.
  await runGit(appHome, ['init', '-q', '-b', 'main', 'repo'])
  await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
  await runGit(repoPath, ['config', 'user.name', 'Test'])
  await runGit(repoPath, ['commit', '--allow-empty', '-q', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    repoPath,
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedDoneTask(
  h: Harness,
  overrides: Partial<typeof tasks.$inferInsert> = {},
): Promise<{ taskId: string; worktreePath: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  const wt = await createWorktree({
    repoPath: h.repoPath,
    taskId,
    appHome: h.appHome,
  })
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: h.repoPath,
    worktreePath: wt.worktreePath,
    baseBranch: 'main',
    branch: wt.branch,
    status: 'done',
    inputs: '{}',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 500,
    ...overrides,
  })
  return { taskId, worktreePath: wt.worktreePath }
}

describe('runWorktreeGc', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('disabled => no-op', async () => {
    await seedDoneTask(h)
    const r = await runWorktreeGc(h.db, { worktreeAutoGc: { enabled: false } })
    expect(r).toEqual({ scanned: 0, removed: [], skipped: 0 })
  })

  test('removes terminal-state worktrees older than threshold', async () => {
    const longAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
    const { taskId, worktreePath } = await seedDoneTask(h, { finishedAt: longAgo })
    expect(existsSync(worktreePath)).toBe(true)
    const r = await runWorktreeGc(h.db, {
      worktreeAutoGc: { enabled: true, olderThanDays: 1 },
    })
    expect(r.removed).toEqual([taskId])
    expect(existsSync(worktreePath)).toBe(false)
  })

  test('keeps recent worktrees when olderThanDays threshold not met', async () => {
    const { taskId, worktreePath } = await seedDoneTask(h)
    const r = await runWorktreeGc(h.db, {
      worktreeAutoGc: { enabled: true, olderThanDays: 7 },
    })
    expect(r.removed).toEqual([])
    expect(r.skipped).toBe(1)
    expect(existsSync(worktreePath)).toBe(true)
    // task row not deleted either
    const [t] = await h.db.select().from(tasks)
    expect(t?.id).toBe(taskId)
  })
})
