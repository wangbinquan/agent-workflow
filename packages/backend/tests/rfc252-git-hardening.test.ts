// Regression lock for RFC-252 G1 (daemon 侧 git 执行面收口).
//
// 为什么这个文件存在：agent 对本任务 worktree 与其 git 公共目录持有**合法**写权限
// （`sealedSubprocess.ts` 的 `gitCommonDirs` 是 rw allow-back，`git commit` 必需），
// 于是它可以放一个 hook、或往 repo-local `.git/config` 写一条可执行配置，随后 daemon
// 侧任意一次 git 调用就会**在沙箱外、以 daemon 身份、带完整 process.env** 执行它 ——
// 这是 agent 可直接驱动的唯一一条完整逃逸链（RFC-252 proposal §背景，git 2.50.1 实测）。
//
// 每个回归用例都跑成对的两条路径：
//   - 裸 `git`（未硬化）：**必须**触发陷阱 —— 证明这条攻击真实存在、且本用例真的会
//     在修复被摘掉时变红，而不是一个恒绿的空断言；
//   - `runGit`（生产路径）：**必须不**触发。
//
// 任何一天有人把 util/gitHardening.ts 的覆盖集拆掉，下半截立刻红。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '@/util/git'
import {
  gitHooksVoidDir,
  gitSubcommandIndex,
  hardenedGitLeadingArgs,
  withExternalDiffDisabled,
} from '@/util/gitHardening'
import { syncSubmodules } from '@/services/gitSubmodule'

let home: string
let prevHome: string | undefined

beforeAll(() => {
  prevHome = process.env.AGENT_WORKFLOW_HOME
  home = mkdtempSync(join(tmpdir(), 'rfc252-home-'))
  process.env.AGENT_WORKFLOW_HOME = home
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = prevHome
  rmSync(home, { recursive: true, force: true })
})

/** 未硬化的裸 git —— 用来证明陷阱本身有效（对照组）。 */
async function rawGit(cwd: string, args: readonly string[]): Promise<number> {
  const proc = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args],
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  })
  return proc.exited
}

interface Fixture {
  repo: string
  root: string
  hits: () => string[]
  clearHits: () => void
}

/** 一个装好全部陷阱的真仓库：hooks 目录、core.hooksPath、fsmonitor、diff.external。 */
async function armedRepo(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'rfc252-repo-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const hitsFile = join(root, 'hits.txt')
  const trap = (marker: string, extra = ''): string =>
    `#!/bin/sh\necho ${marker} >> ${hitsFile}\n${extra}`

  await rawGit(repo, ['init', '-q', '-b', 'main', '.'])
  await rawGit(repo, [
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ])

  // 陷阱 1：仓库自带 hooks 目录里的 post-checkout。
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), trap('HOOKS_DIR'), { mode: 0o755 })

  // 陷阱 2：把 core.hooksPath 指向 worktree 内 agent 自己的目录 —— 它连
  // `.git/hooks/` 都不用碰，那是它的正常工作区。
  const evil = join(repo, 'evil-hooks')
  mkdirSync(evil, { recursive: true })
  writeFileSync(join(evil, 'post-checkout'), trap('HOOKS_PATH'), { mode: 0o755 })
  await rawGit(repo, ['config', 'core.hooksPath', evil])

  // 陷阱 3：core.fsmonitor —— 任何一次索引刷新（status/diff/add/commit）都会跑它。
  const fsm = join(root, 'fsm.sh')
  writeFileSync(fsm, trap('FSMONITOR', 'exit 1\n'), { mode: 0o755 })
  await rawGit(repo, ['config', 'core.fsmonitor', fsm])

  // 陷阱 4：diff.external —— daemon 侧 diff 会执行它。
  const ext = join(root, 'ext.sh')
  writeFileSync(ext, trap('DIFF_EXTERNAL'), { mode: 0o755 })
  await rawGit(repo, ['config', 'diff.external', ext])
  writeFileSync(join(repo, 'f.txt'), 'one\n')
  await rawGit(repo, ['add', 'f.txt'])
  await rawGit(repo, [
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '-m',
    'f',
  ])
  writeFileSync(join(repo, 'f.txt'), 'two\n')

  // 布置陷阱的过程本身就会触发 fsmonitor（add/commit 都要刷索引）——那正说明陷阱是
  // 活的。交给用例前清零，否则每个用例都要自己记得清。
  rmSync(hitsFile, { force: true })

  return {
    repo,
    root,
    hits: () =>
      existsSync(hitsFile)
        ? readFileSync(hitsFile, 'utf8').split('\n').filter(Boolean)
        : ([] as string[]),
    clearHits: () => {
      rmSync(hitsFile, { force: true })
    },
  }
}

