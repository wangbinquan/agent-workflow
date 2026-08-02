// RFC-248 PR-3 T19/T19b —— 三个 git 原语的**真 git** 集成测试。
//
// 这是 `design/RFC-248-repo-groups/materialize-prototype.sh` 的 TypeScript 化：
// 那份 shell 原型证明了整条物化流水线可行（proposal E8），这里把它拆成原语级
// 断言，让每个不变量单独可归因。
//
// 三条被锁死的 git 事实（proposal §实测依据）：
//   E2  不排除的话 `git add -A` 会把嵌套仓**当 gitlink 提交**并告警。
//   E5  sparse 模式文件是 **per-worktree** 的（`info/exclude` 相反，是 common-dir
//       级的，会污染同镜像所有 worktree——所以 D1 没走那条路）。
//   E6  **非 cone** 模式挂载点只含目标子目录；cone 会连带检出仓根级文件。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import {
  applySparseSubdir,
  commitGitignorePreset,
  createWorktree,
  findTrackedPathUnderMounts,
  nonInteractiveGitEnv,
} from '../src/util/git'

let tmp = ''
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aw-rfc248-git-'))
})
afterEach(() => {
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...nonInteractiveGitEnv(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  })
}

/** 造一个带若干文件的源仓，返回它的路径。 */
function makeRepo(name: string, files: Record<string, string>): string {
  const dir = join(tmp, `src-${name}`)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-b', 'main', '.')
  git(dir, 'config', 'user.email', 't@t.test')
  git(dir, 'config', 'user.name', 't')
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  git(dir, 'add', '-A')
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')
  return dir
}

function lsVisible(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n !== '.git')
    .sort()
}

describe('applySparseSubdir（D17）', () => {
  test('非 cone 模式：挂载点只含目标子目录，连仓根级文件都不检出', async () => {
    const src = makeRepo('docs', {
      'guides/g1.md': 'g1',
      'guides/g2.md': 'g2',
      'api/a.md': 'a',
      'README.md': 'readme',
    })
    const wt = join(tmp, 'mnt')
    const created = await createWorktree({
      repoPath: src,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
      sparseSubdir: 'guides',
    })
    expect(created.worktreePath).toBe(wt)
    // cone 模式会把 README.md 也带出来——这正是 D17 选非 cone 的原因。
    expect(lsVisible(wt)).toEqual(['guides'])
    expect(git(wt, 'status', '--porcelain').trim()).toBe('')
  })

  test('sparse 配置是 per-worktree 的——同镜像的另一个 worktree 仍全量检出', async () => {
    const src = makeRepo('docs2', { 'guides/g.md': 'g', 'api/a.md': 'a', 'README.md': 'r' })
    const sparseWt = join(tmp, 'sparse')
    const fullWt = join(tmp, 'full')
    await createWorktree({
      repoPath: src,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: sparseWt,
      sparseSubdir: 'guides',
    })
    await createWorktree({
      repoPath: src,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: fullWt,
    })
    expect(lsVisible(sparseWt)).toEqual(['guides'])
    expect(lsVisible(fullWt)).toEqual(['README.md', 'api', 'guides'])
  })

  test('sparse 子树内的改动照常进 diff', async () => {
    const src = makeRepo('docs3', { 'guides/g.md': 'g', 'api/a.md': 'a' })
    const wt = join(tmp, 'mnt')
    await createWorktree({
      repoPath: src,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
      sparseSubdir: 'guides',
    })
    writeFileSync(join(wt, 'guides/g.md'), 'changed')
    // porcelain 的前导空格有意义（' M' = 工作区改动、未暂存），不能 trim 掉。
    expect(git(wt, 'status', '--porcelain')).toBe(' M guides/g.md\n')
  })

  test('subdir 不存在于该 ref ⇒ 挂载点为空（调用方据此报 sparse-empty）', async () => {
    const src = makeRepo('docs4', { 'guides/g.md': 'g' })
    const wt = join(tmp, 'mnt')
    await createWorktree({
      repoPath: src,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
      sparseSubdir: 'nope',
    })
    expect(lsVisible(wt)).toEqual([])
  })

  test('直接调用 applySparseSubdir 可以收窄一个已存在的 worktree', async () => {
    const src = makeRepo('docs5', { 'a/x': 'x', 'b/y': 'y' })
    const wt = join(tmp, 'mnt')
    await createWorktree({ repoPath: src, taskId: ulid(), appHome: tmp, overrideWorktreePath: wt })
    expect(lsVisible(wt)).toEqual(['a', 'b'])
    await applySparseSubdir(wt, 'a')
    expect(lsVisible(wt)).toEqual(['a'])
  })
})

