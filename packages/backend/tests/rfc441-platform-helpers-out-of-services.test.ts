// RFC-441 — API 文档、PlantUML 渲染与外部入口开关归 platform（RFC-294 W4 B / D 第七步）。
//
// 锁四件事：
// ① 位置：`services/apiDocs`、`services/plantuml`、`services/mcpSurface` 不存在，三个文件在 platform 的
//    `operations` / `http` / `configuration`；零调用的 `tokenAuditRetentionDays` 不再导出。
// ② 引用：源码里没有任何文件 import 三个旧路径（census 的 AST 提取；别名与相对路径都认，带负对照）。
// ③ 方向：三个新文件不 import 模块与 legacy 目标前缀（services/、routes/、ws/、mcp/）；`auth`、`docs`、`plantuml`
//    三个路由与 `mcp/`、`ws/` 下的文件不 import `services/`，入站适配器里只剩 `routes/` 还有 legacy 依赖。
// ④ 开关的缺省与判定不变：未设置为开，显式 `false` 为关。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import * as mcpSurface from '@/platform/configuration/mcpSurface'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')

/** 退役的三个路径（相对 `src/`，不带扩展名）。 */
const RETIRED = ['services/apiDocs', 'services/plantuml', 'services/mcpSurface']

const MOVED = [
  'platform/operations/apiDocs.ts',
  'platform/http/plantuml.ts',
  'platform/configuration/mcpSurface.ts',
] as const

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

const isRetired = (from: string, specifier: string): boolean =>
  RETIRED.includes(targetOf(from, specifier) ?? '')

const isLegacyOrModule = (from: string, specifier: string): boolean =>
  /^(?:services|routes|ws|mcp|modules)\//.test(targetOf(from, specifier) ?? '')

describe('RFC-441 —— 位置', () => {
  test('三个 services/ 文件不再存在，新位置就位', () => {
    for (const gone of RETIRED) expect(existsSync(join(SRC, `${gone}.ts`)), gone).toBe(false)
    for (const path of MOVED) expect(existsSync(join(SRC, path)), path).toBe(true)
  })

  test('零调用的 tokenAuditRetentionDays 不再导出；开关读取照旧', () => {
    expect(Object.keys(mcpSurface).sort()).toEqual(['isMcpSurfaceEnabled'])
  })
})

describe('RFC-441 —— 引用与方向', () => {
  test('源码里没有文件 import 三个旧路径', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(500)
    const offenders = files.flatMap((path) =>
      specifiersOf(path)
        .filter((specifier) => isRetired(path, specifier))
        .map((specifier) => `${relative(SRC, path)} -> ${specifier}`),
    )
    expect(offenders).toEqual([])
  }, 60_000)

  test('负对照：同一判据认得出别名与相对路径两种写法', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(isRetired(probe, '@/services/apiDocs')).toBe(true)
    expect(isRetired(probe, '../services/plantuml')).toBe(true)
    expect(isRetired(join(SRC, 'mcp', 'probe.ts'), '../services/mcpSurface.ts')).toBe(true)
    expect(isRetired(probe, '@/platform/operations/apiDocs')).toBe(false)
    expect(isRetired(probe, '@/services/apiDocsIndex')).toBe(false)
    expect(isLegacyOrModule(probe, '@/modules/intent/public/types')).toBe(true)
    expect(isLegacyOrModule(probe, '@/platform/operations/catalog')).toBe(false)
  })

  test('三个新文件不 import 模块与 legacy 目标前缀', () => {
    for (const path of MOVED) {
      const file = join(SRC, path)
      const found = specifiersOf(file)
      // 非空对照：三个文件各自至少有一个依赖，提取不到就说明判据失效。
      expect(found.length, path).toBeGreaterThan(0)
      expect(
        found.filter((specifier) => isLegacyOrModule(file, specifier)),
        path,
      ).toEqual([])
    }
  })

  test('auth、docs、plantuml 三个路由与 mcp/、ws/ 下的文件不 import services/', () => {
    const files = [
      ...['auth', 'docs', 'plantuml'].map((name) => join(SRC, 'routes', `${name}.ts`)),
      ...walk(join(SRC, 'mcp')),
      ...walk(join(SRC, 'ws')),
    ]
    expect(files.length).toBeGreaterThan(8)
    const offenders = files.flatMap((path) =>
      specifiersOf(path)
        .filter((specifier) => (targetOf(path, specifier) ?? '').startsWith('services/'))
        .map((specifier) => `${relative(SRC, path)} -> ${specifier}`),
    )
    expect(offenders).toEqual([])
  })
})

describe('RFC-441 —— 外部入口开关', () => {
  test('未设置为开，显式 false 为关，显式 true 为开', () => {
    expect(mcpSurface.isMcpSurfaceEnabled({})).toBe(true)
    expect(mcpSurface.isMcpSurfaceEnabled({ mcpSurfaceEnabled: false })).toBe(false)
    expect(mcpSurface.isMcpSurfaceEnabled({ mcpSurfaceEnabled: true })).toBe(true)
  })
})
