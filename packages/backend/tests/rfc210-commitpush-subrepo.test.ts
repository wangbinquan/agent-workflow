// RFC-210 T30/T31/T34 — auto-commit-push 递归进 submodule。
//
// 这是本 RFC 三处静默数据丢失的第三处，两个形态：
//
//  1. **子仓脏 ⟹ skipped-empty**。父仓的 `status --porcelain` 会因为子仓脏而
//     显示 ` M sub`（脏检查门放行），但 `diff --cached --numstat` 对它是**空**的
//     —— gitlink 没动，父仓没有任何可暂存的变化。于是 filesChanged===0，整个
//     commit-push 判为「无变更」，agent 在子仓里的工作一个字节都没提交，连
//     message 生成会话都不会起。
//
//  2. **推出悬空 gitlink**。agent 自己在子仓里 commit 了（子仓恒为 detached
//     HEAD），父仓于是提交并推送一个指向「只存在于本地子仓、不在任何分支上」的
//     commit。别人 clone 下来 `submodule update` 必失败。
//
// 修法是先递归处理子仓（建同名工作分支 → commit → push），全部成功了父仓才
// bump gitlink 并推。任一子仓推不上去就**扣住父仓**——宁可少推一次，也不让远端
// 出现无法解析的 gitlink。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { runCommitPush } from '@/services/commitPushRunner'
import { runGit } from '@/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const created: string[] = []
let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-cp-cfg-'))

// This machine's global gitconfig enables protocol.file.allow; CI's does not, and
// the production path runs without the flag. Inject it explicitly or these pass
// locally and fail under CI's --isolate.
beforeAll(() => {
  const cfg = join(gitCfgDir, 'gitconfig')
  writeFileSync(cfg, '[protocol "file"]\n\tallow = always\n[user]\n\tname = t\n\temail = t@e.com\n')
  prevGitGlobal = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = cfg
})

