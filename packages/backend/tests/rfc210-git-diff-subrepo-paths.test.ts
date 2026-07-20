// RFC-210 T35/T36 — git_diff 端口把 submodule 展开成真实文件路径。
//
// 为什么这条测试存在：
//
// 超级项目把一个 submodule 当**一个**条目报告（`vendor`），而
// `ls-files --others` 从不看子仓内部。于是 wrapper-git 的 `git_diff` 端口
// （RFC-060 PR-E 之后是 list<path<*>>）交给下游 agent 的是一个**目录**，
// 整个子仓的改动坍缩成一个指向文件夹的分片——审计要审什么文件无从得知。
//
// 展开方式是 **gitlink 区间差集**，不是 `submodule foreach ... status`：
// 这段代码跑到的时候内层节点的产物已经 merge 回来了、子仓工作区是**干净**的，
// 基于 porcelain 的做法一条都报不出来。真正描述改动的是「baseline 记录的
// gitlink」到「子仓当前 HEAD」这段区间。
//
// 所有失败路径都降级为「保留裸路径」而不是抛异常：gitChangedFiles 同时还喂着
// structural diff 与 RFC-098 的 preDirty 基线，把一个 submodule 边界情形变成
// exception 会一次带崩三条不相干的链路。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitChangedFiles, runGit } from '@/util/git'

const created: string[] = []
let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-gd-cfg-'))

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

async function initRepo(dir: string, seed: Record<string, string>): Promise<void> {
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  for (const [p, c] of Object.entries(seed)) writeFileSync(join(dir, p), c)
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
}

async function commitIn(dir: string, msg: string): Promise<void> {
  await runGit(dir, ['add', '-A'])
  await runGit(dir, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', msg])
}

async function parentWithSubmodule(): Promise<{ parent: string; baseline: string }> {
  const sub = tmp('aw-rfc210-gd-sub-')
  await initRepo(sub, { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' })
  const parent = tmp('aw-rfc210-gd-parent-')
  await initRepo(parent, { 'README.md': 'root\n' })
  await runGit(parent, ['submodule', 'add', '-q', sub, 'vendor'])
  await runGit(parent, ['commit', '-q', '-m', 'add submodule'])
  await runGit(parent, ['submodule', 'update', '--init', '-q'])
  const baseline = (await runGit(parent, ['rev-parse', 'HEAD'])).stdout.trim()
  return { parent, baseline }
}

describe('RFC-210 git_diff submodule path expansion', () => {
  test('a submodule expands into the files that changed inside it', async () => {
    const { parent, baseline } = await parentWithSubmodule()
    const vendor = join(parent, 'vendor')
    writeFileSync(join(vendor, 'a.txt'), 'a2\n')
    writeFileSync(join(vendor, 'c.txt'), 'c2\n')
    await commitIn(vendor, 'node touched two files')

    const changed = await gitChangedFiles(parent, baseline)
    // The bare directory must NOT survive — that is what made a whole submodule
    // collapse into one shard pointing at a folder.
    expect(changed).not.toContain('vendor')
    expect(changed).toContain('vendor/a.txt')
    expect(changed).toContain('vendor/c.txt')
    expect(changed).not.toContain('vendor/b.txt') // untouched
  }, 120_000)

  test('parent-level files still come through untouched', async () => {
    const { parent, baseline } = await parentWithSubmodule()
    writeFileSync(join(parent, 'README.md'), 'edited\n')
    writeFileSync(join(parent, 'brand-new.txt'), 'new\n')
    writeFileSync(join(parent, 'vendor', 'a.txt'), 'a2\n')
    await commitIn(join(parent, 'vendor'), 'sub bump')

    const changed = await gitChangedFiles(parent, baseline)
    expect(changed).toContain('README.md')
    expect(changed).toContain('brand-new.txt') // untracked still listed
    expect(changed).toContain('vendor/a.txt')
  }, 120_000)

  test('a submodule whose gitlink never moved contributes nothing', async () => {
    const { parent, baseline } = await parentWithSubmodule()
    writeFileSync(join(parent, 'README.md'), 'only parent\n')

    const changed = await gitChangedFiles(parent, baseline)
    expect(changed).toEqual(['README.md'])
  }, 120_000)

  test('a plain directory named like a path is never mistaken for a submodule', async () => {
    // `rev-parse <commit>:<dir>` exits 0 for a directory and returns a TREE sha;
    // using it as a diff endpoint inside a "submodule" would fail with
    // "bad object". The type check is what prevents that.
    const repo = tmp('aw-rfc210-gd-plain-')
    await initRepo(repo, { 'README.md': 'root\n' })
    mkdirSync(join(repo, 'libs'))
    writeFileSync(join(repo, 'libs', 'x.txt'), 'x1\n')
    await commitIn(repo, 'add dir')
    const baseline = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    writeFileSync(join(repo, 'libs', 'x.txt'), 'x2\n')

    const changed = await gitChangedFiles(repo, baseline)
    expect(changed).toEqual(['libs/x.txt'])
  }, 120_000)

  test('a repo without .gitmodules takes the zero-extra-process path', async () => {
    const repo = tmp('aw-rfc210-gd-nosub-')
    await initRepo(repo, { 'f.txt': 'v1\n' })
    const baseline = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    writeFileSync(join(repo, 'f.txt'), 'v2\n')
    writeFileSync(join(repo, 'g.txt'), 'new\n')

    const changed = await gitChangedFiles(repo, baseline)
    expect(changed.sort()).toEqual(['f.txt', 'g.txt'])
  }, 120_000)
})
