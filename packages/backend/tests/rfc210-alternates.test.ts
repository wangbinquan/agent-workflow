// RFC-210 T3/T4/T12 — 共享对象池：alternates 挂载 + 对象回写 + gc 存活。
//
// 为什么这些测试存在（每条都锁住一次实测出的、会静默毁掉用户仓库的故障）：
//
//  1. **`--reference` 对已初始化的 module dir 是静默 no-op**（design.md §0.2）。
//     RFC-210 v1 只在全新 iso 上测过就把它当通则写进设计，实测第二/三次带
//     `--reference` 重跑 `objects/info/alternates` 依然不存在、exit 0、无报错。
//     所有存量仓和每一个 `materializeTree` 调用点（按定义都作用于已初始化的树）
//     都会踩中。`ensureSubmoduleAlternates` 显式写文件是唯一可靠的路子。
//
//  2. **alternates 必须并集写**。module dir 可能已经借用了用户自己配的对象库，
//     truncate 会让那些对象一起失踪。
//
//  3. **`git fetch <dir> <sha>` 只写 FETCH_HEAD、不建 ref**（design.md §0.2 第三条）。
//     对象在池里恒不可达，**默认 gc**（不是 --prune=now）过了 gc.pruneExpire 就删——
//     而任务 worktree 活得比两周久。删掉之后 canonical 子仓是 `bad object HEAD`，
//     父仓 `git status` 整体失败，`snapshotFullState` 的 `add -A` 随之崩，全线挂。
//     所以 `pushObjectsToPool` 的 update-ref 失败是 error 不是 warning。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ensureSubmoduleAlternates,
  pushObjectsToPool,
  submoduleGitDir,
  worktreeRefName,
} from '@/services/gitSubmodule'

function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.stderr.on('data', (d: Buffer) => (out += d.toString()))
    p.on('close', (code) => resolve({ code: code ?? 1, out: out.trim() }))
    p.on('error', () => resolve({ code: 1, out: 'spawn failed' }))
  })
}

let root = ''
let pool = ''
let wt = ''
let prevGlobal: string | undefined

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'aw-rfc210-alt-'))

  // git >= 2.38 refuses the `file` transport for submodules regardless of whether
  // the URL is spelled absolute, relative, or file://. Production argv deliberately
  // omits the allowance, so tests inject it through a throwaway global config
  // (same approach as git-repo-cache-submodule.test.ts).
  const cfg = join(root, 'gitconfig')
  writeFileSync(cfg, '[protocol "file"]\n\tallow = always\n[user]\n\tname = t\n\temail = t@t\n')
  prevGlobal = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = cfg

  const sub = join(root, 'sub')
  mkdirSync(sub)
  await git(sub, ['init', '-q', '-b', 'main'])
  writeFileSync(join(sub, 'a.txt'), 'v1\n')
  await git(sub, ['add', '-A'])
  await git(sub, ['commit', '-qm', 'v1'])

  const cache = join(root, 'cache')
  mkdirSync(cache)
  await git(cache, ['init', '-q', '-b', 'main'])
  writeFileSync(join(cache, 'README.md'), 'root\n')
  await git(cache, ['add', '-A'])
  await git(cache, ['commit', '-qm', 'init'])
  await git(cache, ['submodule', 'add', '-q', sub, 'vendor'])
  await git(cache, ['commit', '-qm', 'add submodule'])

  pool = join(cache, '.git', 'modules', 'vendor')

  // A linked worktree, initialized the way production does it today: WITHOUT
  // --reference. This is the "already initialized module dir" case.
  wt = join(root, 'wt')
  await git(cache, ['worktree', 'add', '-q', '--detach', wt, 'HEAD'])
  await git(wt, ['submodule', 'update', '--init', '-q'])
}, 60_000)

