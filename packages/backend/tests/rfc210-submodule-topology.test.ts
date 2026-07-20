// RFC-210 T1/T7/T12 — submodule 拓扑解析、ref 命名安全、argv 字节基线。
//
// 为什么这些测试存在（三条都锁住设计门实测出的真实故障，不是假想）：
//
//  1. **ref 名不得内嵌 subPath**（design.md §1.1.1）。`refs/…/vendor` 与
//     `refs/…/vendor/inner` 在 git 里互为目录/文件，第二条 `update-ref` 直接
//     exit 128；含空格的路径则被 `refusing to update ref with bad name` 拒绝。
//     任意 ≥2 层嵌套都会命中——而嵌套正是 RFC-210 G3 的核心用例。一旦有人
//     "简化"掉 subSlug 改回拼路径，`refNamesSurviveNesting` 会立刻变红。
//
//  2. **argv 字节基线**（AC-10/AC-12）。RFC-210 给 syncSubmodules 加了两个可选
//     flag。没传时 argv 必须与 RFC-210 之前逐字节一致，否则每个不含 submodule
//     的仓（绝大多数）都会平白多出 git 进程。
//
//  3. **`submodule status` 解析的四种边界**：未初始化行没有 ` (describe)` 后缀、
//     路径可含空格、嵌套路径带父前缀、冲突行 flag 为 'U'。解析器把 headSha 当成
//     "工作区 HEAD" 而非 index gitlink —— 两者在节点提交进子仓后必然不同，
//     这正是本 RFC 的主场景。

import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  bottomUp,
  listSubmodules,
  poolRefName,
  subSlug,
  syncSubmodules,
  usableSubmodules,
  worktreeRefName,
  type SubmoduleEntry,
} from '@/services/gitSubmodule'

/** Minimal runGit stub: canned stdout for the status probe, argv recorder for the rest. */
function stubGit(stdout: string, exitCode = 0) {
  const calls: string[][] = []
  const impl = async (_dir: string, args: string[]) => {
    calls.push(args)
    return { exitCode, stdout, stderr: '' }
  }
  return { calls, impl: impl as never }
}

function runCli(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' })
    p.on('close', (code) => resolve(code ?? 1))
    p.on('error', () => resolve(1))
  })
}

describe('RFC-210 listSubmodules parsing', () => {
  test('parses flag / sha / path, and treats sha as working-tree HEAD', async () => {
    const { impl } = stubGit(
      ' 1111111111111111111111111111111111111111 vendor (heads/main)\n' +
        '+2222222222222222222222222222222222222222 vendor/inner (heads/main-1-g222)\n',
    )
    const subs = await listSubmodules('/wt', { runGitImpl: impl })
    expect(subs).toEqual([
      { path: 'vendor', headSha: '1'.repeat(40), flag: ' ', pathDepth: 1 },
      { path: 'vendor/inner', headSha: '2'.repeat(40), flag: '+', pathDepth: 2 },
    ] satisfies SubmoduleEntry[])
  })

  test('uninitialized rows have no describe suffix and keep flag "-"', async () => {
    const { impl } = stubGit('-3333333333333333333333333333333333333333 vendor\n')
    const subs = await listSubmodules('/wt', { runGitImpl: impl })
    expect(subs).toHaveLength(1)
    expect(subs[0]?.flag).toBe('-')
    expect(subs[0]?.path).toBe('vendor')
  })

  test('paths containing spaces survive describe stripping', async () => {
    const { impl } = stubGit(
      ' 4444444444444444444444444444444444444444 dir with space (heads/main)\n' +
        '-5555555555555555555555555555555555555555 another dir\n',
    )
    const subs = await listSubmodules('/wt', { runGitImpl: impl })
    expect(subs.map((s) => s.path)).toEqual(['dir with space', 'another dir'])
  })

  test('conflicted rows surface flag U', async () => {
    const { impl } = stubGit('U6666666666666666666666666666666666666666 vendor (heads/main)\n')
    expect((await listSubmodules('/wt', { runGitImpl: impl }))[0]?.flag).toBe('U')
  })

  test('non-zero exit and empty output both yield [] (never throws)', async () => {
    const bad = stubGit('fatal: not a git repository', 128)
    expect(await listSubmodules('/wt', { runGitImpl: bad.impl })).toEqual([])
    const empty = stubGit('')
    expect(await listSubmodules('/wt', { runGitImpl: empty.impl })).toEqual([])
  })

  test('usableSubmodules drops uninitialized entries', async () => {
    const { impl } = stubGit(
      ' 1111111111111111111111111111111111111111 ok (heads/main)\n' +
        '-2222222222222222222222222222222222222222 gone\n',
    )
    const subs = await listSubmodules('/wt', { runGitImpl: impl })
    expect(usableSubmodules(subs).map((s) => s.path)).toEqual(['ok'])
  })

  test('bottomUp orders deepest-first so a child bump is visible to its parent', () => {
    const entries = [
      { path: 'a', headSha: 'x', flag: ' ', pathDepth: 1 },
      { path: 'a/b/c', headSha: 'x', flag: ' ', pathDepth: 3 },
      { path: 'a/b', headSha: 'x', flag: ' ', pathDepth: 2 },
    ] satisfies SubmoduleEntry[]
    expect(bottomUp(entries).map((e) => e.path)).toEqual(['a/b/c', 'a/b', 'a'])
  })
})

