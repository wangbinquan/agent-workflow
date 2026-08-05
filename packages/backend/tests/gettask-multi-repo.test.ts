// LOCKS: RFC-066 PR-A T4 — getTask hydrates Task.repos[] from task_repos
// RFC-165: multi-repo/pre-created PATH bodies are the framework-internal face
// now (the wire is URL-only) — bodies are cast through the internal
// RepoSourceSpec widening; runtime behavior is byte-identical to pre-165.
// rows sorted by repo_index ascending. Single-repo tasks (the legacy default
// today) return a length-1 array mirroring the tasks.* columns; multi-repo
// tasks return N entries in launch order.

import { afterEach, describe, expect, test } from 'bun:test'
import type { StartTask } from '@agent-workflow/shared'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { startTask, startTaskWithLocalRepo, getTask } from '../src/services/task'
import { workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'
import { basename } from 'node:path'
import { seedRepoGroup } from './helpers/repoGroupFixture'
import { removeTempDirSync } from './fixtures/tempDir'

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
    // RFC-254 T32: Windows refuses to delete a path that still has an open
    // handle, so a plain `rmSync` here failed the whole test with EBUSY after
    // its assertions had already passed. The helper retries the short window
    // where a released handle has not yet been reclaimed.
    cleanup: () => {
      removeTempDirSync(appHome)
      removeTempDirSync(reposParent)
    },
  }
}

describe('RFC-066 PR-A T4 — getTask hydrates repos[]', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('B26 single-repo task → repos.length === 1, repoCount === 1, mirror values match', async () => {
    h = await buildHarness(1)
    const launched = await startTaskWithLocalRepo(
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
        repoGroupId: await seedRepoGroup(h.db, h.appHome, [h.repos[0]!, h.repos[1]!, h.repos[2]!]),
        inputs: {},
      } as unknown as StartTask,
      { db: h.db, appHome: h.appHome },
    )
    const task = await getTask(h.db, launched.id)
    expect(task).not.toBeNull()
    expect(task!.repoCount).toBe(3)
    expect(task!.repos).toHaveLength(3)
    expect(task!.repos.map((r) => r.repoIndex)).toEqual([0, 1, 2])
    // RFC-248: 组路径的成员经**镜像仓**落地（RFC-204 的 URL 封存要求源仓先
    // 被 clone 进 `~/.agent-workflow/repos/`），所以 `repoPath` 是镜像路径，
    // 不再等于源目录。B27 锁的是**按 repoIndex 升序 hydrate**这件事，源路径
    // 相等只是 RFC-066 直路径时代的巧合——这里改断言镜像与源仓一一对应。
    for (const [i, r] of task!.repos.entries()) {
      expect(r.repoPath.startsWith(h.appHome)).toBe(true)
      // 镜像目录名以源仓 basename 收尾，顺序与 repoIndex 对齐。
      expect(r.repoPath.endsWith(basename(h.repos[i]!))).toBe(true)
    }
    // worktreeDirName non-empty for every multi-repo row.
    for (const r of task!.repos) expect(r.worktreeDirName.length > 0).toBe(true)
  })
})
