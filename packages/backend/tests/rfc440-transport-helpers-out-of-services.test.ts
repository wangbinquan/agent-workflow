// RFC-440 — 删除确认、删除快照与 token 读视图离开 services/（RFC-294 W4 B / D 第六步）。
//
// 锁四件事：
// ① 位置：三个 services/ 文件与 `legacyTokenCallAudit` 兼容桥不存在；删除确认与删除快照在 platform/http，
//    token 读视图在 identity-access 的 src/auth/。
// ② 引用：源码里没有任何文件 import 三个旧路径（census 的 AST 提取，注释与字符串不算；别名与相对路径都认）。
// ③ 方向：两个 platform 文件只依赖 hono、`@/auth/actor` 与 `@/util/errors`；token 读视图不 import services/、
//    routes/ 与模块；skills、memories、workgroups、workflows、plugins 五个路由不再 import services/。
// ④ 同一实例：删除快照写入后只能取走一次，非 PAT 调用方不留快照。REST 与 bound operation 两条路的端到端审计
//    由 rfc247-token-audit 与 rfc344-operation-catalog 覆盖。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import type { Context } from 'hono'

import { buildActor, type ActorSource } from '@/auth/actor'
import { captureDeleteSnapshot, takeDeleteSnapshot } from '@/platform/http/deleteSnapshot'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')

/** 退役的三个路径（相对 `src/`，不带扩展名）。 */
const RETIRED = ['services/deleteConfirm', 'services/tokenAudit', 'services/tokenRedaction']

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

/** 说明符是否指向退役路径：`@/` 别名与相对路径两种写法都认。 */
function resolvesToRetired(from: string, specifier: string): boolean {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) {
    target = relative(SRC, resolve(from, '..', specifier))
      .split('\\')
      .join('/')
  } else return false
  return RETIRED.includes(target.replace(/\.[cm]?tsx?$/, ''))
}

describe('RFC-440 —— 位置', () => {
  test('三个 services/ 文件不再存在，新位置就位；兼容桥删除', () => {
    for (const gone of RETIRED) expect(existsSync(join(SRC, `${gone}.ts`)), gone).toBe(false)
    for (const path of [
      'platform/http/deleteConfirm.ts',
      'platform/http/deleteSnapshot.ts',
      'auth/tokenRedaction.ts',
    ]) {
      expect(existsSync(join(SRC, path)), path).toBe(true)
    }
    expect(readFileSync(join(SRC, 'auth', 'composition.ts'), 'utf8')).not.toContain(
      'legacyTokenCallAudit',
    )
  })
})

describe('RFC-440 —— 引用与方向', () => {
  test('源码里没有文件 import 三个旧路径', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(500)
    const offenders = files.flatMap((path) =>
      specifiersOf(path)
        .filter((specifier) => resolvesToRetired(path, specifier))
        .map((specifier) => `${relative(SRC, path)} -> ${specifier}`),
    )
    expect(offenders).toEqual([])
  }, 60_000)

  test('负对照：同一判据认得出别名与相对路径两种写法', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(resolvesToRetired(probe, '@/services/tokenAudit')).toBe(true)
    expect(resolvesToRetired(probe, '../services/deleteConfirm')).toBe(true)
    expect(resolvesToRetired(join(SRC, 'probe.ts'), './services/tokenRedaction.ts')).toBe(true)
    expect(resolvesToRetired(probe, '@/platform/http/deleteConfirm')).toBe(false)
    expect(resolvesToRetired(probe, '@/services/tokenAuditLog')).toBe(false)
  })

  test('两个 platform 文件只依赖 hono、`@/auth/actor` 与 `@/util/errors`', () => {
    const allowed = new Set(['hono', '@/auth/actor', '@/util/errors'])
    for (const path of ['platform/http/deleteConfirm.ts', 'platform/http/deleteSnapshot.ts']) {
      const found = specifiersOf(join(SRC, path))
      // 非空对照：两个文件都按 Hono 的请求上下文工作，提取不到它就说明判据失效。
      expect(found, path).toContain('hono')
      expect(
        found.filter((specifier) => !allowed.has(specifier)),
        path,
      ).toEqual([])
    }
  })

  test('token 读视图留在 identity-access：不 import services/、routes/ 与模块', () => {
    const found = specifiersOf(join(SRC, 'auth', 'tokenRedaction.ts'))
    expect(found).toContain('./application/tokenSnapshotRedaction')
    expect(
      found.filter((specifier) => /^@\/(?:services|routes|modules)\//.test(specifier)),
    ).toEqual([])
  })

  test('skills、memories、workgroups、workflows、plugins 五个路由不再 import services/', () => {
    for (const name of ['skills', 'memories', 'workgroups', 'workflows', 'plugins']) {
      const path = join(SRC, 'routes', `${name}.ts`)
      const found = specifiersOf(path)
      expect(found.length, name).toBeGreaterThan(3)
      const legacy = found.filter(
        (specifier) =>
          specifier.startsWith('@/services/') ||
          (specifier.startsWith('.') &&
            relative(SRC, resolve(path, '..', specifier)).startsWith('services')),
      )
      expect(legacy, name).toEqual([])
    }
  })
})

describe('RFC-440 —— 删除快照', () => {
  function actorFrom(source: ActorSource) {
    return buildActor({
      source,
      ...(source === 'pat' ? { patId: 'pat-rfc440', patScopes: [] } : {}),
      user: {
        id: 'rfc440-user',
        username: 'rfc440-user',
        displayName: 'RFC-440 User',
        role: 'admin',
        status: 'active',
      },
    })
  }

  test('PAT 调用方的快照写入后只能取走一次', () => {
    const c = {} as Context
    captureDeleteSnapshot(c, actorFrom('pat'), { id: 'row-1' })
    expect(takeDeleteSnapshot(c)).toEqual({ id: 'row-1' })
    expect(takeDeleteSnapshot(c)).toBeUndefined()
  })

  test('非 PAT 调用方不留快照；各请求互不串', () => {
    const session = {} as Context
    captureDeleteSnapshot(session, actorFrom('session'), { id: 'row-2' })
    expect(takeDeleteSnapshot(session)).toBeUndefined()

    const first = {} as Context
    const second = {} as Context
    captureDeleteSnapshot(first, actorFrom('pat'), { id: 'row-3' })
    expect(takeDeleteSnapshot(second)).toBeUndefined()
    expect(takeDeleteSnapshot(first)).toEqual({ id: 'row-3' })
  })
})
