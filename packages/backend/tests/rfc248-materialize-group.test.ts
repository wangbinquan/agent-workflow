// RFC-248 PR-3 T21 —— `materializeGroupSpace` 的端到端物化测试（真 git）。
//
// 这份文件是 `design/RFC-248-repo-groups/materialize-prototype.sh` 的完整
// TypeScript 化。那份 shell 原型跑的布局刻意覆盖了每一种成员形态，这里逐条
// 断言同一批不变量（proposal E8）：
//
//   ''              → app          可写，挂根
//   vendor/sdk      → sdk          只读，嵌在 app 工作树里
//   vendor/sdk/ext  → ext          可写，三层嵌套（嵌在 sdk 里）
//   site/docs       → docs@guides  可写，sparse 子目录挂载，嵌在 app 里
//   compare/main    → app（第二份）可写，同仓复用 ⇒ 分支带序号
//
// 最关键的一条：**单成员挂根必须落回单仓分支**（AC-10）。「单仓是多仓的特例」
// 不能只是说法——路径、`tasks.*` 列、cwd 都要与今天字节级一致，否则每一个现存
// 单仓任务的行为都被这个 RFC 改掉了。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { createRepoGroup } from '../src/services/repoGroup'
import { materializeSpace } from '../src/services/task'
import { nonInteractiveGitEnv } from '../src/util/git'
import { DomainError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let tmp = ''
let db: DbClient
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aw-rfc248-mat-'))
  db = createInMemoryDb(MIGRATIONS)
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

/** 造一个源仓并登记成 cached_repos 行，返回 { id, path }。 */
function seedRepo(name: string, files: Record<string, string>): { id: string; path: string } {
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

  const id = ulid()
  const now = Date.now()
  db.insert(cachedRepos)
    .values({
      id,
      urlHash: `${name}00000000`.slice(0, 8),
      url: `file://${dir}`,
      urlRedacted: `file://${dir}`,
      localPath: dir,
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    })
    .run()
  return { id, path: dir }
}

interface MemberSpec {
  cachedRepoId: string
  mountPath: string
  ref?: string
  subdir?: string
  readonly?: boolean
}

async function makeGroup(name: string, members: MemberSpec[]): Promise<string> {
  const g = await createRepoGroup(
    { db },
    {
      name,
      description: '',
      members: members.map((m) => ({
        kind: 'repo' as const,
        cachedRepoId: m.cachedRepoId,
        ref: m.ref ?? '',
        subdir: m.subdir ?? '',
        mountPath: m.mountPath,
        readonly: m.readonly ?? false,
      })),
    },
    null,
  )
  return g.id
}

function materialize(repoGroupId: string) {
  return materializeSpace(
    // 只需要 materializeSpace 读到的那几个字段；其余由 StartTaskSchema 在真实
    // 路径上补齐，这里直接构造以免拖进整条启动链。
    { workflowId: 'w', name: 't', inputs: {}, repoGroupId } as never,
    { db } as never,
    join(tmp, 'home'),
  )
}

function lsVisible(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n !== '.git')
    .sort()
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof DomainError) return err.code
    return `unexpected:${String(err)}`
  }
  return 'no-throw'
}

