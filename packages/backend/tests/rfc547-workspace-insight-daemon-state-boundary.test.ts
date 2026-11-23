// RFC-547 — workspace-insight 的守护进程级状态归组合根构造的实例（RFC-294 S12 第二十六步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① `infrastructure/deep/scipIndexCache.ts` 与 `application/changeNarrative.ts` 顶层没有 `let`，在架构报告的模块级可变单例判据里为空；删去的单例
//    与两个重置函数在生产代码里不出现（语料下限 3,000）。
// ② 行为：同一次组合共用一份索引缓存，两次组合各有各的；叙述状态由各自的组合持有，一份状态里的生成中记录不影响另一份。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { composeStructuralDeepIndexing } from '@/modules/workspace-insight/composition'
import {
  createChangeNarrativeState,
  getChangeNarrativeStatus,
} from '@/modules/workspace-insight/application/changeNarrative'
import type { CodeReviewArtifactStore } from '@/modules/workspace-insight/application/ports/codeReviewArtifacts'
import { ScipIndexCache } from '@/modules/workspace-insight/infrastructure/deep/scipIndexCache'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const MODULE = SRC + 'modules/workspace-insight/'
const FILES = [
  MODULE + 'infrastructure/deep/scipIndexCache.ts',
  MODULE + 'application/changeNarrative.ts',
]
const CORPUS_TIMEOUT = 30_000
/** The module state RFC-547 removed; production must not name it again. */
const REMOVED = ['scipIndexCache', 'resetScipIndexCache', 'resetChangeNarrativeStateForTests']

export function daemonStateViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  for (const path of FILES) {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) {
      errors.add('missing source: ' + path)
      continue
    }
    const file = path.slice(path.lastIndexOf('/') + 1)
    for (const statement of unit.source.statements)
      if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
      )
        for (const declaration of statement.declarationList.declarations)
          errors.add(`module-level let:${file}:${declaration.name.getText(unit.source)}`)
    for (const entry of mutableSingletons([unit]))
      errors.add(`mutable singleton:${file}:${entry.symbol}`)
  }
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    const walk = (node: ts.Node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`names ${node.text}: ${unit.path}`)
      node.forEachChild(walk)
    }
    walk(unit.source)
  }
  return [...errors].sort()
}

describe('RFC-547 ① 守护进程级状态不在模块级', () => {
  test(
    '真实语料：两个文件没有模块级状态，删去的单例与重置函数在生产代码里不出现',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(daemonStateViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-547 ② 状态随组合走', () => {
  test('同一次组合共用一份索引缓存；两次组合各有各的', () => {
    const deep = composeStructuralDeepIndexing()
    const cache = deep.indexCache()
    expect(cache).toBeInstanceOf(ScipIndexCache)
    expect(deep.indexCache()).toBe(cache)
    expect(composeStructuralDeepIndexing().indexCache()).not.toBe(cache)
  })

  test('叙述状态各自独立：一份里的生成中记录不影响另一份', async () => {
    const artifacts = { readNarrative: async () => null } as unknown as CodeReviewArtifactStore
    const first = createChangeNarrativeState()
    const second = createChangeNarrativeState()
    expect(first.generating).not.toBe(second.generating)
    first.generating.set('t-1', { startedAt: 7, promise: Promise.resolve() })
    expect(await getChangeNarrativeStatus(first, 't-1', artifacts)).toEqual({
      status: 'generating',
      startedAt: 7,
    })
    expect(await getChangeNarrativeStatus(second, 't-1', artifacts)).toBeNull()
  })
})

describe('RFC-547 负对照', () => {
  const clean = FILES.map((path) => sourceUnit(path, 'export class ScipIndexCache {}\n'))
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(daemonStateViolations(clean)).toEqual([])
  })

  test('模块级单例与重置函数都会被认出', () => {
    expect(
      daemonStateViolations(
        replace(
          FILES[0]!,
          'let singleton = null\nexport function scipIndexCache() { return singleton }\nexport function resetScipIndexCache() { singleton = null }\n',
        ),
      ),
    ).toEqual([
      'module-level let:scipIndexCache.ts:singleton',
      'mutable singleton:scipIndexCache.ts:resetScipIndexCache',
      'mutable singleton:scipIndexCache.ts:singleton',
      `names resetScipIndexCache: ${FILES[0]}`,
      `names scipIndexCache: ${FILES[0]}`,
    ])
  })
})