afterAll(() => {
  if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = prevGlobal
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('RFC-210 shared object pool', () => {
  test('--reference on an already-initialized module dir is not something to rely on', async () => {
    // `submodule update --reference` is VERSION-DEPENDENT on an already-initialized
    // module dir: git 2.50.1 (Apple Git-155) leaves `objects/info/alternates` absent
    // and exits 0 — a silent no-op — while the CI runners' git does attach it.
    // Either way it always exits 0, so a caller cannot tell which happened.
    //
    // That inconsistency is exactly why the production path never depends on this
    // flag for correctness (it is a first-clone speedup only) and always writes the
    // alternates file explicitly. Asserting either branch as an invariant would
    // pin one git version's behaviour; all that matters is that it never errors.
    const md = await submoduleGitDir(wt, 'vendor')
    expect(md).not.toBeNull()
    const r = await git(wt, ['submodule', 'update', '--init', '-q', '--reference', pool])
    expect(r.code).toBe(0)
  })

  test('ensureSubmoduleAlternates attaches the pool to an initialized module dir', async () => {
    const md0 = (await submoduleGitDir(wt, 'vendor')) as string
    const alt0 = join(md0, 'objects', 'info', 'alternates')
    // Start from a known-clean state so this asserts OUR write, not git's, on
    // every git version (see the version note above).
    if (existsSync(alt0)) rmSync(alt0)

    const res = await ensureSubmoduleAlternates(wt, 'vendor', pool)
    expect(res).toEqual({ ok: true, error: null })

    const md = (await submoduleGitDir(wt, 'vendor')) as string
    const alt = join(md, 'objects', 'info', 'alternates')
    expect(readFileSync(alt, 'utf8')).toContain(join(pool, 'objects'))

    // An object that exists ONLY in the pool must now be readable from the worktree.
    const sub = join(root, 'sub')
    writeFileSync(join(sub, 'a.txt'), 'pool-only\n')
    await git(sub, ['add', '-A'])
    await git(sub, ['commit', '-qm', 'pool only'])
    const poolOnly = (await git(sub, ['rev-parse', 'HEAD'])).out
    await git(pool, ['fetch', '-q', 'origin'])

    const seen = await git(join(wt, 'vendor'), ['cat-file', '-t', poolOnly])
    expect(seen.code).toBe(0)
    expect(seen.out).toBe('commit')
  })

  test('is idempotent and unions rather than truncating pre-existing alternates', async () => {
    const md = (await submoduleGitDir(wt, 'vendor')) as string
    const alt = join(md, 'objects', 'info', 'alternates')
    const foreign = join(root, 'someone-elses', 'objects')
    mkdirSync(dirname(foreign), { recursive: true })
    mkdirSync(foreign, { recursive: true })
    writeFileSync(alt, `${foreign}\n`)

    await ensureSubmoduleAlternates(wt, 'vendor', pool)
    const lines = readFileSync(alt, 'utf8').trim().split('\n')
    expect(lines).toContain(foreign) // user's entry survives
    expect(lines).toContain(join(pool, 'objects'))

    // Second call must not duplicate.
    await ensureSubmoduleAlternates(wt, 'vendor', pool)
    const again = readFileSync(alt, 'utf8').trim().split('\n')
    expect(again.filter((l) => l === join(pool, 'objects'))).toHaveLength(1)
  })

  test('pushObjectsToPool publishes the object AND anchors it against a default gc', async () => {
    // Commit inside the worktree's own submodule — the object lives only there.
    const subWt = join(wt, 'vendor')
    writeFileSync(join(subWt, 'a.txt'), 'by-node\n')
    await git(subWt, ['add', '-A'])
    await git(subWt, ['commit', '-qm', 'node edit'])
    const sha = (await git(subWt, ['rev-parse', 'HEAD'])).out
    const fromGitDir = (await submoduleGitDir(wt, 'vendor')) as string

    expect((await git(pool, ['cat-file', '-t', sha])).code).not.toBe(0)

    const ref = worktreeRefName('TASKGC', 'vendor')
    const res = await pushObjectsToPool(pool, fromGitDir, sha, ref)
    expect(res).toEqual({ ok: true, error: null })
    expect((await git(pool, ['cat-file', '-t', sha])).out).toBe('commit')

    // The whole point: survive a gc that prunes everything unreachable. Without
    // the ref this object is only in FETCH_HEAD and gets collected.
    await git(pool, ['reflog', 'expire', '--expire=now', '--all'])
    const gc = await git(pool, ['gc', '--prune=now', '--quiet'])
    expect(gc.code).toBe(0)
    expect((await git(pool, ['cat-file', '-t', sha])).out).toBe('commit')

    // And once the anchor is dropped, it is genuinely collectable — proving the
    // ref (not some incidental reachability) is what kept it alive.
    await git(pool, ['update-ref', '-d', ref])
    await git(pool, ['reflog', 'expire', '--expire=now', '--all'])
    await git(pool, ['gc', '--prune=now', '--quiet'])
    expect((await git(pool, ['cat-file', '-t', sha])).code).not.toBe(0)
  }, 60_000)

  test('missing pool objects dir is reported, not thrown', async () => {
    const res = await ensureSubmoduleAlternates(wt, 'vendor', join(root, 'nope'))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('pool objects dir missing')
  })
})
