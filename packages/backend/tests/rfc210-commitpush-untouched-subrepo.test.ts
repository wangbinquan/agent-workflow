// RFC-210 后续修正 — commit-push 只碰本任务真正改过的子仓，且子仓非 FF 不调和。
// 红→绿回归锁。
//
// 设计 §5.1② 写的是「对每个**有本地新提交或脏内容**的子仓」，实现漏了这个谓词：
// 干净且没有本地新提交的子仓也照样 `checkout -B` + `push`。两个后果，都实测过：
//
//  1. **一个只读的 vendored 三方子仓会扣住整个父仓。** 它推不上去，而子仓这条
//     路径把任何失败都当致命（父仓路径至少还会把 auth 失败降级成
//     commit-local-auth 并保留本地提交），于是父仓既没提交也没推送、node_run
//     记 failed —— 而那个子仓压根没东西要贡献。这反转了 RFC-075 自己写在文件
//     头的不变量：「push 不成也绝不丢工作，本地提交总是先落地」。
//
//  2. **每个 autoCommitPush 任务都往每个子仓的远端写一个分支 ref**，包括仅仅被
//     vendored 进来的三方仓。
//
// 另一条：子仓 push 非 FF 时原来会 `fetch` + `merge --no-edit FETCH_HEAD` 再推
// 一次（照抄父仓的修复），而在子仓里这是破坏性的——它会把被 pin 的子仓
// **fast-forward 到 upstream tip** 然后发布出去，pin 就此销毁，而没有任何人要求
// 过 bump 子仓。这正是 gitSubmoduleRemote 默认关闭要避免的漂移。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import { runCommitPush } from '@/services/commitPushRunner'
import { runGit } from '@/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const created: string[] = []
let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-cpu-cfg-'))

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
      /* best-effort */
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

async function fixture(subPushable: boolean): Promise<{ parent: string; sub: string }> {
  const subRemote = join(tmp('aw-rfc210-cpu-subrem-'), 'sub.git')
  await runGit(tmp('aw-rfc210-cpu-x-'), ['init', '-q', '--bare', subRemote])
  const sub = tmp('aw-rfc210-cpu-sub-')
  await initRepo(sub, 'a.txt', 'v1\n')
  await runGit(sub, ['remote', 'add', 'origin', subRemote])
  await runGit(sub, ['push', '-q', 'origin', 'main'])

  const parentRemote = join(tmp('aw-rfc210-cpu-prem-'), 'parent.git')
  await runGit(tmp('aw-rfc210-cpu-y-'), ['init', '-q', '--bare', parentRemote])
  const parent = tmp('aw-rfc210-cpu-parent-')
  await initRepo(parent, 'README.md', 'root\n')
  await runGit(parent, ['submodule', 'add', '-q', sub, 'vendor'])
  await runGit(parent, ['commit', '-q', '-m', 'add submodule'])
  await runGit(parent, ['remote', 'add', 'origin', parentRemote])
  await runGit(parent, ['push', '-q', 'origin', 'main'])
  await runGit(parent, ['submodule', 'update', '--init', '-q'])
  await runGit(parent, ['checkout', '-q', '-b', 'agent-workflow/t1'])

  if (!subPushable) {
    await runGit(join(parent, 'vendor'), [
      'remote',
      'set-url',
      'origin',
      join(tmp('aw-rfc210-cpu-gone-'), 'nope.git'),
    ])
  }
  return { parent, sub }
}

async function db(repo: string) {
  const client = createInMemoryDb(MIGRATIONS)
  await client.run(sql`INSERT INTO workflows (id, name, definition) VALUES ('wf', 'f', '{}')`)
  await client.run(sql`
    INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
      base_branch, branch, status, inputs, started_at, schema_version)
    VALUES ('t1', 'cp', 'wf', '{}', ${repo}, ${repo}, 'main', 'agent-workflow/t1', 'running', '{}', 1, 1)
  `)
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
  generateMessage: async () => ({ message: 'chore: parent only' }),
  generateRepair: async () => ({ message: null }),
}