describe('branchName 覆盖（D14）', () => {
  test('同一个源仓两个 worktree 用不同分支名——不带序号会撞 already checked out', async () => {
    const src = makeRepo('app', { 'f.txt': 'f' })
    const taskId = ulid()
    const wt1 = join(tmp, 'w1')
    const wt2 = join(tmp, 'w2')
    await createWorktree({ repoPath: src, taskId, appHome: tmp, overrideWorktreePath: wt1 })
    await createWorktree({
      repoPath: src,
      taskId,
      appHome: tmp,
      overrideWorktreePath: wt2,
      branchName: `agent-workflow/${taskId}-2`,
    })
    expect(git(wt1, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(`agent-workflow/${taskId}`)
    expect(git(wt2, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(`agent-workflow/${taskId}-2`)
  })
})

describe('commitGitignorePreset（D1）', () => {
  test('嵌套仓不排除时 add -A 会把它当 gitlink 提交（E2 —— 这是要防的行为）', async () => {
    const outer = makeRepo('outer', { 'f.txt': 'f' })
    const inner = makeRepo('inner', { 'g.txt': 'g' })
    const wt = join(tmp, 'wt')
    await createWorktree({
      repoPath: outer,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
    })
    await createWorktree({
      repoPath: inner,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: join(wt, 'vendor/in'),
    })
    expect(git(wt, 'status', '--porcelain')).toContain('?? vendor/')
    git(wt, 'add', '-A')
    // 索引里出现了一个 gitlink（mode 160000）——推上去就是坏的子模块指针。
    expect(git(wt, 'ls-files', '--stage', 'vendor/in')).toContain('160000')
  })

  test('预置 commit 之后：status 干净、add -A 不碰嵌套仓、diff 里没有 .gitignore', async () => {
    const outer = makeRepo('outer2', { 'f.txt': 'f' })
    const inner = makeRepo('inner2', { 'g.txt': 'g' })
    const wt = join(tmp, 'wt')
    await createWorktree({
      repoPath: outer,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
    })

    const taskId = ulid()
    const r = await commitGitignorePreset({
      worktreePath: wt,
      relMountPaths: ['vendor/in'],
      taskId,
      gitUserName: 'aw',
      gitUserEmail: 'aw@x',
    })
    expect(r.commitSha).not.toBeNull()
    expect(r.addedRules).toEqual(['/vendor/in/'])
    const baseCommit = r.commitSha!

    await createWorktree({
      repoPath: inner,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: join(wt, 'vendor/in'),
    })
    // 外层完全看不见内层。
    expect(git(wt, 'status', '--porcelain').trim()).toBe('')
    git(wt, 'add', '-A')
    expect(git(wt, 'ls-files', '--stage', 'vendor/in').trim()).toBe('')

    // worker 干活后，相对 base_commit 的 diff 只有 worker 的改动——**没有**
    // `.gitignore`（它在 base_commit 里）也没有嵌套挂载点。
    writeFileSync(join(wt, 'f.txt'), 'worker')
    const names = git(wt, 'diff', baseCommit, '--name-only').trim().split('\n').filter(Boolean)
    expect(names).toEqual(['f.txt'])
  })

  test('幂等：规则已存在 ⇒ 返回 null 且不产生第二个 commit', async () => {
    const outer = makeRepo('outer3', { 'f.txt': 'f' })
    const wt = join(tmp, 'wt')
    await createWorktree({
      repoPath: outer,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
    })
    const first = await commitGitignorePreset({
      worktreePath: wt,
      relMountPaths: ['vendor/in'],
      taskId: ulid(),
    })
    expect(first.commitSha).not.toBeNull()
    const countAfterFirst = git(wt, 'rev-list', '--count', 'HEAD').trim()

    // 第二个任务复用同一条分支（RFC-075 workingBranch 场景）。
    const second = await commitGitignorePreset({
      worktreePath: wt,
      relMountPaths: ['vendor/in'],
      taskId: ulid(),
    })
    expect(second.commitSha).toBeNull()
    expect(second.addedRules).toEqual([])
    expect(git(wt, 'rev-list', '--count', 'HEAD').trim()).toBe(countAfterFirst)
  })

  test('无挂载点 ⇒ 不产生任何 commit（叶子仓不该被平白多一笔）', async () => {
    const outer = makeRepo('outer4', { 'f.txt': 'f' })
    const wt = join(tmp, 'wt')
    await createWorktree({
      repoPath: outer,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
    })
    const before = git(wt, 'rev-list', '--count', 'HEAD').trim()
    const r = await commitGitignorePreset({ worktreePath: wt, relMountPaths: [], taskId: ulid() })
    expect(r.commitSha).toBeNull()
    expect(git(wt, 'rev-list', '--count', 'HEAD').trim()).toBe(before)
  })

  test('gitignore 元字符被转义——目标目录真的被排除，同名近邻不被误排', async () => {
    const outer = makeRepo('outer5', { 'f.txt': 'f' })
    const wt = join(tmp, 'wt')
    await createWorktree({
      repoPath: outer,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
    })
    await commitGitignorePreset({ worktreePath: wt, relMountPaths: ['a[b]'], taskId: ulid() })
    mkdirSync(join(wt, 'a[b]'), { recursive: true })
    writeFileSync(join(wt, 'a[b]/x'), 'x')
    mkdirSync(join(wt, 'ab'), { recursive: true })
    writeFileSync(join(wt, 'ab/x'), 'x')
    const status = git(wt, 'status', '--porcelain')
    expect(status).not.toContain('a[b]') // 目标被排除
    expect(status).toContain('ab/') // 近邻**没有**被误排
  })

  test('身份缺省时用明确的平台身份，不去猜用户的全局 user.name', async () => {
    const outer = makeRepo('outer6', { 'f.txt': 'f' })
    const wt = join(tmp, 'wt')
    await createWorktree({
      repoPath: outer,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
    })
    await commitGitignorePreset({ worktreePath: wt, relMountPaths: ['v'], taskId: ulid() })
    expect(git(wt, 'log', '-1', '--format=%an <%ae>').trim()).toBe(
      'agent-workflow <agent-workflow@localhost>',
    )
  })
})

describe('findTrackedPathUnderMounts（设计门二轮 H8）', () => {
  test('容器在选定 ref 上跟踪着落在挂载点下的路径 ⇒ 报冲突', async () => {
    // 这正是 sparse 打开的那条缝：工作树里没有 `hidden/dep`，但索引里有。
    const src = makeRepo('container', { 'hidden/dep/file.txt': 'x', 'visible.txt': 'v' })
    const hit = await findTrackedPathUnderMounts(src, 'HEAD', ['hidden/dep'])
    expect(hit).not.toBeNull()
    expect(hit?.mountRel).toBe('hidden/dep')
    expect(hit?.trackedPath).toBe('hidden/dep/file.txt')
  })

  test('工作树看不见但索引里有 ⇒ 仍然报冲突（只看工作树会漏）', async () => {
    const src = makeRepo('container2', { 'hidden/dep/file.txt': 'x', 'keep.txt': 'k' })
    const wt = join(tmp, 'wt')
    await createWorktree({
      repoPath: src,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
      sparseSubdir: 'keep.txt',
    })
    // 工作树里没有 hidden/ —— 光看工作树会以为挂载点是空的。
    expect(existsSync(join(wt, 'hidden'))).toBe(false)
    // 但树上有。
    expect(await findTrackedPathUnderMounts(src, 'HEAD', ['hidden/dep'])).not.toBeNull()
  })

  test('无冲突 ⇒ null', async () => {
    const src = makeRepo('clean', { 'src/a.ts': 'a' })
    expect(await findTrackedPathUnderMounts(src, 'HEAD', ['vendor/x'])).toBeNull()
  })

  test('空挂载点列表 ⇒ null（不去跑 git）', async () => {
    const src = makeRepo('clean2', { 'src/a.ts': 'a' })
    expect(await findTrackedPathUnderMounts(src, 'HEAD', [])).toBeNull()
  })

  test('按段边界匹配——`vendor/xy` 不算 `vendor/x` 的冲突', async () => {
    const src = makeRepo('sib', { 'vendor/xy/f': 'f' })
    expect(await findTrackedPathUnderMounts(src, 'HEAD', ['vendor/x'])).toBeNull()
  })
})

describe('预置 commit 内容可读、可解释', () => {
  test('区块带任务 id 与开闭标记，人能看懂它是平台加的', async () => {
    const outer = makeRepo('outer7', { 'f.txt': 'f' })
    const wt = join(tmp, 'wt')
    await createWorktree({
      repoPath: outer,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
    })
    const taskId = 'T01HZZ'
    await commitGitignorePreset({ worktreePath: wt, relMountPaths: ['vendor/in'], taskId })
    const content = readFileSync(join(wt, '.gitignore'), 'utf8')
    expect(content).toContain(`agent-workflow: nested repo mounts (task ${taskId})`)
    expect(content).toContain('/vendor/in/')
    expect(git(wt, 'log', '-1', '--format=%s').trim()).toBe(
      'chore(agent-workflow): exclude nested repo mounts',
    )
  })
})
