// RFC-317 R4 —— 一个 bounded context 的 application / domain 层不得点名**别人的**词汇。
//
// 本表逐行钉住「某个 context 的哪几层、对哪套词汇、预算是多少」。首行来自 T30（DE-04）：
// `event-center` 的响应规则服务原本写着
//   `if (draft.target.kind === 'digital-employee' && !principal.canLaunchDigitalEmployee)`
// 外加硬编码的 `'development-missions:launch'`——它同时认识了「数字员工」这一类目标
// 与 development-automation 的权限词汇。第二类目标要加权限门，只能回来改这段领域判据
// 和 `ResponseRuleWritePrincipal` 接口。
//
// **不把所有 context 都设成 0**：一个 context 在自己的领域层点名**自己的**权限点是正当的
// （identity-access 说 `'users:write'`、development-automation 说 `'development-missions:*'`），
// 把它们一并禁掉只会逼出一堆假豁免。这张表要的是「谁不该认识谁」，逐条有据。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PERMISSIONS } from '@agent-workflow/shared'

import { mintedVocabulary, sourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const MODULES = resolve(REPO_ROOT, 'packages', 'backend', 'src', 'modules')

interface VocabularyBudget {
  readonly context: string
  readonly layers: readonly string[]
  readonly vocabulary: readonly string[]
  readonly vocabularyName: string
  readonly why: string
}

const BUDGETS: readonly VocabularyBudget[] = [
  {
    context: 'event-center',
    layers: ['application', 'domain'],
    vocabulary: PERMISSIONS,
    vocabularyName: 'Permission',
    why: 'DE-04：响应规则的启动权限门原本写死 development-automation 的 `development-missions:launch`。权限点属于声明它的那个 context；event-center 只该问「这一类目标要哪个权限点」，对应关系作为数据由装配层给出（composition.ts 的 DEFAULT_TARGET_LAUNCH_PERMISSIONS）。',
  },
]

function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return out
  }
  for (const name of entries) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFilesUnder(path, out)
    else if (/\.[cm]?ts$/.test(name)) out.push(path)
  }
  return out
}

describe('RFC-317 R4 —— context 的 application / domain 不得点名外部词汇', () => {
  test('语料非空：模块根扫得到、词汇表读得到（任一为空则本守卫零预言力）', () => {
    expect(readdirSync(MODULES).length).toBeGreaterThanOrEqual(5)
    expect(PERMISSIONS.length).toBeGreaterThanOrEqual(50)
    expect(BUDGETS.length).toBeGreaterThanOrEqual(1)
  })

  test('每条预算指向的 context 与层目录都真实存在（改名后先红，而不是悄悄不再校验）', () => {
    const missing: string[] = []
    for (const budget of BUDGETS) {
      for (const layer of budget.layers) {
        const dir = join(MODULES, budget.context, layer)
        try {
          if (!statSync(dir).isDirectory()) missing.push(`${budget.context}/${layer}`)
        } catch {
          missing.push(`${budget.context}/${layer}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test('每条预算都写清了理由（说不出「谁不该认识谁」就不该立这条）', () => {
    expect(BUDGETS.filter((b) => b.why.trim().length < 40).map((b) => b.context)).toEqual([])
  })

  for (const budget of BUDGETS) {
    test(`${budget.context} 的 ${budget.layers.join(' / ')} 层不出现任何 ${budget.vocabularyName} 取值`, () => {
      const offenders: string[] = []
      for (const layer of budget.layers) {
        for (const file of sourceFilesUnder(join(MODULES, budget.context, layer))) {
          const rel = file.slice(REPO_ROOT.length + 1)
          offenders.push(
            ...mintedVocabulary(sourceUnit(rel, readFileSync(file, 'utf8')), budget.vocabulary),
          )
        }
      }
      expect(offenders, budget.why).toEqual([])
    })
  }
})

describe('RFC-317 R4 自变异 —— 判据的两条边界', () => {
  test('真的点名一个外部权限点会被抓到', () => {
    const unit = sourceUnit(
      'probe.ts',
      `if (!principal.can('development-missions:launch')) throw new Error('nope')\n`,
    )
    expect(mintedVocabulary(unit, PERMISSIONS).length).toBe(1)
  })

  test('注释里提到权限点**不算**违规（AST 判据，不被散文满足）', () => {
    const unit = sourceUnit(
      'probe.ts',
      `// 这里原本写死 'development-missions:launch'，见 RFC-317 DE-04\nexport const x = 1\n`,
    )
    expect(mintedVocabulary(unit, PERMISSIONS)).toEqual([])
  })
})
