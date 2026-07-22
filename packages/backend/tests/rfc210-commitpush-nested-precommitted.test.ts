// RFC-210 实现门 A8-fix — 嵌套子仓的 clean 预提交不再被跳过，红→绿锁。
//
// Codex 实现门（design/RFC-210-recursive-submodule-isolation/codex-impl-gate-2026-07-22.md
// critical #4）实测出的链条：`commitPushSubmodules` 用超级项目的
// `rev-parse HEAD:vendor/inner` 读 recorded gitlink，但该语法**穿不透 vendor
// 这一层 gitlink**（实测 exit 128 "exists on disk, but not in 'HEAD'"）。agent
// 已在 inner 里 commit 过（inner clean、只是领先），于是 `isDirty=false 且
// movedAhead=false`，inner 的 push 被整个跳过；随后 vendor 因 inner 的 gitlink
// 变脏而照常 commit+push，超级项目也推成功 —— 远端的 vendor 引用一个从未推到
// inner 远端的 SHA，任何人 clone 下来 `submodule update` 必失败。
//
// 修法：recorded 从**直接父仓**读（`git -C vendor rev-parse HEAD:inner`）；查
// 不到 recorded（新增子仓，父层 HEAD 里没有）按"必须推"处理，不是按"没动"。
// A8 原修复的语义保持不变：真正没动过的子仓一个 ref 都不写。

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
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-cpn-cfg-'))

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

const ADD = ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q'] as const

/**
 * Two-level fixture: superproject → vendor → inner, all with pushable origins
 * (the source repos themselves; pushing a NON-checked-out branch into a
 * non-bare repo is allowed, same trick as the sibling commit-push suite).
 */
async function fixture(): Promise<{ parent: string; vendorSrc: string; innerSrc: string }> {
  const innerSrc = tmp('aw-rfc210-cpn-inner-')
  await initRepo(innerSrc, 'i.txt', 'i1\n')
  const vendorSrc = tmp('aw-rfc210-cpn-vendor-')
  await initRepo(vendorSrc, 'v.txt', 'v1\n')
  await runGit(vendorSrc, [...ADD, innerSrc, 'inner'])
  await runGit(vendorSrc, ['commit', '-q', '-m', 'add inner'])

  const parentRemote = join(tmp('aw-rfc210-cpn-prem-'), 'parent.git')
  await runGit(tmp('aw-rfc210-cpn-x-'), ['init', '-q', '--bare', parentRemote])
  const parent = tmp('aw-rfc210-cpn-parent-')
  await initRepo(parent, 'README.md', 'root\n')
  await runGit(parent, [...ADD, vendorSrc, 'vendor'])
  await runGit(parent, ['commit', '-q', '-m', 'add vendor'])
  await runGit(parent, ['remote', 'add', 'origin', parentRemote])
  await runGit(parent, ['push', '-q', 'origin', 'main'])
  await runGit(parent, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--recursive',
    '-q',
  ])
  await runGit(parent, ['checkout', '-q', '-b', 'agent-workflow/t1'])
  return { parent, vendorSrc, innerSrc }
}

/** Same raw-SQL seeding as the sibling commit-push suites (explicit columns). */
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
  generateMessage: async () => ({ message: 'chore: nested submodule bump' }),
  generateRepair: async () => ({ message: null }),
}

describe('RFC-210 — nested pre-committed submodule push', () => {
  test('a clean-but-ahead vendor/inner is pushed before its parents publish gitlinks', async () => {
    const { parent, vendorSrc, innerSrc } = await fixture()
    // The agent commits INSIDE inner itself — inner ends up CLEAN but ahead of
    // the gitlink vendor records. This is the exact shape the superproject-level
    // `rev-parse HEAD:vendor/inner` probe could not see.
    const inner = join(parent, 'vendor', 'inner')
    writeFileSync(join(inner, 'i.txt'), 'agent-work\n')
    await runGit(inner, ['add', '-A'])
    await runGit(inner, [
      '-c',
      'user.email=t@e.com',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '-m',
      'agent commit in inner',
    ])
    const innerSha = (await runGit(inner, ['rev-parse', 'HEAD'])).stdout.trim()

    const res = await runCommitPush(
      { ...baseParams, worktreePath: parent },
      { db: await db(parent) },
    )

    expect(res.meta.pushOutcome).toBe('pushed')
    const paths = (res.meta.subrepos ?? []).map((s) => s.path)
    expect(paths).toContain('vendor/inner')
    expect(paths).toContain('vendor')
    // Bottom-up: inner settles before vendor stages its gitlink.
    expect(paths.indexOf('vendor/inner')).toBeLessThan(paths.indexOf('vendor'))

    // inner's remote actually has the agent commit — the dangling-gitlink hole.
    const onInnerRemote = await runGit(innerSrc, ['rev-parse', 'refs/heads/agent-workflow/t1'])
    expect(onInnerRemote.exitCode).toBe(0)
    expect(onInnerRemote.stdout.trim()).toBe(innerSha)

    // vendor's pushed branch records exactly that inner sha…
    const vendorRecorded = await runGit(vendorSrc, [
      'rev-parse',
      'refs/heads/agent-workflow/t1:inner',
    ])
    expect(vendorRecorded.exitCode).toBe(0)
    expect(vendorRecorded.stdout.trim()).toBe(innerSha)

    // …and the superproject's pushed branch records vendor's pushed commit —
    // every layer of the chain is resolvable by a fresh clone.
    const vendorPushed = await runGit(vendorSrc, ['rev-parse', 'refs/heads/agent-workflow/t1'])
    const superRecorded = await runGit(parent, [
      'rev-parse',
      `refs/remotes/origin/agent-workflow/t1:vendor`,
    ])
    expect(superRecorded.stdout.trim()).toBe(vendorPushed.stdout.trim())
  }, 120_000)

  test('untouched nested submodules still get no branch refs at all (A8 preserved)', async () => {
    const { parent, vendorSrc, innerSrc } = await fixture()
    // Only a PARENT-level change; vendor and inner are untouched.
    writeFileSync(join(parent, 'README.md'), 'root v2\n')

    const res = await runCommitPush(
      { ...baseParams, worktreePath: parent },
      { db: await db(parent) },
    )
    expect(res.meta.pushOutcome).toBe('pushed')
    expect(res.meta.subrepos).toBeUndefined()
    // The fixed recorded-sha resolution must not misread "untouched" as
    // "moved": no working branch may appear in either submodule origin.
    for (const src of [vendorSrc, innerSrc]) {
      const ref = await runGit(src, ['rev-parse', '--verify', 'refs/heads/agent-workflow/t1'])
      expect(ref.exitCode).not.toBe(0)
    }
  }, 120_000)
})
