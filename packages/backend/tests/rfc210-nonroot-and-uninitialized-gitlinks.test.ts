// RFC-210 后续修正 — `checkoutMergedGitlinks` 的两条 P0，红→绿回归锁。
//
// 两条都是对抗审计用真 git fixture 实测出来的，两条都不会被既有的
// `rfc210-materialize-gitlink-regression.test.ts` 抓到：那个文件（以及全部
// rfc210-* 测试）只用**根层**的 `vendor`，且子仓永远是初始化好的。
//
//  1. **非根层子仓的合并结果被静默丢弃。** 第⑥步用的是不带 `-r` 的
//     `ls-tree`，只列根层；`libs/vendor` 在根层的形态是 `040000 tree libs`，
//     被 `parts[1] !== 'commit'` 直接跳过，于是它的 gitlink 永远没被 checkout。
//     节点在里面的提交消失，而 merge-back 仍然报 clean —— 正是本 RFC 立项要
//     修的那个 bug，当时只修到根目录一层。
//
//  2. **未初始化 / 无 .gitmodules 的 gitlink 让每次 merge-back 抛错。**
//     未初始化的子仓是一个**空目录**而不是不存在的目录（git 为 gitlink 建的），
//     所以 `existsSync(subPath)` 恒真、从来没跳过任何东西。随后
//     `git -C <空目录> checkout` 会向上找到**超级项目**并在那里执行，而超级项目
//     没有这个对象 ⟹ exit 128 `unable to read tree` ⟹ 不匹配脏工作区那条
//     模式 ⟹ 抛 `materialize-failed`。且是在 ①–⑤ 已经改写 canonical 之后抛的，
//     没有回滚。误提交的嵌套 git 仓（`git add .` 的经典事故，压根没有
//     .gitmodules 条目）走的是同一条路径，而节点根本没碰过它。
//
// 判据用 `existsSync(<sub>/.git)` —— `expandSubmodulePaths` 早就在用同一条。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNodeIso,
  mergeBackNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
} from '@/services/nodeIsolation'
import { materializeTree, runGit } from '@/util/git'

const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-np-home-'))
const created: string[] = []

// See the sibling regression file: `file` transport must be allowed through a
// throwaway global config, and it must be set HERE — `bun test` shares one
// process locally (so a sibling file's setting leaks and everything looks
// green) while CI runs --isolate, where each file starts clean.
let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-np-gitcfg-'))

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
  for (const d of created) rmSync(d, { recursive: true, force: true })
  rmSync(appHome, { recursive: true, force: true })
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

async function commitIn(dir: string, msg: string): Promise<string> {
  await runGit(dir, ['add', '-A'])
  await runGit(dir, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', msg])
  return (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}

function canonRepo(dir: string): CanonRepo {
  return { repoPath: dir, worktreePath: dir, worktreeDirName: '', baseBranch: 'main' }
}

/** Canonical worktree whose submodule sits at `libs/vendor`, not at the root. */
async function canonWithNonRootSubmodule(): Promise<string> {
  const sub = tmp('aw-rfc210-np-sub-')
  await initRepo(sub, 'a.txt', 'v1\n')
  const host = tmp('aw-rfc210-np-host-')
  await initRepo(host, 'README.md', 'root\n')
  // A sibling file under the same directory, so `libs` is a real tree that the
  // non-recursive ls-tree would have reported as `040000 tree libs`.
  mkdirSync(join(host, 'libs'), { recursive: true })
  writeFileSync(join(host, 'libs', 'keep.txt'), 'keep\n')
  await runGit(host, ['add', '.'])
  await runGit(host, ['commit', '-q', '-m', 'libs dir'])
  await runGit(host, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    sub,
    'libs/vendor',
  ])
  await runGit(host, ['commit', '-q', '-m', 'add nested-path submodule'])
  const canon = join(tmp('aw-rfc210-np-wt-'), 'canon')
  await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
  await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])
  return canon
}

