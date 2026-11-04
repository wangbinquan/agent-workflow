// RFC-444 — 内建资源清单归 resource-catalog（RFC-294 W4 B / D 第十步）。
//
// 锁四件事：
// ① 位置：`services/systemResources` 不存在，清单在 resource-catalog `domain/systemResources.ts`。
// ② 引用：源码里没有任何文件 import 旧路径（census 的 AST 提取；别名与相对路径都认，带负对照）；模块外的引用方只经
//    `public/types`，`public/types` 只转出模块外实际用到的五个符号。
// ③ 方向：knowledge-evolution 不再 import 也不再转出 legacy 的清单（KE-03 两条 R2 边清零）；`resourceAcl` 路由不 import `services/`。
// ④ 行为：两个 id 与两个 name 的字面值不变；`assertNotBuiltin` 对内建行抛 `ForbiddenError`、对普通行放行。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import * as publicTypes from '@/modules/resource-catalog/public/types'
import { ForbiddenError } from '@/util/errors'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const RC = join(SRC, 'modules', 'resource-catalog')
const NEW_FILE = 'modules/resource-catalog/domain/systemResources'

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

describe('RFC-444 —— 位置', () => {
  test('services/systemResources 不再存在，清单在 resource-catalog domain', () => {
    expect(existsSync(join(SRC, 'services', 'systemResources.ts'))).toBe(false)
    expect(existsSync(join(SRC, `${NEW_FILE}.ts`))).toBe(true)
  })
})

describe('RFC-444 —— 引用与方向', () => {
  test('源码里没有文件 import 旧路径；模块外的引用方只经 public/types', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(500)
    const offenders: string[] = []
    let viaPublic = 0
    for (const path of files) {
      const insideRc = path.startsWith(RC + '/')
      for (const specifier of specifiersOf(path)) {
        const target = targetOf(path, specifier)
        if (target === 'services/systemResources')
          offenders.push(`${relative(SRC, path)} -> ${specifier}`)
        if (target === NEW_FILE && !insideRc)
          offenders.push(`${relative(SRC, path)} -> ${specifier}`)
        if (specifier === '@/modules/resource-catalog/public/types' && !insideRc) viaPublic += 1
      }
    }
    expect(offenders).toEqual([])
    // 非空对照：task-execution、knowledge-evolution、bootstrap、路由与 legacy service 都经 public/types 取用。
    expect(viaPublic).toBeGreaterThan(8)
  })

  test('负对照：同一判据认得出别名与相对路径两种写法', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(targetOf(probe, '@/services/systemResources')).toBe('services/systemResources')
    expect(targetOf(probe, '../services/systemResources.ts')).toBe('services/systemResources')
    expect(targetOf(join(RC, 'composition', 'probe.ts'), '../domain/systemResources')).toBe(
      NEW_FILE,
    )
    expect(targetOf(probe, '@/modules/resource-catalog/public/types')).toBe(
      'modules/resource-catalog/public/types',
    )
  })

  test('public/types 只转出模块外实际用到的五个符号', () => {
    const text = readFileSync(join(RC, 'public', 'types.ts'), 'utf8')
    const block = /export \{([^}]*)\} from '\.\.\/domain\/systemResources'/.exec(text)
    expect(block).not.toBeNull()
    const names = block![1]!
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .sort()
    expect(names).toEqual([
      'SKILL_FUSION_WORKFLOW_ID',
      'SKILL_FUSION_WORKFLOW_NAME',
      'SKILL_MERGER_AGENT_ID',
      'SKILL_MERGER_AGENT_NAME',
      'assertNotBuiltin',
    ])
  })

  test('knowledge-evolution 不再 import 也不再转出 legacy 清单；resourceAcl 路由不 import services/', () => {
    const fusion = join(
      SRC,
      'modules',
      'knowledge-evolution',
      'application',
      'fusionOrchestration.ts',
    )
    const found = specifiersOf(fusion)
    expect(found).toContain('@/modules/resource-catalog/public/types')
    expect(found.filter((specifier) => specifier.startsWith('@/services/'))).toEqual([])
    const route = join(SRC, 'routes', 'resourceAcl.ts')
    expect(
      specifiersOf(route).filter((specifier) =>
        (targetOf(route, specifier) ?? '').startsWith('services/'),
      ),
    ).toEqual([])
  })
})

describe('RFC-444 —— 行为', () => {
  test('两个 id 与两个 name 的字面值不变', () => {
    expect(publicTypes.SKILL_MERGER_AGENT_ID).toBe('00000000000000000000000001')
    expect(publicTypes.SKILL_FUSION_WORKFLOW_ID).toBe('00000000000000000000000002')
    expect(publicTypes.SKILL_MERGER_AGENT_NAME).toBe('aw-skill-merger')
    expect(publicTypes.SKILL_FUSION_WORKFLOW_NAME).toBe('aw-skill-fusion')
  })

  test('assertNotBuiltin：内建行抛 ForbiddenError，普通行放行', () => {
    expect(() => publicTypes.assertNotBuiltin('agent', { builtin: true })).toThrow(ForbiddenError)
    expect(() => publicTypes.assertNotBuiltin('workflow', { builtin: false })).not.toThrow()
    // skill / mcp / plugin 行没有 builtin 列：判定是空操作。
    expect(() => publicTypes.assertNotBuiltin('skill', {})).not.toThrow()
  })
})
