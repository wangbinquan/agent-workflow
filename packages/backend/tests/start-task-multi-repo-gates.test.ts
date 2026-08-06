// LOCKS: RFC-066 PR-A T6 — multi-repo + wrapper-git / upload gates.
// RFC-165: multi-repo/pre-created PATH bodies are the framework-internal face
// now (the wire is URL-only) — bodies are cast through the internal
// RepoSourceSpec widening; runtime behavior is byte-identical to pre-165.
//
// Cases covered:
//   B13 workflow with a wrapper-git node + repos.length > 1 → 422 with code
//       `multi-repo-wrapper-git-unsupported` and the offending nodeId(s) in
//       the detail.
//   B14 workflow with an upload input + repos.length > 1 → 422 with code
//       `multi-repo-upload-unsupported` and the offending input keys in
//       the detail.
//   B15 single-repo (length === 1) + wrapper-git → still launches normally
//       (v1 only blocks the multi-repo combo).

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { StartTask } from '@agent-workflow/shared'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { removeTempDirSync } from './fixtures/tempDir'
import { startTask, startTaskWithLocalRepo } from '../src/services/task'
import { workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'
import { seedRepoGroup } from './helpers/repoGroupFixture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repos: string[]
  cleanup: () => void
}

async function buildHarness(repoCount: number): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc066-gates-home-'))
  const reposParent = mkdtempSync(join(tmpdir(), 'aw-rfc066-gates-repos-'))
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
  return {
    db,
    appHome,
    repos,
    cleanup: () => {
      removeTempDirSync(appHome)
      removeTempDirSync(reposParent)
    },
  }
}

async function seedWorkflow(db: DbClient, def: unknown): Promise<string> {
  const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await db.insert(workflows).values({
    id,
    name: 'wf',
    definition: JSON.stringify(def),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

// RFC-254: file:// git clone is slow on Windows; the default 5s timeout kills
// the in-flight clone (reported as 'git clone failed'). 60s gives it headroom.
setDefaultTimeout(60_000)

describe('RFC-066 PR-A T6 — multi-repo gates', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  // RFC-248 D9/D12 —— B13 / B14 **翻转**。
  //
  // RFC-066 当年在 startTask 里拦掉「多仓 + wrapper-git」与「多仓 + 上传」，理由是
  // 包裹器只对单一 worktree 取快照、上传物不知道该落到哪个仓。两条禁令都已解除：
  //   - wrapper-git 现在逐仓快照、逐仓 diff，路径按挂载路径前缀化后合并成
  //     `list<path>`（scheduler.ts runGitWrapperNode / diffableRepos）。不解除的话
  //     仓库组永远用不了平台的 Code → Audit → Fix 主链路——那正是本 RFC 的目的。
  //   - 上传物落到任务根下的 `.agent-workflow-inputs/`，不属于任何成员仓
  //     （applyUploadsToWorktree 的 inputsSubdir）。
  //
  // 断言从「抛 422」翻成「**能启动**」。留着旧断言等于把禁令又焊回来。

  test('B13 多仓 + wrapper-git → 不再被拒，正常启动（D9）', async () => {
    h = await buildHarness(2)
    const wfId = await seedWorkflow(h.db, {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'wg-1', kind: 'wrapper-git', nodeIds: ['inner-output'] },
        { id: 'inner-output', kind: 'output', ports: [] },
      ],
      edges: [],
    })
    const task = await startTask(
      {
        workflowId: wfId,
        name: 't',
        repoGroupId: await seedRepoGroup(h.db, h.appHome, [h.repos[0]!, h.repos[1]!]),
        inputs: {},
      } as unknown as StartTask,
      { db: h.db, appHome: h.appHome },
    )
    expect(task.id).toBeTruthy()
    expect(task.repos).toHaveLength(2)
  })

  test('B14 多仓 + 上传输入 → 不再被拒，正常启动（D12）', async () => {
    h = await buildHarness(2)
    const wfId = await seedWorkflow(h.db, {
      $schema_version: 1,
      // upload 输入必须带 `targetDir`（UploadInputSchema）。原夹具缺它，但旧的
      // 多仓门在静态校验器之前就抛了，所以这个缺陷一直没暴露。
      inputs: [{ key: 'attachments', label: 'Files', kind: 'upload', targetDir: 'inbox' }],
      // 原夹具是零节点的空工作流——多仓门当年在静态校验器**之前**抛，把这个
      // 夹具本身的非法性挡住了。门拆掉后校验器先说话（workflow-invalid），
      // 所以换成与 B13/B15 同款的最小合法节点集，让断言真的落在
      // 「多仓 + 上传能启动」上。
      nodes: [
        { id: 'wg-1', kind: 'wrapper-git', nodeIds: ['inner-output'] },
        { id: 'inner-output', kind: 'output', ports: [] },
      ],
      edges: [],
    })
    const task = await startTask(
      {
        workflowId: wfId,
        name: 't',
        repoGroupId: await seedRepoGroup(h.db, h.appHome, [h.repos[0]!, h.repos[1]!]),
        inputs: {},
      } as unknown as StartTask,
      { db: h.db, appHome: h.appHome },
    )
    expect(task.id).toBeTruthy()
    expect(task.repos).toHaveLength(2)
  })

  test('B15 single-repo + wrapper-git → still launches (gate only fires when multi-repo)', async () => {
    h = await buildHarness(1)
    const wfId = await seedWorkflow(h.db, {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'wg-1', kind: 'wrapper-git', nodeIds: ['inner-output'] },
        { id: 'inner-output', kind: 'output', ports: [] },
      ],
      edges: [],
    })
    const task = await startTaskWithLocalRepo(
      {
        workflowId: wfId,
        name: 't',
        repoPath: h.repos[0]!,
        baseBranch: 'main',
        inputs: {},
      },
      { db: h.db, appHome: h.appHome },
    )
    // Single-repo path keeps RFC-040 / wrapper-git behavior — no 422.
    // Task may or may not run to completion (scheduler is async and may emit
    // its own errors for an empty-inner wrapper-git), but startTask itself
    // does not throw.
    expect(task.id).toBeDefined()
    expect(task.repoCount).toBe(1)
  })
})
