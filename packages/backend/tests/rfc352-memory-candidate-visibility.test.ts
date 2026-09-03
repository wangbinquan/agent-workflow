// RFC-352 AC-6 —— RFC-285 B7（Q4）候选收窄只剩一份判据。
//
// 为什么这条测试存在：T8 之前，「未审候选只对持 `resource-acl:bypass` 的操作者可见」这条规则
// 在 `routes/memories.ts` 里被**手抄了四遍**（列表 / `include=body` 审批队列 / `facets` 聚合 /
// 详情 404），分页路径（`application/listPage.ts`）是第五份，且 facets 那份外面还多套了一层
// `status === 'candidate' &&`。四份手抄件形状不一致，下次改判据漏掉任何一处，症状都是
// 「某个入口能看到别人的未审候选」——与本 RFC 开局撞到的 canManage 双 provider 漂移同类。
//
// 因此本文件锁两件事：
//   ① 判据本身（`domain/candidateVisibility`）的行为，含 facets 那条被合并掉的分支等价性；
//   ② 路由里不再出现任何手写的 `status !== 'candidate'` / `status === 'candidate'` 收窄
//      ——源码层文本断言，任何人把手抄件加回来都会红。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  isMemoryHiddenCandidate,
  narrowCandidateRows,
} from '../src/modules/memory/domain/candidateVisibility'

const ROUTE_FILE = resolve(import.meta.dir, '..', 'src', 'routes', 'memories.ts')

const rows = [
  { id: 'a', status: 'approved' },
  { id: 'b', status: 'candidate' },
  { id: 'c', status: 'archived' },
  { id: 'd', status: 'candidate' },
]

describe('RFC-352 AC-6 — 候选收窄判据', () => {
  test('无 bypass：候选行被滤掉，其余保持原序', () => {
    expect(narrowCandidateRows(rows, { includeCandidates: false }).map((r) => r.id)).toEqual([
      'a',
      'c',
    ])
  })

  test('有 bypass：一行不少，且顺序不变', () => {
    expect(narrowCandidateRows(rows, { includeCandidates: true }).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  test('返回新数组，不就地改调用方的行', () => {
    const input = [...rows]
    narrowCandidateRows(input, { includeCandidates: false })
    narrowCandidateRows(input, { includeCandidates: true })
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('单行判定：只有「候选 + 无 bypass」才算隐藏（详情路由据此 404）', () => {
    expect(isMemoryHiddenCandidate({ status: 'candidate' }, { includeCandidates: false })).toBe(
      true,
    )
    expect(isMemoryHiddenCandidate({ status: 'candidate' }, { includeCandidates: true })).toBe(
      false,
    )
    expect(isMemoryHiddenCandidate({ status: 'approved' }, { includeCandidates: false })).toBe(
      false,
    )
  })

  test('facets 合并掉的那层 `status === candidate &&` 是等价的', () => {
    // 旧写法只在**查询 status 恰为 candidate** 时才滤。facets 的行全部来自
    // `list({...filter, status})`，因此每一行的 status 都等于查询 status——
    // status 不是 candidate 时集合里根本没有候选行，滤与不滤同果。
    for (const status of ['approved', 'archived', 'candidate']) {
      const homogeneous = [
        { id: '1', status },
        { id: '2', status },
      ]
      const legacy =
        status === 'candidate' ? homogeneous.filter((r) => r.status !== 'candidate') : homogeneous
      expect(narrowCandidateRows(homogeneous, { includeCandidates: false })).toEqual(legacy)
    }
  })
})

describe('RFC-352 AC-6 — 路由不再手写收窄', () => {
  const source = readFileSync(ROUTE_FILE, 'utf8')

  test('routes/memories.ts 里没有手写的 candidate 状态比较', () => {
    const handWritten = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .filter((line) => /status\s*[!=]==\s*'candidate'/.test(line))
    expect(handWritten).toEqual([])
  })

  test('收窄经 memory public 的单一判据，ACL 谓词经 resource-catalog public', () => {
    expect(source).toContain("from '@/modules/memory/public/types'")
    expect(source).toContain('narrowCandidateRows')
    expect(source).toContain('isMemoryHiddenCandidate')
    // 同一谓词曾在仓里有两个来源（legacy `@/services/resourceAcl` 与 RC domain 直插）。
    expect(source).toContain("from '@/modules/resource-catalog/public/types'")
    expect(source).not.toContain("from '@/services/resourceAcl'")
  })
})
