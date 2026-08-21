// RFC-310 —— AC 证据索引的**可执行性**守卫。
//
// `design/RFC-310-.../plan.md §13a` 把 77 条验收标准逐条映射到具体测试文件
// （"AC-14/25/35 → rfc310-pr5-* + rfc310-t109-full-journey-e2e"）。那份索引是
// 本 RFC「功能自证」的落脚点：它声称每条 AC 都有可复跑的证据。
//
// 问题在于**索引自己没有任何东西守着**。文件改名、被删、被合并，索引照旧写着
// 老名字，而没有一条测试会红——PR-10 一次退役波就删掉了 88 个测试文件，
// 那种规模下靠人肉核对索引是不现实的。于是"自证"会悄悄退化成"曾经自证过"。
//
// 这条测试把索引变成可执行的：
//   ①索引里点名的每个测试文件**必须真实存在**（glob 形态至少命中一个）；
//   ②AC-1..AC-77 必须**逐条出现**，不许有洞；
//   ③失败关闭——扫不到东西时红，而不是"没找到违规"式的空洞绿。
//
// 它不检查那些文件是否绿：那是 `gate:local` / CI 的职责，重复断言只会两处都
// 维护不动。它只保证"索引指向的东西还在"——这恰恰是索引唯一无法自证的部分。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PLAN = resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  'design',
  'RFC-310-rule-driven-development-digital-employee',
  'plan.md',
)
const BACKEND_TESTS = resolve(import.meta.dir)
const FRONTEND_TESTS = resolve(import.meta.dir, '..', '..', 'frontend', 'tests')

/** 索引正文（`### AC 证据索引` 到下一个三级标题为止）。 */
export function evidenceSection(planMarkdown: string): string {
  const start = planMarkdown.indexOf('### AC 证据索引')
  if (start === -1) return ''
  const rest = planMarkdown.slice(start + 1)
  const end = rest.indexOf('\n### ')
  return end === -1 ? rest : rest.slice(0, end)
}

/** 索引里点名的测试文件 token（`rfc310-xxx` / `rfc310-xxx-*`）。 */
export function citedTestTokens(section: string): string[] {
  const out = new Set<string>()
  for (const m of section.matchAll(/`([a-z0-9][a-z0-9-]*\*?)`/g)) {
    const token = m[1]!
    if (token.startsWith('rfc310-')) out.add(token)
  }
  return [...out].sort()
}

/** 索引里出现过的 AC 编号（`**AC-1/2/3/4**` 这种斜杠串也要拆开）。 */
export function citedAcNumbers(section: string): Set<number> {
  const out = new Set<number>()
  for (const m of section.matchAll(/AC-([\d/]+)/g)) {
    for (const part of m[1]!.split('/')) {
      const n = Number.parseInt(part, 10)
      if (Number.isInteger(n)) out.add(n)
    }
  }
  return out
}

function testFileNames(): string[] {
  const names: string[] = []
  for (const dir of [BACKEND_TESTS, FRONTEND_TESTS]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) names.push(entry.name)
    }
  }
  return names
}

/** token 是否命中至少一个测试文件（`*` 结尾按前缀匹配）。 */
export function resolvesToTestFile(token: string, fileNames: readonly string[]): boolean {
  const stem = token.endsWith('*') ? token.slice(0, -1) : token
  return fileNames.some((name) =>
    token.endsWith('*')
      ? name.startsWith(stem)
      : name === `${stem}.test.ts` || name === `${stem}.test.tsx`,
  )
}

describe('RFC-310 AC evidence index stays executable', () => {
  const section = evidenceSection(readFileSync(PLAN, 'utf8'))
  const tokens = citedTestTokens(section)
  const files = testFileNames()

  test('the index section itself is present and cites evidence (fails closed)', () => {
    expect(section.length).toBeGreaterThan(500)
    expect(tokens.length).toBeGreaterThan(10)
    expect(files.length).toBeGreaterThan(100)
  })

  test('every test file the index names still exists', () => {
    // 红了怎么办：**先改索引，别改这条测试**。文件改名/合并了就把索引更新到
    // 新名字；文件是被有意删除的（退役波），就把那条 AC 的证据改指向接替它的
    // 测试——如果没有接替者，那说明该 AC 已失去证据，这正是本测试要喊的事。
    const missing = tokens.filter((t) => !resolvesToTestFile(t, files))
    expect(missing).toEqual([])
  })

  test('AC-1..AC-77 are each cited somewhere in the index', () => {
    const cited = citedAcNumbers(section)
    const gaps: number[] = []
    for (let ac = 1; ac <= 77; ac++) {
      if (!cited.has(ac)) gaps.push(ac)
    }
    expect(gaps).toEqual([])
  })

  test('the resolver itself: exact hit, glob hit, and a renamed file all judged right', () => {
    // 判据自检（本 session 反复实证：扫描器/判据函数出错时，主断言会静默放行）。
    const sample = ['rfc310-t109-full-journey-e2e.test.ts', 'rfc310-pr5-e2e-java.test.ts']
    expect(resolvesToTestFile('rfc310-t109-full-journey-e2e', sample)).toBe(true)
    expect(resolvesToTestFile('rfc310-pr5-*', sample)).toBe(true)
    // 事故形态：索引还写着旧名字，而文件已经改名/删除。
    expect(resolvesToTestFile('rfc310-pr5-renamed-away', sample)).toBe(false)
    expect(resolvesToTestFile('rfc310-pr9-*', sample)).toBe(false)
  })
})
