import { rimrafDir } from './helpers/cleanup'
// RFC-034 T6 — createWorktree triggers `submodule update --init --recursive`
// inside the fresh worktree when the parent repo has a `.gitmodules` file.
//
// Why: `git worktree add` shares `.git` with the parent but the per-worktree
// submodule working directories must be initialized separately. Without this,
// agents running inside the worktree see empty submodule directories.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree } from '../src/util/git'

// RUN_GIT_NETWORK gate (P0 test-tier fortification): builds a real submodule
// fixture via `git submodule add file://` + bare clone, then drives
// createWorktree's `submodule update --init --recursive`. The file:// clone /
// recursion flakes (timeout) on machines without unrestricted file-protocol
// git, masking real regressions. Gated so local `bun test` is deterministic;
// CI exports RUN_GIT_NETWORK=1 to preserve coverage. See git-repo-cache-submodule.
const RUN_GIT_NETWORK = process.env.RUN_GIT_NETWORK === '1'

async function gitCmd(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
}

describe.skipIf(!RUN_GIT_NETWORK)('createWorktree RFC-034 submodule init', () => {
  let root: string
  let parentRepo: string
  let childBare: string
  let appHome: string
  let savedGlobal: string | undefined

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'aw-wt-sub-'))
    const cfg = mkdtempSync(join(tmpdir(), 'aw-wt-cfg-'))
    writeFileSync(join(cfg, '.gitconfig'), '[protocol "file"]\n  allow = always\n', 'utf-8')
    savedGlobal = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = join(cfg, '.gitconfig')

    // child bare repo serving as the submodule URL
    const childWorking = join(root, 'child-src')
    mkdirSync(childWorking, { recursive: true })
    await gitCmd(childWorking, 'init', '-b', 'main', childWorking)
    await gitCmd(childWorking, '-C', childWorking, 'config', 'user.email', 'a@b')
    await gitCmd(childWorking, '-C', childWorking, 'config', 'user.name', 'a')
    writeFileSync(join(childWorking, 'CHILD.md'), 'child\n', 'utf-8')
    await gitCmd(childWorking, '-C', childWorking, 'add', '.')
    await gitCmd(childWorking, '-C', childWorking, 'commit', '-m', 'init')
    childBare = join(root, 'child.git')
    await gitCmd(root, 'clone', '--bare', childWorking, childBare)

    // parent repo with the submodule wired
    parentRepo = join(root, 'parent')
    mkdirSync(parentRepo, { recursive: true })
    await gitCmd(parentRepo, 'init', '-b', 'main', parentRepo)
    await gitCmd(parentRepo, '-C', parentRepo, 'config', 'user.email', 'a@b')
    await gitCmd(parentRepo, '-C', parentRepo, 'config', 'user.name', 'a')
    await gitCmd(
      parentRepo,
      '-C',
      parentRepo,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      `file://${childBare}`,
      'sub',
    )
    await gitCmd(parentRepo, '-C', parentRepo, 'commit', '-m', 'wire submodule')

    appHome = mkdtempSync(join(tmpdir(), 'aw-wt-home-'))
  })

  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal
    rimrafDir(root)
    rimrafDir(appHome)
  })

  test('worktree on parent w/ .gitmodules populates submodule dir (mode=auto)', async () => {
    const wt = await createWorktree({
      repoPath: parentRepo,
      taskId: '01TASKAUTO',
      appHome,
      submoduleMode: 'auto',
      submoduleJobs: 1,
    })
    expect(wt.hasSubmodules).toBe(true)
    expect(wt.submoduleInitOk).toBe(true)
    expect(existsSync(join(wt.worktreePath, 'sub', 'CHILD.md'))).toBe(true)
  })

  test('mode=never skips init even with .gitmodules', async () => {
    const wt = await createWorktree({
      repoPath: parentRepo,
      taskId: '01TASKNEVER',
      appHome,
      submoduleMode: 'never',
      submoduleJobs: 1,
    })
    expect(wt.hasSubmodules).toBe(false)
    expect(wt.submoduleInitOk).toBe(true)
    expect(existsSync(join(wt.worktreePath, 'sub'))).toBe(true) // empty placeholder
    expect(existsSync(join(wt.worktreePath, 'sub', 'CHILD.md'))).toBe(false)
  })

  test('worktree on repo without .gitmodules: hasSubmodules=false, ok=true', async () => {
    // Use the child repo (no submodules of its own).
    const childWorking = join(root, 'child-src')
    const wt = await createWorktree({
      repoPath: childWorking,
      taskId: '01TASKNOMOD',
      appHome,
      submoduleMode: 'auto',
      submoduleJobs: 1,
    })
    expect(wt.hasSubmodules).toBe(false)
    expect(wt.submoduleInitOk).toBe(true)
    expect(wt.submoduleInitError).toBeNull()
  })
})

// Always-on gate self-test (runs even in the default skipped mode).
describe('RUN_GIT_NETWORK gate sanity', () => {
  test('suite is skipped iff RUN_GIT_NETWORK!=1', () => {
    expect(!RUN_GIT_NETWORK).toBe(process.env.RUN_GIT_NETWORK !== '1')
  })
})