describe('RFC-252 G1 · 纯函数', () => {
  test('gitSubcommandIndex 跳过 -c/-C 这类 git 自身选项', () => {
    expect(gitSubcommandIndex(['diff'])).toBe(0)
    expect(gitSubcommandIndex(['-C', '/x', 'status'])).toBe(2)
    // 生产里真实存在的形态（util/git.ts:1598、gitSubmodule.ts:560）。
    expect(gitSubcommandIndex(['-c', 'core.quotepath=false', 'diff', '--name-only'])).toBe(2)
    expect(gitSubcommandIndex(['-c', 'a=b', '-C', '/x', '-c', 'c=d', 'worktree', 'add'])).toBe(6)
    expect(gitSubcommandIndex(['-c', 'a=b'])).toBe(-1)
    expect(gitSubcommandIndex([])).toBe(-1)
  })

  test('withExternalDiffDisabled 只改 diff，且插在子命令紧后', () => {
    // 实测约束：--no-ext-diff 是 diff 子命令的选项，放到子命令之前会 unknown option。
    expect(withExternalDiffDisabled(['diff', '--name-only'])).toEqual([
      'diff',
      '--no-ext-diff',
      '--name-only',
    ])
    expect(withExternalDiffDisabled(['-c', 'core.quotepath=false', 'diff', 'a', 'b'])).toEqual([
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-ext-diff',
      'a',
      'b',
    ])
    // 非 diff 子命令一律原样 —— 这条修正必须是定向的，不能污染别的 argv。
    expect(withExternalDiffDisabled(['status', '--porcelain'])).toEqual(['status', '--porcelain'])
    expect(withExternalDiffDisabled(['worktree', 'add', 'x'])).toEqual(['worktree', 'add', 'x'])
    // 幂等：调用方自己传了就不重复插入。
    expect(withExternalDiffDisabled(['diff', '--no-ext-diff'])).toEqual(['diff', '--no-ext-diff'])
  })

  test('hardenedGitLeadingArgs 覆盖 hooksPath 与 fsmonitor，且 hooks 空目录落在 appHome 内', () => {
    const args = hardenedGitLeadingArgs()
    expect(args).toEqual([
      '-c',
      `core.hooksPath=${gitHooksVoidDir()}`,
      '-c',
      'core.fsmonitor=false',
    ])
    // appHome 在两层沙箱里都是拒绝区；放到 /tmp 之类 agent 可写的位置等于把
    // hooksPath 又交回给它。
    expect(gitHooksVoidDir().startsWith(home)).toBe(true)
    expect(existsSync(gitHooksVoidDir())).toBe(true)
    // fsmonitor 必须是布尔字面量：空串会被 git 当成「配置了一个空命令」。
    expect(args).not.toContain('core.fsmonitor=')
  })
})

describe('RFC-252 G1 · 回归：agent 植入的可执行 git 配置不得由 daemon 执行', () => {
  test('worktree add 不再触发 post-checkout（hooks 目录 与 core.hooksPath 两条）', async () => {
    const f = await armedRepo()
    try {
      // 对照组：裸 git 必须中招，否则本用例是恒绿的空断言。
      await rawGit(f.repo, ['worktree', 'add', '-q', join(f.root, 'wt-raw'), '-b', 'raw'])
      expect(f.hits()).toContain('HOOKS_PATH')

      f.clearHits()
      const r = await runGit(f.repo, [
        'worktree',
        'add',
        '-q',
        join(f.root, 'wt-safe'),
        '-b',
        'safe',
      ])
      expect(r.exitCode).toBe(0)
      expect(f.hits()).toEqual([])
      // 功能未被搞坏：worktree 真的建出来了。
      expect(existsSync(join(f.root, 'wt-safe'))).toBe(true)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('status 不再触发 core.fsmonitor', async () => {
    const f = await armedRepo()
    try {
      await rawGit(f.repo, ['status', '--porcelain'])
      expect(f.hits()).toContain('FSMONITOR')

      f.clearHits()
      const r = await runGit(f.repo, ['status', '--porcelain'])
      expect(r.exitCode).toBe(0)
      expect(f.hits()).toEqual([])
      // 功能未被搞坏：仍然报告了那个被改动的文件。
      expect(r.stdout).toContain('f.txt')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('diff 不再触发 diff.external，且仍输出可解析的 unified diff', async () => {
    const f = await armedRepo()
    try {
      await rawGit(f.repo, ['diff'])
      expect(f.hits()).toContain('DIFF_EXTERNAL')

      f.clearHits()
      const r = await runGit(f.repo, ['diff'])
      expect(r.exitCode).toBe(0)
      expect(f.hits()).toEqual([])
      // 外部 diff 程序的输出本就不可解析 —— 这条既是安全修复也是正确性修复。
      expect(r.stdout).toContain('diff --git')
      expect(r.stdout).toContain('-one')
      expect(r.stdout).toContain('+two')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('commit 不再触发 fsmonitor / hooks，且提交本身成功', async () => {
    const f = await armedRepo()
    try {
      // 对照组：裸 git 的索引刷新照样中招。
      await rawGit(f.repo, ['add', '-A'])
      expect(f.hits()).toContain('FSMONITOR')
      f.clearHits()

      const r = await runGit(f.repo, [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '-am',
        'x',
      ])
      expect(r.exitCode).toBe(0)
      expect(f.hits()).toEqual([])
      const log = await runGit(f.repo, ['log', '--oneline', '-1'])
      expect(log.stdout).toContain('x')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})

describe('RFC-252 G1 · submodule update 固定 checkout 策略', () => {
  test('syncSubmodules 传 --checkout，堵掉 submodule.<name>.update = !cmd', async () => {
    const calls: string[][] = []
    const dir = mkdtempSync(join(tmpdir(), 'rfc252-sub-'))
    try {
      const result = await syncSubmodules(dir, {
        mode: 'always',
        jobs: 1,
        runGitImpl: async (_cwd: string, args: string[]) => {
          calls.push([...args])
          return { stdout: '', stderr: '', exitCode: 0 }
        },
      })
      expect(result.ok).toBe(true)
      const update = calls.find((c) => c[0] === 'submodule' && c[1] === 'update')
      expect(update).toBeDefined()
      // `--checkout` 就是 git 的默认策略；固定它只是拿掉 config 覆盖它的能力，
      // 对任何诚实仓库零行为变化。
      expect(update).toContain('--checkout')
      expect(update).toContain('--init')
      expect(update).toContain('--recursive')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
