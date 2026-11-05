// RFC-446 — 仓库 refs / files 读取归 source-control（RFC-294 W4 B / D 第十二步）。
//
// 锁四件事：
// ① 位置：`services/repo.ts` 不存在；两个读取与已登记目录判定在 source-control 的
//    `infrastructure/local/repositoryIntrospection.ts`。
// ② 引用：源码里没有任何文件 import 旧路径（census 的 AST 提取；别名与相对路径都认，带负对照）；新文件只由 source-control
//    的 mirrors 装配取用；`routes/repos.ts` 不 import `services/`，也不再收仓库存储。
// ③ 判定只在一处：`isKnownRepoPath` 只在新文件声明，`repo-path-unknown` 只在新文件抛出。
// ④ 行为：`?path=` 读取先判定再读（未登记目录在任何 git 调用前被拒，已登记目录及其子目录进入读取，已登记目录每次现取）；
//    单机 mirrors 的 `local` 由它装配；路由把 `?path=` 原样交给 `local`，判定顺序不变。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { RepoRefsResponse } from '@agent-workflow/shared'
import { Hono, type Context } from 'hono'
import { buildActor } from '@/auth/actor'
import { composeRepositoryMirrors } from '@/modules/source-control/composition'
import {
  createKnownPathRepositoryReads,
  isKnownRepoPath,
} from '@/modules/source-control/infrastructure/local/repositoryIntrospection'
import type { RepositoryMirrors } from '@/modules/source-control/public/types'
import { mountRepoRoutes } from '@/routes/repos'
import { DomainError, errorHandler } from '@/util/errors'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const OLD_PATH = 'services/repo'
const NEW_FILE = 'modules/source-control/infrastructure/local/repositoryIntrospection'

/** 不存在的目录：读取在 `requireGitRepo` 的存在性检查处就答 `repo-path-missing`，用例不会真的跑 git。 */
const MIRROR = '/nonexistent-aw-rfc446/mirrors/acme'
const ELSEWHERE = '/nonexistent-aw-rfc446/elsewhere'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** 文件的全部模块说明符（静态 / 类型 / 动态 import、export-from、require），去重；与 R1 账本同一口径。 */
function specifiersOf(path: string): string[] {
  const rel = relative(REPO_ROOT, path).split('\\').join('/')
  const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
}

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) {
    target = relative(SRC, resolve(from, '..', specifier))
      .split('\\')
      .join('/')
  } else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

function targetsOf(rel: string): string[] {
  const path = join(SRC, rel)
  return specifiersOf(path).flatMap((specifier) => targetOf(path, specifier) ?? [])
}

function srcRelative(path: string): string {
  return relative(SRC, path).split('\\').join('/')
}

async function rejectionOf(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof DomainError) return error
    throw error
  }
  throw new Error('expected a DomainError')
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  return (await rejectionOf(run)).code
}

describe('RFC-446 —— 位置', () => {
  test('services/repo.ts 不再存在，读取与判定在 source-control 的本地适配器', () => {
    expect(existsSync(join(SRC, `${OLD_PATH}.ts`))).toBe(false)
    expect(existsSync(join(SRC, `${NEW_FILE}.ts`))).toBe(true)
  })
})

describe('RFC-446 —— 引用', () => {
  test('源码里没有文件 import 旧路径；新文件只由 source-control 的 mirrors 装配取用', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(500)
    const offenders: string[] = []
    const importers: string[] = []
    for (const path of files) {
      for (const specifier of specifiersOf(path)) {
        const target = targetOf(path, specifier)
        if (target === OLD_PATH) offenders.push(`${srcRelative(path)} -> ${specifier}`)
        if (target === NEW_FILE) importers.push(srcRelative(path))
      }
    }
    expect(offenders).toEqual([])
    // 非空对照：判据确实认得出新文件的引用方。
    expect(importers).toEqual(['modules/source-control/composition/repositoryMirrors.ts'])
  }, 60_000)

  test('负对照：同一判据认得出别名与相对路径两种写法，且不把同前缀的兄弟文件当成旧路径', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(targetOf(probe, '@/services/repo')).toBe(OLD_PATH)
    expect(targetOf(probe, '../services/repo.ts')).toBe(OLD_PATH)
    expect(targetOf(probe, '@/services/repoGroup')).not.toBe(OLD_PATH)
    expect(targetOf(probe, '@/services/repoCredentials')).not.toBe(OLD_PATH)
    expect(targetOf(probe, 'node:path')).toBeNull()
  })

  test('routes/repos.ts 不 import services/，也不再收仓库存储', () => {
    const targets = targetsOf('routes/repos.ts')
    // 非空对照：路由仍经 source-control 的 public/types 取 RepositoryMirrors。
    expect(targets).toContain('modules/source-control/public/types')
    expect(targets.filter((target) => target.startsWith('services/'))).toEqual([])
    expect(readFileSync(join(SRC, 'routes/repos.ts'), 'utf8')).not.toContain(
      'RepositoryWorkspaceStore',
    )
    expect(mountRepoRoutes.length).toBe(2)
  })

  test('判定只在一处：isKnownRepoPath 只在新文件声明，repo-path-unknown 只在新文件抛出', () => {
    const declaring: string[] = []
    const throwing: string[] = []
    for (const path of walk(SRC)) {
      const text = readFileSync(path, 'utf8')
      if (/export\s+function\s+isKnownRepoPath\b/.test(text)) declaring.push(srcRelative(path))
      if (text.includes("'repo-path-unknown'")) throwing.push(srcRelative(path))
    }
    expect(declaring).toEqual([`${NEW_FILE}.ts`])
    expect(throwing).toEqual([`${NEW_FILE}.ts`])
  })
})