describe('RFC-210 ref naming safety', () => {
  test('subSlug is a fixed-length hex token, stable per path', () => {
    expect(subSlug('vendor')).toMatch(/^[0-9a-f]{16}$/)
    expect(subSlug('vendor')).toBe(subSlug('vendor'))
    expect(subSlug('vendor')).not.toBe(subSlug('vendor/inner'))
  })

  test('refNamesSurviveNesting: parent and child refs do not collide as dir/file', () => {
    // The naive `refs/…/<subPath>` form makes these two互为 directory/file and the
    // second update-ref fails with exit 128 (measured on git 2.50.1).
    const parent = poolRefName('T1', 'N1', 'vendor')
    const child = poolRefName('T1', 'N1', 'vendor/inner')
    expect(parent).not.toBe(child)
    expect(child.startsWith(`${parent}/`)).toBe(false)
    expect(parent.startsWith(`${child}/`)).toBe(false)
    const wtParent = worktreeRefName('T1', 'vendor')
    const wtChild = worktreeRefName('T1', 'vendor/inner')
    expect(wtChild.startsWith(`${wtParent}/`)).toBe(false)
  })

  test('ref names pass git check-ref-format for hostile paths', async () => {
    const hostile = ['vendor', 'vendor/inner', 'dir with space', 'weird.lock', '.hidden', 'a~b^c:d']
    for (const p of hostile) {
      for (const ref of [poolRefName('T1', 'N1', p), worktreeRefName('T1', p)]) {
        expect(await runCli('git', ['check-ref-format', ref])).toBe(0)
      }
    }
  })

  test('pool ref is node-scoped, worktree ref is not', () => {
    // Node scope prevents two concurrent nodes from clobbering each other's anchor;
    // the worktree-scoped ref must outlive any single node (design.md §1.1.2).
    expect(poolRefName('T1', 'N1', 'v')).not.toBe(poolRefName('T1', 'N2', 'v'))
    expect(worktreeRefName('T1', 'v')).toBe(worktreeRefName('T1', 'v'))
  })
})

describe('RFC-210 syncSubmodules argv byte baseline', () => {
  const base = { mode: 'always' as const, jobs: 1 }

  test('no new options ⟹ argv identical to pre-RFC-210', async () => {
    const { calls, impl } = stubGit('')
    await syncSubmodules('/repo', { ...base, runGitImpl: impl })
    expect(calls).toEqual([
      ['submodule', 'sync', '--recursive'],
      ['submodule', 'update', '--init', '--recursive'],
    ])
  })

  test('jobs > 1 still appends --jobs last', async () => {
    const { calls, impl } = stubGit('')
    await syncSubmodules('/repo', { ...base, jobs: 8, runGitImpl: impl })
    expect(calls[1]).toEqual(['submodule', 'update', '--init', '--recursive', '--jobs', '8'])
  })

  test('remote / referencePool are appended before --jobs', async () => {
    const { calls, impl } = stubGit('')
    await syncSubmodules('/repo', {
      ...base,
      jobs: 4,
      remote: true,
      referencePool: '/pool',
      runGitImpl: impl,
    })
    expect(calls[1]).toEqual([
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--remote',
      '--reference',
      '/pool',
      '--jobs',
      '4',
    ])
  })

  test("mode 'never' spawns zero git processes (AC-11)", async () => {
    const { calls, impl } = stubGit('')
    const r = await syncSubmodules('/repo', { mode: 'never', jobs: 4, runGitImpl: impl })
    expect(calls).toEqual([])
    expect(r.ok).toBe(true)
  })
})
