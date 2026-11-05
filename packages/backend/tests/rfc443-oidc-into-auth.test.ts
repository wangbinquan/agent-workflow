// RFC-443 — OIDC 提供方服务与开通策略归 identity-access 的 auth/oidc（RFC-294 W4 B / D 第九步）。
//
// 锁三件事：
// ① 位置：`services/oidcProviders`、`services/oidc/provisioning` 不存在、`services/oidc/` 下没有源文件，两个文件在 `auth/oidc/`。
// ② 引用：源码里没有任何文件 import 两个旧路径（census 的 AST 提取；别名与相对路径都认，带负对照）。
// ③ 方向：`oidc`、`oidc-auth` 两个路由不 import `services/`；`auth/` 下没有任何对 `services/` 的 import——依赖规则
//    `no-auth-to-services` 只拦值边，这里连类型边也锁住（原先 `auth/oidc/identity.ts` 有一条）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')

/** 退役的两个路径（相对 `src/`，不带扩展名）。 */
const RETIRED = ['services/oidcProviders', 'services/oidc/provisioning']

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

const intoServices = (from: string, specifier: string): boolean =>
  (targetOf(from, specifier) ?? '').startsWith('services/')

describe('RFC-443 —— 位置', () => {
  test('两个 services/ 文件不再存在、services/oidc/ 下没有源文件，新文件在 auth/oidc/', () => {
    for (const gone of RETIRED) expect(existsSync(join(SRC, `${gone}.ts`)), gone).toBe(false)
    // 判据是「没有源文件」而不是「目录不存在」：git 不跟踪目录，导出或手工删除可能留下空壳，空目录不是回退。
    const oidcDir = join(SRC, 'services', 'oidc')
    expect(existsSync(oidcDir) ? walk(oidcDir) : []).toEqual([])
    for (const name of ['providers.ts', 'provisioning.ts']) {
      expect(existsSync(join(SRC, 'auth', 'oidc', name)), name).toBe(true)
    }
  })
})

describe('RFC-443 —— 引用与方向', () => {
  test('源码里没有文件 import 两个旧路径', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(500)
    const offenders = files.flatMap((path) =>
      specifiersOf(path)
        .filter((specifier) => RETIRED.includes(targetOf(path, specifier) ?? ''))
        .map((specifier) => `${relative(SRC, path)} -> ${specifier}`),
    )
    expect(offenders).toEqual([])
  }, 60_000)

  test('负对照：同一判据认得出别名、相对路径与类型 import', () => {
    const probe = join(SRC, 'auth', 'oidc', 'probe.ts')
    const unit = sourceUnit(
      'packages/backend/src/auth/oidc/probe.ts',
      "import type { IdTokenClaims } from '@/services/oidc/provisioning'\n" +
        "import { createOidcProvidersService } from '../../services/oidcProviders'\n" +
        "import { resolveEndpoints } from './endpoints'\n",
    )
    const found = importEdges(unit).map((edge) => edge.specifier)
    expect(found.filter((specifier) => intoServices(probe, specifier))).toEqual([
      '@/services/oidc/provisioning',
      '../../services/oidcProviders',
    ])
  })

  test('oidc、oidc-auth 两个路由不 import services/', () => {
    for (const name of ['oidc', 'oidc-auth']) {
      const path = join(SRC, 'routes', `${name}.ts`)
      const found = specifiersOf(path)
      // 非空对照：两个路由都从 auth/oidc 取用，一条也提取不到就说明判据失效。
      expect(
        found.some((specifier) => specifier.startsWith('@/auth/oidc/')),
        name,
      ).toBe(true)
      expect(
        found.filter((specifier) => intoServices(path, specifier)),
        name,
      ).toEqual([])
    }
  })

  test('auth/ 下没有任何对 services/ 的 import（含类型）', () => {
    const files = walk(join(SRC, 'auth'))
    expect(files.length).toBeGreaterThan(15)
    const offenders = files.flatMap((path) =>
      specifiersOf(path)
        .filter((specifier) => intoServices(path, specifier))
        .map((specifier) => `${relative(SRC, path)} -> ${specifier}`),
    )
    expect(offenders).toEqual([])
  })
})
