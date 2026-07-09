import { rimrafDir } from './helpers/cleanup'
// LOCKS: RFC-066 PR-A T4 — getTask hydrates Task.repos[] from task_repos
// rows sorted by repo_index ascending. Single-repo tasks (the legacy default
// today) return a length-1 array mirroring the tasks.* columns; multi-repo
// tasks return N entries in launch order.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { startTask, getTask } from '../src/services/task'
import { workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repos: string[]
  cleanup: () => void
}

async function buildHarness(repoCount: number): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc066-gt-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc066-gt-repos-'))
  const repos: string[] = []
  for (let i = 0; i < repoCount; i++) {
    const repoPath = mkdtempSync(join(reposParent, `r${i}-`))
    await runGit(repoPath, ['init', '-q', '-b', 'main'])
    await runGit(repoPath, ['config', 'user.email', 't@t'])
    await runGit(repoPath, ['config', 'user.name', 'T'])
    writeFileSync(join(repoPath, 'README.md'), `# repo-${i}\n`)
    await runGit(repoPath, ['add', '.'])
    await runGit(repoPath, ['commit', '-q', '-m', 'init'])
    repos.push(repoPath)
  }

  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(workflows).values({
    id: 'wf-gt',
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  return {
    db,
    appHome,
    repos,
    cleanup: () => {
      rimrafDir(appHome)
      rimrafDir(reposParent)
    },
  }
}

describe('RFC-066 PR-A T4 — getTask hydrates repos[]', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('B26 single-repo task → repos.length === 1, repoCount === 1, mirror values match', async () => {
    h = await buildHarness(1)
    const launched = await startTask(
      {
        workflowId: 'wf-gt',
        name: 't',
        repoPath: h.repos[0]!,
        baseBranch: 'main',
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    const task = await getTask(h.db, launched.id)
    expect(task).not.toBeNull()
    expect(task!.repoCount).toBe(1)
    expect(task!.repos).toHaveLength(1)
    expect(task!.repos[0]!.repoIndex).toBe(0)
    expect(task!.repos[0]!.repoPath).toBe(h.repos[0]!)
    expect(task!.repos[0]!.worktreeDirName).toBe('')
    // Single-repo: repos[0].worktreePath equals task.worktreePath (cwd == repo).
    expect(task!.repos[0]!.worktreePath).toBe(task!.worktreePath)
  })

  test('B27 multi-repo task → repos array ordered by repoIndex ascending', async () => {
    h = await buildHarness(3)
    const launched = await startTask(
      {
        workflowId: 'wf-gt',
        name: 'multi',
        repos: [
          { repoPath: h.repos[0]!, baseBranch: 'main' },
          { repoPath: h.repos[1]!, baseBranch: 'main' },
          { repoPath: h.repos[2]!, baseBranch: 'main' },
        ],
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    const task = await getTask(h.db, launched.id)
    expect(task).not.toBeNull()
    expect(task!.repoCount).toBe(3)
    expect(task!.repos).toHaveLength(3)
    expect(task!.repos.map((r) => r.repoIndex)).toEqual([0, 1, 2])
    expect(task!.repos[0]!.repoPath).toBe(h.repos[0]!)
    expect(task!.repos[1]!.repoPath).toBe(h.repos[1]!)
    expect(task!.repos[2]!.repoPath).toBe(h.repos[2]!)
    // worktreeDirName non-empty for every multi-repo row.
    for (const r of task!.repos) expect(r.worktreeDirName.length > 0).toBe(true)
  })
})