describe('materializeGroupSpace —— 原型布局的完整复现（proposal E8）', () => {
  test('五个 worktree：挂根 + 只读 + 三层嵌套 + sparse + 同仓两份', async () => {
    const app = seedRepo('app', { 'src/main.ts': 'orig', 'package.json': '{}' })
    const sdk = seedRepo('sdk', { 'lib/sdk.ts': 'orig', 'README.md': 'r' })
    const ext = seedRepo('ext', { 'ext/plug.ts': 'orig' })
    const docs = seedRepo('docs', {
      'guides/g1.md': 'g1',
      'api/a.md': 'a',
      'README.md': 'r',
    })
    const gid = await makeGroup('全栈', [
      { cachedRepoId: app.id, mountPath: '' },
      { cachedRepoId: sdk.id, mountPath: 'vendor/sdk', readonly: true },
      { cachedRepoId: ext.id, mountPath: 'vendor/sdk/ext' },
      { cachedRepoId: docs.id, mountPath: 'site/docs', subdir: 'guides' },
      { cachedRepoId: app.id, mountPath: 'compare/main' },
    ])

    const space = await materialize(gid)
    expect(space.kind).toBe('group')
    expect(space.earlyError).toBeNull()
    expect(space.repos).toHaveLength(5)

    const byMount = new Map(space.repos.map((r) => [r.mountPath, r]))
    // ① 物化顺序按挂载深度升序（外层必须先于内层建），**同深度保持展平序**
    // ——即用户在组里排的成员顺序，不是字典序。这样 repo_index 稳定可预期，
    // 用户在组编辑器里看到的次序与任务详情里的一致。
    expect(space.repos.map((r) => r.mountPath)).toEqual([
      '', //              深度 0
      'vendor/sdk', //    深度 2，成员序 #1
      'site/docs', //     深度 2，成员序 #3
      'compare/main', //  深度 2，成员序 #4
      'vendor/sdk/ext', // 深度 3
    ])

    // ② 挂根的仓：cwd 就是它的 worktree。
    expect(byMount.get('')!.worktreePath).toBe(space.worktreePath)

    // ③ 每个仓的 status 全干净 —— 嵌套仓与上传目录都被排除了。
    for (const r of space.repos) {
      expect(git(r.worktreePath, 'status', '--porcelain').trim()).toBe('')
    }

    // ④ sparse 成员挂点只含目标子目录。
    expect(lsVisible(byMount.get('site/docs')!.worktreePath)).toEqual(['guides'])

    // ⑤ 同一个源仓两份 ⇒ 分支带序号，否则第二个 worktree add 会撞。
    expect(byMount.get('')!.branch).not.toBe(byMount.get('compare/main')!.branch)
    expect(byMount.get('compare/main')!.branch).toMatch(/-2$/)

    // ⑥ 有子挂载点的仓拿到预置 commit，且 base_commit 指向它；叶子仓没有。
    expect(byMount.get('')!.gitignoreCommit).not.toBeNull()
    expect(byMount.get('')!.baseCommit).toBe(byMount.get('')!.gitignoreCommit)
    expect(byMount.get('vendor/sdk')!.gitignoreCommit).not.toBeNull() // 只读也造（D21）
    expect(byMount.get('vendor/sdk/ext')!.gitignoreCommit).toBeNull() // 叶子
    expect(byMount.get('compare/main')!.gitignoreCommit).toBeNull()

    // ⑦ 只读标记落到了记录上。
    expect(byMount.get('vendor/sdk')!.readonly).toBe(true)
    expect(byMount.get('')!.readonly).toBe(false)
  })

  test('worker 改动后：每个仓的 diff 只含自己的改动，互不串味', async () => {
    const app = seedRepo('app2', { 'src/main.ts': 'orig' })
    const sdk = seedRepo('sdk2', { 'lib/sdk.ts': 'orig' })
    const gid = await makeGroup('g', [
      { cachedRepoId: app.id, mountPath: '' },
      { cachedRepoId: sdk.id, mountPath: 'vendor/sdk' },
    ])
    const space = await materialize(gid)
    const byMount = new Map(space.repos.map((r) => [r.mountPath, r]))
    const root = byMount.get('')!
    const nested = byMount.get('vendor/sdk')!

    writeFileSync(join(root.worktreePath, 'src/main.ts'), 'worker')
    writeFileSync(join(root.worktreePath, 'newfile.md'), 'new')
    writeFileSync(join(nested.worktreePath, 'lib/sdk.ts'), 'worker')

    const rootTracked = git(root.worktreePath, 'diff', root.baseCommit!, '--name-only')
      .trim()
      .split('\n')
      .filter(Boolean)
    // 根仓的 diff 里**没有** .gitignore（它在 base_commit 里）、没有嵌套挂载点。
    expect(rootTracked).toEqual(['src/main.ts'])
    // status 同时含已跟踪改动与新文件；关键是**没有** vendor/ 与 .gitignore。
    const rootStatus = git(root.worktreePath, 'status', '--porcelain')
    expect(rootStatus).toContain(' M src/main.ts')
    expect(rootStatus).toContain('?? newfile.md')
    expect(rootStatus).not.toContain('vendor')
    expect(rootStatus).not.toContain('.gitignore')

    const nestedTracked = git(nested.worktreePath, 'diff', nested.baseCommit!, '--name-only')
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(nestedTracked).toEqual(['lib/sdk.ts'])
  })

  test('对可写仓跑 add -A 零 embedded-repo 告警，且不吞嵌套仓', async () => {
    const app = seedRepo('app3', { 'f.txt': 'f' })
    const sdk = seedRepo('sdk3', { 'g.txt': 'g' })
    const gid = await makeGroup('g', [
      { cachedRepoId: app.id, mountPath: '' },
      { cachedRepoId: sdk.id, mountPath: 'vendor/sdk' },
    ])
    const space = await materialize(gid)
    const root = space.repos.find((r) => r.mountPath === '')!
    writeFileSync(join(root.worktreePath, 'f.txt'), 'worker')
    git(root.worktreePath, 'add', '-A')
    // 没有 gitlink 进索引（proposal E2 的反面）。
    expect(git(root.worktreePath, 'ls-files', '--stage', 'vendor/sdk').trim()).toBe('')
    expect(git(root.worktreePath, 'diff', '--cached', '--name-only').trim()).toBe('f.txt')
  })

  test('AC-10：单成员挂根落回单仓分支，路径与 kind 与今天字节级一致', async () => {
    // 「单仓是多仓的特例」这条产品判断的实现兑现。若这里走了组物化，每一个现存
    // 单仓任务的 worktree 路径都会从 `worktrees/{slug}/{id}` 变成
    // `worktrees/group/{id}`，`tasks.*` 列与 cwd 全部漂移。
    const app = seedRepo('solo', { 'f.txt': 'f' })
    const gid = await makeGroup('单仓组', [{ cachedRepoId: app.id, mountPath: '' }])
    const space = await materialize(gid)
    expect(space.kind).toBe('single')
    // 单仓布局是 `worktrees/{repoSlug}/{taskId}`——repoSlug 是带哈希前缀的
    // 派生名（`util/git.ts:repoSlug`），所以只断言「不在 group 命名空间下」
    // 且路径形状仍是 slug/taskId 两级。
    expect(space.worktreePath).not.toContain(join('worktrees', 'group'))
    expect(space.worktreePath).toMatch(/worktrees\/[^/]+\/[^/]+$/)
    expect(space.worktreePath).toContain('src-solo')
    expect(space.repos).toHaveLength(1)
    expect(space.repos[0]!.mountPath).toBe('')
    // 单仓没有嵌套子成员 ⇒ 不该有预置 commit。
    expect(space.repos[0]!.gitignoreCommit).toBeNull()
  })

  test('单成员但带 subdir ⇒ 走组物化（单仓分支不支持 sparse）', async () => {
    const docs = seedRepo('docs2', { 'guides/g.md': 'g', 'api/a.md': 'a' })
    const gid = await makeGroup('只要指南', [
      { cachedRepoId: docs.id, mountPath: '', subdir: 'guides' },
    ])
    const space = await materialize(gid)
    expect(space.kind).toBe('group')
    expect(lsVisible(space.worktreePath)).toEqual(['guides'])
  })

  test('没有仓挂根时 cwd 是不属于任何仓的普通父目录', async () => {
    const a = seedRepo('fe', { 'f.txt': 'f' })
    const b = seedRepo('be', { 'g.txt': 'g' })
    const gid = await makeGroup('平铺', [
      { cachedRepoId: a.id, mountPath: 'frontend' },
      { cachedRepoId: b.id, mountPath: 'backend' },
    ])
    const space = await materialize(gid)
    expect(space.kind).toBe('group')
    expect(existsSync(join(space.worktreePath, '.git'))).toBe(false)
    expect(lsVisible(space.worktreePath).sort()).toEqual(['backend', 'frontend'])
  })

  test('H8：容器在选定 ref 上跟踪着挂载点路径 ⇒ 启动期就报 mount-occupied', async () => {
    // 只看工作树会漏掉这种情形（sparse 不删索引里的已跟踪路径）。
    const app = seedRepo('app4', { 'vendor/sdk/keep.txt': 'x', 'f.txt': 'f' })
    const sdk = seedRepo('sdk4', { 'g.txt': 'g' })
    const gid = await makeGroup('冲突组', [
      { cachedRepoId: app.id, mountPath: '' },
      { cachedRepoId: sdk.id, mountPath: 'vendor/sdk' },
    ])
    expect(await codeOfAsync(() => materialize(gid))).toBe('repo-group-mount-occupied')
  })

  test('sparse 子目录在该 ref 上不存在 ⇒ sparse-empty，而不是静默给空目录', async () => {
    const app = seedRepo('app5', { 'f.txt': 'f' })
    const docs = seedRepo('docs3', { 'guides/g.md': 'g' })
    const gid = await makeGroup('空 sparse', [
      { cachedRepoId: app.id, mountPath: '' },
      { cachedRepoId: docs.id, mountPath: 'site', subdir: 'nope' },
    ])
    expect(await codeOfAsync(() => materialize(gid))).toBe('repo-group-sparse-empty')
  })

  test('物化中途失败 ⇒ 已建的 worktree 全部回收，源仓注册表不留悬空', async () => {
    const app = seedRepo('app6', { 'f.txt': 'f' })
    const docs = seedRepo('docs4', { 'guides/g.md': 'g' })
    const gid = await makeGroup('会失败', [
      { cachedRepoId: app.id, mountPath: '' },
      { cachedRepoId: docs.id, mountPath: 'site', subdir: 'nope' }, // 触发 sparse-empty
    ])
    await codeOfAsync(() => materialize(gid))
    // app 的源仓里不该留下任何指向已删目录的 worktree 注册。
    const list = git(app.path, 'worktree', 'list')
    expect(list).not.toContain('prunable')
    expect(list.trim().split('\n')).toHaveLength(1) // 只剩源仓自己
  })

  test('组内 ref 生效——成员按自己声明的分支检出', async () => {
    const app = seedRepo('app7', { 'f.txt': 'main' })
    git(app.path, 'checkout', '-q', '-b', 'release')
    writeFileSync(join(app.path, 'f.txt'), 'release')
    git(app.path, 'add', '-A')
    git(app.path, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'rel')
    git(app.path, 'checkout', '-q', 'main')

    const other = seedRepo('other', { 'x.txt': 'x' })
    const gid = await makeGroup('对照', [
      { cachedRepoId: other.id, mountPath: '' },
      { cachedRepoId: app.id, mountPath: 'compare/main', ref: 'main' },
      { cachedRepoId: app.id, mountPath: 'compare/release', ref: 'release' },
    ])
    const space = await materialize(gid)
    const byMount = new Map(space.repos.map((r) => [r.mountPath, r]))
    expect(git(byMount.get('compare/main')!.worktreePath, 'show', 'HEAD:f.txt').trim()).toBe('main')
    expect(git(byMount.get('compare/release')!.worktreePath, 'show', 'HEAD:f.txt').trim()).toBe(
      'release',
    )
  })
})
