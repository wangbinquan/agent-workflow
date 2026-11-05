// RFC-451 — 仓库镜像缓存家族归 source-control（RFC-294 W4 B / D 第十六步）。
//
// 锁四件事：
// ① `services/gitRepoCache`、`services/repoBatchImport`、`services/submoduleRefresh` 已删除，`src/` 下零引用（census AST，别名与相对路径都认，
//    带负对照）；`cached-repos` 路由不再 import `services/`。
// ② 子模块参数解析归平台之后，平台仍不 import 任何模块（平台 → 模块的文件对为 0）。
// ③ 镜像管理合同：托管登记存在时刷新走远端、不读配置；否则读配置后本地刷新。
// ④ 合同的删除与快照沿用镜像缓存 / 批量导入的语义（未知镜像 404、未知批次为 null）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { composeCachedRepositoryOperations } from '@/modules/source-control/composition'
import type { RepositoryMirrors } from '@/modules/source-control/public/types'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/public/operations'
import { NotFoundError } from '@/util/errors'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const MOVED = ['services/gitRepoCache', 'services/repoBatchImport', 'services/submoduleRefresh']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
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

function importsMatching(files: readonly string[], matches: (target: string) => boolean): string[] {
  return files.flatMap((path) => {
    const rel = relative(REPO_ROOT, path).split('\\').join('/')
    const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
      .filter((specifier) => matches(targetOf(path, specifier) ?? ''))
      .map((specifier) => `${relative(SRC, path)} -> ${specifier}`)
  })
}

const isMovedFile = (target: string) => MOVED.includes(target)

describe('RFC-451 —— 引用', () => {
  test('三个旧文件已删除，src/ 下零引用', () => {
    for (const file of MOVED) expect(existsSync(join(SRC, `${file}.ts`))).toBe(false)
    expect(importsMatching(walk(SRC), isMovedFile)).toEqual([])
  }, 60_000)

  test('cached-repos 路由不再 import services/', () => {
    expect(
      importsMatching([join(SRC, 'routes/cached-repos.ts')], (target) =>
        target.startsWith('services/'),
      ),
    ).toEqual([])
  })

  test('平台不 import 任何模块（子模块参数解析归平台后仍为 0）', () => {
    expect(
      importsMatching(walk(join(SRC, 'platform')), (target) => target.startsWith('modules/')),
    ).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径，也不误伤同前缀的文件', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(isMovedFile(targetOf(probe, '@/services/gitRepoCache') ?? '')).toBe(true)
    expect(isMovedFile(targetOf(probe, '../services/repoBatchImport.ts') ?? '')).toBe(true)
    expect(isMovedFile(targetOf(probe, '@/services/gitRepoCacheExtra') ?? '')).toBe(false)
    expect(targetOf(join(SRC, 'platform', 'x.ts'), '../modules/source-control/composition')).toBe(
      'modules/source-control/composition',
    )
  })
})

function operations(input: {
  readonly remote?: RepositoryMirrors['remoteRegistration']
  readonly configReads: { count: number }
}) {
  const store = {
    runtimeIdentity: {},
    invalidateCachedRepoFacets() {},
    findCachedRepoById: async () => null,
  } as unknown as RepositoryWorkspaceStore
  return composeCachedRepositoryOperations({
    store,
    mirrors: (input.remote === undefined
      ? {}
      : { remoteRegistration: input.remote }) as unknown as RepositoryMirrors,
    configuration: {
      read() {
        input.configReads.count += 1
        return {}
      },
    },
  })
}

describe('RFC-451 —— 镜像管理合同', () => {
  test('托管登记存在：刷新走远端，不读配置', async () => {
    const configReads = { count: 0 }
    const refreshed: string[] = []
    const result = { cachedRepoId: 'r1' } as never
    const ops = operations({
      configReads,
      remote: {
        register: async () => {
          throw new Error('unused')
        },
        refresh: async (id: string) => {
          refreshed.push(id)
          return result
        },
      },
    })
    expect(await ops.refresh('r1')).toBe(result)
    expect(refreshed).toEqual(['r1'])
    expect(configReads.count).toBe(0)
  })

  test('单机：读配置后本地刷新（未知镜像 cached-repo-not-found）', async () => {
    const configReads = { count: 0 }
    const failure = await operations({ configReads })
      .refresh('missing')
      .catch((error: unknown) => error)
    expect(configReads.count).toBe(1)
    expect(failure).toBeInstanceOf(NotFoundError)
    expect((failure as NotFoundError).code).toBe('cached-repo-not-found')
  })

  test('删除未知镜像为 404；未知批次快照为 null', async () => {
    const ops = operations({ configReads: { count: 0 } })
    const failure = await ops.remove('missing', { force: false }).catch((error: unknown) => error)
    expect((failure as NotFoundError).code).toBe('cached-repo-not-found')
    expect(ops.batchSnapshot('no-such-batch')).toBeNull()
  })
})