describe('RFC-446 —— ?path= 读取（createKnownPathRepositoryReads）', () => {
  test('未登记目录在任何读取前被拒；已登记目录及其子目录进入读取', async () => {
    let lookups = 0
    const reads = createKnownPathRepositoryReads(async () => {
      lookups += 1
      return [MIRROR]
    })
    const refused = await rejectionOf(() => reads.refs(ELSEWHERE))
    expect([refused.code, refused.status, refused.message]).toEqual([
      'repo-path-unknown',
      422,
      'path is not a known cached repository',
    ])
    expect(await codeOf(() => reads.files(ELSEWHERE))).toBe('repo-path-unknown')
    // 同前缀的兄弟目录与 `..` 越出都不算已登记。
    expect(await codeOf(() => reads.refs(`${MIRROR}def`))).toBe('repo-path-unknown')
    expect(await codeOf(() => reads.files(`${MIRROR}/../../../etc`))).toBe('repo-path-unknown')
    // 判定通过后由读取自己作答（目录不存在 → repo-path-missing），说明进入了读取而不是被判定拦下。
    expect(await codeOf(() => reads.refs(MIRROR))).toBe('repo-path-missing')
    expect(await codeOf(() => reads.files(`${MIRROR}/pkg`))).toBe('repo-path-missing')
    expect(lookups).toBe(6)
  })

  test('已登记目录每次现取：稍后登记的镜像随即可读', async () => {
    const known: string[] = []
    const reads = createKnownPathRepositoryReads(async () => known)
    expect(await codeOf(() => reads.refs(MIRROR))).toBe('repo-path-unknown')
    known.push(MIRROR)
    expect(await codeOf(() => reads.refs(MIRROR))).toBe('repo-path-missing')
  })

  test('判定与原纯函数一致', () => {
    expect(isKnownRepoPath([MIRROR], MIRROR)).toBe(true)
    expect(isKnownRepoPath([MIRROR], `${MIRROR}/pkg`)).toBe(true)
    expect(isKnownRepoPath([MIRROR], `${MIRROR}def`)).toBe(false)
    expect(isKnownRepoPath([], MIRROR)).toBe(false)
  })

  test('单机 mirrors 的 local 由它装配，已登记目录取自仓库存储', async () => {
    let lookups = 0
    const mirrors = composeRepositoryMirrors({
      store: {
        listKnownRepositoryPaths: async () => {
          lookups += 1
          return [MIRROR]
        },
      } as never,
    })
    expect(mirrors.local).toBeDefined()
    expect(await codeOf(() => mirrors.local!.refs(ELSEWHERE))).toBe('repo-path-unknown')
    expect(await codeOf(() => mirrors.local!.files(MIRROR))).toBe('repo-path-missing')
    expect(lookups).toBe(2)
  })
})

describe('RFC-446 —— 路由', () => {
  const REFS: RepoRefsResponse = {
    branches: ['main'],
    tags: [],
    recentCommits: [],
    currentBranch: 'main',
    defaultBranch: 'main',
    hasCommits: false,
  }

  function appWith(mirrors: RepositoryMirrors): Hono {
    const app = new Hono()
    const actor = buildActor({
      user: {
        id: 'viewer',
        username: 'viewer',
        displayName: 'Viewer',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    app.use('*', async (c: Context, next) => {
      c.set('actor', actor)
      await next()
    })
    app.onError(errorHandler)
    mountRepoRoutes(app, mirrors)
    return app
  }

  test('?path= 原样交给 mirrors.local；cachedRepoId 优先；缺参仍是 cached-repo-id-required', async () => {
    const calls: string[] = []
    const app = appWith({
      refs: async (id) => {
        calls.push(`refs:${id}`)
        return REFS
      },
      files: async (id) => {
        calls.push(`files:${id}`)
        return { files: [] }
      },
      local: {
        refs: async (path) => {
          calls.push(`local.refs:${path}`)
          return REFS
        },
        files: async (path) => {
          calls.push(`local.files:${path}`)
          return { files: ['README.md'] }
        },
      },
    })
    const missing = await app.request('/api/repos/refs')
    expect(missing.status).toBe(422)
    expect(await missing.json()).toMatchObject({ code: 'cached-repo-id-required' })

    const byPath = await app.request(`/api/repos/refs?path=${encodeURIComponent(MIRROR)}`)
    expect(byPath.status).toBe(200)
    expect(await byPath.json()).toMatchObject({ branches: ['main'] })
    const files = await app.request(`/api/repos/files?path=${encodeURIComponent(`${MIRROR}/pkg`)}`)
    expect(await files.json()).toEqual({ files: ['README.md'] })
    const both = await app.request(
      `/api/repos/files?cachedRepoId=cr-1&path=${encodeURIComponent(MIRROR)}`,
    )
    expect(both.status).toBe(200)

    expect(calls).toEqual([`local.refs:${MIRROR}`, `local.files:${MIRROR}/pkg`, 'files:cr-1'])
  })

  test('local 的拒绝原样透到响应：未登记目录 → 422 repo-path-unknown', async () => {
    const app = appWith({
      refs: async () => REFS,
      files: async () => ({ files: [] }),
      local: createKnownPathRepositoryReads(async () => [MIRROR]),
    })
    const res = await app.request(`/api/repos/files?path=${encodeURIComponent(ELSEWHERE)}`)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'repo-path-unknown' })
  })
})