describe('RFC-210 — untouched submodules are left alone', () => {
  test('an unpushable vendored submodule does not withhold the parent', async () => {
    const { parent } = await fixture(false)
    // The agent edits ONLY a parent file. `vendor` is clean and its HEAD equals
    // the recorded gitlink — nothing to contribute.
    writeFileSync(join(parent, 'README.md'), 'parent edited by agent\n')

    const res = await runCommitPush(
      { ...baseParams, worktreePath: parent },
      { db: await db(parent) },
    )

    // Before the fix: `commit-local-subrepo-failed`, commitSha null, parent
    // neither committed nor pushed — because a read-only third-party submodule
    // failed a push nobody asked for.
    expect(res.meta.pushOutcome).toBe('pushed')
    expect(res.meta.subrepos ?? []).toHaveLength(0)
    const parentHead = await runGit(parent, ['log', '-1', '--format=%s'])
    expect(parentHead.stdout.trim()).not.toBe('add submodule')
  }, 120_000)

  test('no branch ref is written into an untouched submodule remote', async () => {
    const { parent, sub } = await fixture(true)
    writeFileSync(join(parent, 'README.md'), 'parent only\n')

    await runCommitPush({ ...baseParams, worktreePath: parent }, { db: await db(parent) })

    // `git submodule add <path>` makes that path the submodule's origin, so a
    // push from inside the submodule would land here.
    const ref = await runGit(sub, ['rev-parse', '--verify', 'refs/heads/agent-workflow/t1'])
    expect(ref.exitCode).not.toBe(0)
    // And the platform never moved it onto its own branch. (Whatever the
    // submodule was checked out on stays — the point is that `checkout -B
    // agent-workflow/t1` did not run here.)
    const branch = await runGit(join(parent, 'vendor'), ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(branch.stdout.trim()).not.toBe('agent-workflow/t1')
  }, 120_000)
})

describe('RFC-210 — a submodule pin is never fast-forwarded to upstream', () => {
  test('non-fast-forward reports instead of merging upstream in', async () => {
    const { parent, sub } = await fixture(true)
    // Upstream has moved on: the branch the runner will push to already exists
    // in the submodule's origin, pointing at work we did not make.
    await runGit(sub, ['checkout', '-q', '-b', 'agent-workflow/t1'])
    writeFileSync(join(sub, 'upstream.txt'), 'moved on without us\n')
    await runGit(sub, ['add', '.'])
    await runGit(sub, ['commit', '-q', '-m', 'upstream advances'])
    const upstreamTip = (await runGit(sub, ['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(sub, ['checkout', '-q', 'main'])

    // The agent genuinely edits the submodule, so it IS ours to push.
    writeFileSync(join(parent, 'vendor', 'a.txt'), 'edited-by-agent\n')
    const pinned = (await runGit(join(parent, 'vendor'), ['rev-parse', 'HEAD'])).stdout.trim()

    const res = await runCommitPush(
      { ...baseParams, worktreePath: parent },
      { db: await db(parent) },
    )

    // The push is refused, and that is reported — not "repaired".
    expect(res.meta.subrepos?.[0]?.pushed).toBe(false)
    expect(res.meta.subrepos?.[0]?.error ?? '').not.toBe('')
    expect(res.meta.pushOutcome).toBe('commit-local-subrepo-failed')

    // THE regression: `merge FETCH_HEAD` used to fast-forward the submodule onto
    // the upstream tip and publish it, destroying the pin. Our commit must sit
    // on top of the PINNED commit, with upstream's work nowhere in its history.
    const subHead = (await runGit(join(parent, 'vendor'), ['rev-parse', 'HEAD'])).stdout.trim()
    expect(subHead).not.toBe(upstreamTip)
    const parentOf = await runGit(join(parent, 'vendor'), ['rev-parse', 'HEAD^'])
    expect(parentOf.stdout.trim()).toBe(pinned)
    const containsUpstream = await runGit(join(parent, 'vendor'), [
      'merge-base',
      '--is-ancestor',
      upstreamTip,
      'HEAD',
    ])
    expect(containsUpstream.exitCode).not.toBe(0)
  }, 120_000)
})