describe('RFC-210 — submodule below the repo root', () => {
  test('a node commit inside libs/vendor reaches canonical (was silently dropped)', async () => {
    const canon = await canonWithNonRootSubmodule()
    const canonSub = join(canon, 'libs', 'vendor')
    const baseSubHead = (await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()

    const handle = await createNodeIso({
      appHome,
      taskId: 'tnp',
      nodeRunId: 'rnp',
      canonRepos: [canonRepo(canon)],
    })
    const isoSub = join(handle.repos[0]!.isoWorktreePath, 'libs', 'vendor')
    expect(existsSync(isoSub)).toBe(true)

    writeFileSync(join(isoSub, 'a.txt'), 'edited-by-node\n')
    const nodeSubSha = await commitIn(isoSub, 'node edits nested-path submodule')
    expect(nodeSubSha).not.toBe(baseSubHead)

    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))
    expect(res.clean).toBe(true)

    // THE regression. Before `ls-tree -r`, both of these still read the BASE
    // state while merge-back happily reported clean.
    expect((await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(nodeSubSha)
    expect(readFileSync(join(canonSub, 'a.txt'), 'utf8')).toBe('edited-by-node\n')
  }, 120_000)
})

describe('RFC-210 — gitlink with no initialized working tree', () => {
  test('an unfetchable submodule is skipped, not turned into materialize-failed', async () => {
    const host = tmp('aw-rfc210-np-unhost-')
    await initRepo(host, 'README.md', 'root\n')
    // A gitlink whose URL cannot be fetched — deinit'd, moved, credentials
    // gone, an internal host that is not reachable from this machine. Built by
    // hand because that is the only way to get a gitlink that `submodule
    // update --init` (step ④ of materializeTree) genuinely cannot resolve:
    // going through `submodule add` and then just skipping the init does NOT
    // reproduce it — step ④ would happily clone it and by step ⑥ `.git` exists.
    writeFileSync(
      join(host, '.gitmodules'),
      '[submodule "vendor"]\n\tpath = vendor\n\turl = /nonexistent/aw-rfc210-no-such-repo.git\n',
    )
    const orphanSha = '0'.repeat(39) + '1'
    await runGit(host, ['update-index', '--add', '--cacheinfo', `160000,${orphanSha},vendor`])
    await runGit(host, ['add', '.gitmodules'])
    await runGit(host, ['commit', '-q', '-m', 'gitlink pointing at an unfetchable url'])

    const canon = join(tmp('aw-rfc210-np-unwt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
    // What git materializes for such a gitlink is an EMPTY DIRECTORY, so the
    // old `existsSync(subPath)` guard was true and skipped nothing.
    expect(existsSync(join(canon, 'vendor'))).toBe(true)
    expect(existsSync(join(canon, 'vendor', '.git'))).toBe(false)

    const handle = await createNodeIso({
      appHome,
      taskId: 'tun',
      nodeRunId: 'run',
      canonRepos: [canonRepo(canon)],
    })
    // The node only touches a parent file — it never goes near the submodule.
    writeFileSync(join(handle.repos[0]!.isoWorktreePath, 'README.md'), 'parent edited by node\n')

    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))

    // Before the fix this threw
    //   materialize-failed: submodule 'vendor' cannot be moved to <sha>:
    //   fatal: unable to read tree (<sha>)
    // on EVERY merge-back for such a repo — not an edge case, a hard stop — and
    // canonical had already been rewritten by steps ①–⑤ when it threw.
    expect(res.clean).toBe(true)
    expect(readFileSync(join(canon, 'README.md'), 'utf8')).toBe('parent edited by node\n')
  }, 120_000)

  test('a stray committed nested git repo (gitlink, no .gitmodules entry) is left alone', async () => {
    const host = tmp('aw-rfc210-np-strayhost-')
    await initRepo(host, 'README.md', 'root\n')
    // The classic `git add .` accident: a nested repo becomes a gitlink with no
    // .gitmodules entry at all. The platform must not claim ownership of it.
    const nested = join(host, 'nestedrepo')
    mkdirSync(nested, { recursive: true })
    await initRepo(nested, 'inner.txt', 'inner\n')
    await runGit(host, ['add', 'nestedrepo'])
    await runGit(host, ['commit', '-q', '-m', 'oops, committed a nested repo'])
    expect(existsSync(join(host, '.gitmodules'))).toBe(false)

    const canon = join(tmp('aw-rfc210-np-straywt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])

    const handle = await createNodeIso({
      appHome,
      taskId: 'tstray',
      nodeRunId: 'rstray',
      canonRepos: [canonRepo(canon)],
    })
    writeFileSync(join(handle.repos[0]!.isoWorktreePath, 'README.md'), 'parent edited\n')

    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))
    expect(res.clean).toBe(true)
    expect(readFileSync(join(canon, 'README.md'), 'utf8')).toBe('parent edited\n')
  }, 120_000)

  test('materialize leaves an undeclared INITIALIZED gitlink untouched even when the tree records an older sha', async () => {
    // Codex review round 8, P1: an INITIALIZED stray nested repo (has `.git`,
    // no `.gitmodules` entry) whose working HEAD is AHEAD of the gitlink the
    // materialized tree records, with the recorded commit present in its ODB.
    // Round 7's HEAD-based fast path saw `actual !== sha` and fell through to
    // `checkout --detach sha`, which — because the older commit IS reachable —
    // SUCCEEDS and silently rewinds user-owned work in a repo the platform
    // never claimed. The materialize must skip an undeclared gitlink whole.
    //
    // The nested repo must be a REAL initialized repo in the worktree sharing
    // the recorded commit: `git worktree add` leaves an undeclared embedded
    // repo as an EMPTY dir (no `.git`), which the uninitialized branch already
    // guards — the vulnerable path is only reached once the user has actually
    // populated it (clone / manual init), which is exactly this fixture.
    const nestedSrc = tmp('aw-rfc210-np-strsrc-')
    await initRepo(nestedSrc, 'inner.txt', 'v1\n')
    const c0 = (await runGit(nestedSrc, ['rev-parse', 'HEAD'])).stdout.trim()

    const host = tmp('aw-rfc210-np-strinit-host-')
    await initRepo(host, 'README.md', 'root\n')
    // Record the nested repo as a gitlink at c0 — a `git add .` accident, no
    // `.gitmodules` entry.
    await runGit(host, ['update-index', '--add', '--cacheinfo', `160000,${c0},nestedrepo`])
    await runGit(host, ['commit', '-q', '-m', 'oops, committed a nested repo at c0'])
    expect(existsSync(join(host, '.gitmodules'))).toBe(false)
    const headTree = (await runGit(host, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const taskBaseHead = (await runGit(host, ['rev-parse', 'HEAD'])).stdout.trim()

    const canonRoot = tmp('aw-rfc210-np-strinit-wt-')
    const canon = join(canonRoot, 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
    // The user actually initializes + advances the embedded repo (clone shares
    // c0's objects, so `checkout --detach c0` WOULD succeed and rewind).
    rmSync(join(canon, 'nestedrepo'), { recursive: true, force: true })
    await runGit(canonRoot, ['clone', '-q', nestedSrc, join(canon, 'nestedrepo')])
    const canonNested = join(canon, 'nestedrepo')
    writeFileSync(join(canonNested, 'inner.txt'), 'user-precious-work\n')
    const userSha = await commitIn(canonNested, 'user work in stray repo')
    expect(userSha).not.toBe(c0)
    expect(existsSync(join(canonNested, '.git'))).toBe(true)
    // c0 IS reachable from the initialized nested repo — the rewind is possible.
    expect((await runGit(canonNested, ['cat-file', '-e', c0])).exitCode).toBe(0)

    // Materialize a tree that STILL records c0 for the stray (the HEAD tree) —
    // exactly what a merge result that never touched it looks like.
    await materializeTree(canon, {
      mergedTree: headTree,
      canonCurrentTree: headTree,
      taskBaseHead,
    })

    // The stray repo must stay at the USER's HEAD, its work intact — never
    // rewound to the gitlink the tree records.
    expect((await runGit(canonNested, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(userSha)
    expect(readFileSync(join(canonNested, 'inner.txt'), 'utf8')).toBe('user-precious-work\n')
  }, 120_000)

  test('an UNPARSEABLE .gitmodules fails loud instead of silently skipping a managed submodule', async () => {
    // Codex review round 9, P1: `submoduleNameForPath` returned null both for a
    // genuinely-absent entry AND for a `.gitmodules` git cannot parse. Round
    // 8's stray-skip therefore misclassified a MANAGED submodule (whose config
    // is merely corrupt) as stray and silently dropped its update — merge-back
    // would report clean while the child stayed at the wrong base. The
    // classification must fail loud on a parse error, not skip.
    const sub = tmp('aw-rfc210-np-badcfg-sub-')
    await initRepo(sub, 'a.txt', 'v1\n')
    const host = tmp('aw-rfc210-np-badcfg-host-')
    await initRepo(host, 'README.md', 'root\n')
    await runGit(host, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor',
    ])
    await runGit(host, ['commit', '-q', '-m', 'add managed submodule'])
    const canon = join(tmp('aw-rfc210-np-badcfg-wt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
    await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])
    expect(existsSync(join(canon, 'vendor', '.git'))).toBe(true)

    // The COMMITTED `.gitmodules` is corrupt (bad section header) — this is what
    // materialize's step ③ restores into the worktree, so by step ⑥ the config
    // git reads is unparseable (`git config --get-regexp` exits 128). Committing
    // it here puts the corrupt blob in the tree materialize replays.
    writeFileSync(join(canon, '.gitmodules'), '[submodule "vendor"\n\tpath = vendor\n')
    await runGit(canon, ['add', '.gitmodules'])
    await runGit(canon, [
      '-c',
      'user.email=t@e.com',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '-m',
      'corrupt .gitmodules',
    ])
    const headTree = (await runGit(canon, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const taskBaseHead = (await runGit(canon, ['rev-parse', 'HEAD'])).stdout.trim()

    // The submodule is MANAGED and initialized; classification must refuse
    // rather than silently treat the corrupt-config path as stray and skip it.
    await expect(
      materializeTree(canon, { mergedTree: headTree, canonCurrentTree: headTree, taskBaseHead }),
    ).rejects.toThrow(/could not be parsed to classify ownership/)
  }, 120_000)
})
