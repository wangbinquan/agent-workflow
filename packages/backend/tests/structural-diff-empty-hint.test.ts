// RFC-239 §3.3 — differentiated empty states. A scratch-space task with no
// git-visible change used to render the same "no structural change" line as a
// repo task that genuinely modified nothing, which read as "the analysis
// broke" (observed on a real refactor task). The service now stamps
// `emptyHint` so the frontend can explain WHY the view is empty.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'
import { getTaskStructuralDiff as getTaskStructuralDiffWithPort } from '../src/services/structuralDiff/service'
import { createSqliteCodeWorkspaceRead } from '../src/modules/code-capability/infrastructure/sqliteCodeWorkspaceRead'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const getTaskStructuralDiff = (
  db: DbClient,
  ...args: Parameters<typeof getTaskStructuralDiffWithPort> extends [unknown, ...infer Rest]
    ? Rest
    : never
) => getTaskStructuralDiffWithPort(createSqliteCodeWorkspaceRead(db), ...args)

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function makeRepo(): Promise<{ dir: string; commit: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-eh-'))
  dirs.push(dir)
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@t.test'])
  await runGit(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.py'), 'class A:\n    pass\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  const commit = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  return { dir, commit }
}

async function seedTask(
  db: DbClient,
  opts: {
    worktreePath: string
    baseCommit: string
    spaceKind: 'local' | 'remote' | 'scratch' | 'internal'
  },
): Promise<string> {
  const taskId = `01EH${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const workflowId = `wf-${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify({ nodes: [], edges: [] }),
    version: 1,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify({ nodes: [], edges: [] }),
    repoPath: opts.worktreePath,
    worktreePath: opts.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    // 'running' keeps the eager persist branch out of the way (terminal tasks
    // write structural-diffs/ under the real app home).
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    baseCommit: opts.baseCommit,
    spaceKind: opts.spaceKind,
  })
  return taskId
}

describe('RFC-239 emptyHint', () => {
  test('clean scratch-space task → scratch-space; clean repo task → no-changes', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const scratch = await makeRepo()
    const scratchTask = await seedTask(db, {
      worktreePath: scratch.dir,
      baseCommit: scratch.commit,
      spaceKind: 'scratch',
    })
    const scratchDiff = await getTaskStructuralDiff(db, scratchTask)
    expect(scratchDiff.files).toEqual([])
    expect(scratchDiff.emptyHint).toBe('scratch-space')

    const repo = await makeRepo()
    const repoTask = await seedTask(db, {
      worktreePath: repo.dir,
      baseCommit: repo.commit,
      spaceKind: 'local',
    })
    expect((await getTaskStructuralDiff(db, repoTask)).emptyHint).toBe('no-changes')
  })

  test('a task WITH changes never carries emptyHint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { dir, commit } = await makeRepo()
    writeFileSync(join(dir, 'b.py'), 'def added():\n    return 1\n')
    const taskId = await seedTask(db, {
      worktreePath: dir,
      baseCommit: commit,
      spaceKind: 'scratch',
    })
    const diff = await getTaskStructuralDiff(db, taskId)
    expect(diff.files.length).toBeGreaterThan(0)
    expect(diff.emptyHint).toBeUndefined()
  })
})
