// RFC-285 B5（D6，Q1/Q7 直接切换）—— stale 方言码灭绝锁。
//
// 为什么这条测试存在：同一「资源被并发修改」语义曾有六个方言码（skill/
// workflow/workgroup 的 version-conflict、workflow/workgroup 的 copy-stale、
// repo-group-version-conflict）+ zip outcome 行的 skill-overwrite-stale，
// 前后端消费方各记各的。归一后唯一形态 = `resource-operation-stale` +
// `resource` 字段（util/errors.ts staleConflictError 单源）。本文件锁：
//   ① 六方言码在 src 三包内灭绝（heritage 注释除外——逐行扫描跳过注释行）；
//   ② 后端 src 里该码字符串的直接产出仅 staleConflictError 一处（agent/plugin/
//      mcp 三个家族先行站点已收编，不得再散落 new ConflictError 直写）；
//   ③ helper 行为：code + resource 字段 + 站点 details 透传 + 409。
// 各资源类的行为级断言由既有套件承担（rfc199/225/248/231/skills/skill-zip 等
// 已随本批全部改判新码）。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { staleConflictError, ConflictError } from '../src/util/errors'

const OLD_CODES = [
  "'skill-version-conflict'",
  "'skill-overwrite-stale'",
  "'workflow-version-conflict'",
  "'workflow-copy-stale'",
  "'workgroup-version-conflict'",
  "'workgroup-copy-stale'",
  "'repo-group-version-conflict'",
]

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) acc.push(p)
  }
  return acc
}

describe('RFC-285 B5 — stale 方言码灭绝', () => {
  test('六方言码在 backend/shared/frontend src 灭绝（注释行除外）', () => {
    const roots = [
      resolve(import.meta.dir, '..', 'src'),
      resolve(import.meta.dir, '..', '..', 'shared', 'src'),
      resolve(import.meta.dir, '..', '..', 'frontend', 'src'),
    ]
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of walk(root)) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
            continue
          for (const code of OLD_CODES) {
            if (line.includes(code)) offenders.push(`${file}: ${trimmed.slice(0, 90)}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('后端 src 内 resource-operation-stale 字符串的直接产出仅 helper 一处', () => {
    // 实现门路 2 P3-2：原单行正则是漏勺——多行书写的 new ConflictError(\n
    // 'resource-operation-stale' 抓不到（mcp.ts / intent/applyChangeset.ts 两处
    // 漏网已收编 helper）。改跨行匹配（\s* 容换行缩进），锁「强制走 helper」
    // 的原意才真正成立。
    const src = resolve(import.meta.dir, '..', 'src')
    let direct = 0
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8')
      direct += (text.match(/new ConflictError\(\s*'resource-operation-stale'/g) ?? []).length
    }
    expect(direct).toBe(1) // util/errors.ts staleConflictError 内部那一处
  })

  test('helper 行为：统一码 + resource 字段 + details 透传 + 409', () => {
    const err = staleConflictError('workflow', 'wf changed', { current: { version: 3 } })
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.code).toBe('resource-operation-stale')
    expect(err.status).toBe(409)
    expect(err.details).toEqual({ resource: 'workflow', current: { version: 3 } })
    const bare = staleConflictError('agent', 'agent changed')
    expect(bare.details).toEqual({ resource: 'agent' })
  })
})