afterAll(() => {
  if (prevGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = prevGitGlobal
  rmSync(gitCfgDir, { recursive: true, force: true })
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  created.push(d)
  return d
}

async function initRepo(dir: string, file: string, content: string): Promise<void> {
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  writeFileSync(join(dir, file), content)
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
}

/**
 * Parent worktree with one submodule, both wired to bare remotes so a real push
 * can be attempted. `subPushable=false` makes the submodule's remote read-only
 * by pointing it at a path that does not exist.
 */
async function fixture(subPushable: boolean): Promise<{ parent: string; subOrigin: string }> {
  const subRemote = join(tmp('aw-rfc210-cp-subrem-'), 'sub.git')
  await runGit(tmp('aw-rfc210-cp-x-'), ['init', '-q', '--bare', subRemote])
  const sub = tmp('aw-rfc210-cp-sub-')
  await initRepo(sub, 'a.txt', 'v1\n')
  await runGit(sub, ['remote', 'add', 'origin', subRemote])
  await runGit(sub, ['push', '-q', 'origin', 'main'])

  const parentRemote = join(tmp('aw-rfc210-cp-prem-'), 'parent.git')
  await runGit(tmp('aw-rfc210-cp-y-'), ['init', '-q', '--bare', parentRemote])
  const parent = tmp('aw-rfc210-cp-parent-')
  await initRepo(parent, 'README.md', 'root\n')
  await runGit(parent, ['submodule', 'add', '-q', sub, 'vendor'])
  await runGit(parent, ['commit', '-q', '-m', 'add submodule'])
  await runGit(parent, ['remote', 'add', 'origin', parentRemote])
  await runGit(parent, ['push', '-q', 'origin', 'main'])
  await runGit(parent, ['submodule', 'update', '--init', '-q'])
  // The runner pushes `repoBranch`; production puts the worktree on it before
  // commit-push runs, so the fixture must too.
  await runGit(parent, ['checkout', '-q', '-b', 'agent-workflow/t1'])

  if (!subPushable) {
    await runGit(join(parent, 'vendor'), [
      'remote',
      'set-url',
      'origin',
      join(tmp('aw-rfc210-cp-gone-'), 'nope.git'),
    ])
  }
  // `git submodule add <path>` makes THAT path the submodule's origin, so a push
  // from inside the submodule lands there — not in the bare remote `sub` itself
  // pushes to.
  return { parent, subOrigin: sub }
}

/** Same raw-SQL seeding as commit-push-runner.test.ts (explicit columns). */
async function db(repo: string) {
  const client = createInMemoryDb(MIGRATIONS)
  await client.run(sql`INSERT INTO workflows (id, name, definition) VALUES ('wf', 'f', '{}')`)
  await client.run(sql`
    INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
      base_branch, branch, status, inputs, started_at, schema_version)
    VALUES ('t1', 'cp', 'wf', '{}', ${repo}, ${repo}, 'main', 'agent-workflow/t1', 'running', '{}', 1, 1)
  `)
  // The mint factory enforces "born-running ⟹ child row", so provide the
  // triggering agent run exactly as production does.
  await client.run(sql`
    INSERT INTO node_runs (id, task_id, node_id, status, retry_index, iteration, started_at)
    VALUES ('parent-run', 't1', 'writer', 'done', 0, 0, 1)
  `)
  return client
}

const baseParams = {
  taskId: 't1',
  agentNodeId: 'writer',
  agentName: 'writer',
  parentNodeRunId: 'parent-run',
  repoBranch: 'agent-workflow/t1',
  baseRef: 'main',
  gitUserName: 'AW Bot',
  gitUserEmail: 'bot@aw.local',
  diffMaxBytes: 4096,
  maxRepairRetries: 0,
  generateMessage: async () => ({ message: 'chore: submodule bump' }),
  generateRepair: async () => ({ message: null }),
}

describe('RFC-210 recursive commit & push', () => {
  test('dirty submodule content is committed through — no longer skipped-empty', async () => {
    const { parent } = await fixture(true)
    // Agent edits INSIDE the submodule and leaves it uncommitted. The parent's
    // `diff --cached` sees nothing, which used to end the run as skipped-empty.
    writeFileSync(join(parent, 'vendor', 'a.txt'), 'edited-by-agent\n')

    const res = await runCommitPush(
      { ...baseParams, worktreePath: parent },
      { db: await db(parent) },
    )
    expect(res.meta.pushOutcome).not.toBe('skipped-empty')
    expect(res.meta.subrepos).toHaveLength(1)
    expect(res.meta.subrepos?.[0]?.committed).toBe(true)
    expect(res.meta.subrepos?.[0]?.pushed).toBe(true)
    // The submodule is on a real branch now, not a detached HEAD.
    const branch = await runGit(join(parent, 'vendor'), ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(branch.stdout.trim()).toBe('agent-workflow/t1')
  }, 120_000)

  test('the submodule content actually reaches its remote', async () => {
    const { parent, subOrigin } = await fixture(true)
    writeFileSync(join(parent, 'vendor', 'a.txt'), 'published\n')
    const res = await runCommitPush(
      { ...baseParams, worktreePath: parent },
      { db: await db(parent) },
    )
    const sha = res.meta.subrepos?.[0]?.toSha ?? ''
    expect(sha).toMatch(/^[a-f0-9]{40}$/)
    // A gitlink is only meaningful if the remote can resolve it — assert the
    // branch the runner pushed points at exactly the commit it reported.
    const onRemote = await runGit(subOrigin, ['rev-parse', 'refs/heads/agent-workflow/t1'])
    expect(onRemote.exitCode).toBe(0)
    expect(onRemote.stdout.trim()).toBe(sha)
  }, 120_000)

  test('a submodule that cannot be pushed WITHHOLDS the parent (no dangling gitlink)', async () => {
    const { parent } = await fixture(false)
    writeFileSync(join(parent, 'vendor', 'a.txt'), 'cannot-publish\n')
    const parentHeadBefore = (await runGit(parent, ['rev-parse', 'HEAD'])).stdout.trim()

    const res = await runCommitPush(
      { ...baseParams, worktreePath: parent },
      { db: await db(parent) },
    )

    expect(res.meta.pushOutcome).toBe('commit-local-subrepo-failed')
    expect(res.meta.subrepos?.[0]?.pushed).toBe(false)
    expect(res.meta.subrepos?.[0]?.error).not.toBeNull()
    // The parent must NOT have committed: pushing its gitlink bump would point
    // the remote at a submodule commit nobody can fetch.
    expect((await runGit(parent, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(parentHeadBefore)
    expect(res.meta.commitSha).toBeNull()
    // The submodule work is still committed LOCALLY — the user can retry.
    expect(res.meta.subrepos?.[0]?.committed).toBe(true)
    expect(readFileSync(join(parent, 'vendor', 'a.txt'), 'utf8')).toBe('cannot-publish\n')
  }, 120_000)

  test('a repo with no submodules behaves exactly as before', async () => {
    const plain = tmp('aw-rfc210-cp-plain-')
    await initRepo(plain, 'f.txt', 'v1\n')
    const remote = join(tmp('aw-rfc210-cp-plainrem-'), 'r.git')
    await runGit(tmp('aw-rfc210-cp-z-'), ['init', '-q', '--bare', remote])
    await runGit(plain, ['remote', 'add', 'origin', remote])
    await runGit(plain, ['push', '-q', 'origin', 'main'])
    await runGit(plain, ['checkout', '-q', '-b', 'agent-workflow/t1'])
    writeFileSync(join(plain, 'f.txt'), 'v2\n')

    const res = await runCommitPush({ ...baseParams, worktreePath: plain }, { db: await db(plain) })
    expect(res.meta.pushOutcome).toBe('pushed')
    // No submodules ⟹ the field is omitted entirely, keeping these rows
    // byte-identical to pre-RFC-210.
    expect(res.meta.subrepos).toBeUndefined()
  }, 120_000)
})
