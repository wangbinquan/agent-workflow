// RFC-271 —— 验收条款的**覆盖棘轮**：每条 AC 都必须在测试里被点名。
//
// 为什么需要机械核查而不是人工勾清单：RFC 的验收清单第一条写的是「AC-B1…B6 +
// AC-K1/K2 + AC-1…AC-34 逐条有测试点名」。收尾时实测 **62 条里有 30 条没点名**
// ——行为其实都覆盖了，但测试标题用的是任务号（`T14`）或行为描述，于是
// 「AC-15b 到底在哪测的」只能靠人翻。清单被勾成绿色，可追溯性却是空的。
//
// 这条守卫把那句话变成可执行的判据：
//   ① 从 design / proposal / plan 里抽出**所有**加粗定义的 AC 编号（真值来源是
//      文档本身，不是这里手抄的列表——手抄的列表会漂移）；
//   ② 逐条要求它出现在某个测试文件里。
//
// 于是三件事同时成立：新增 AC 忘了写测试会红；删掉某条测试导致 AC 失去覆盖会红；
// 「逐条点名」不再需要任何人肉核对。
//
// ⚠️ 点名 ≠ 覆盖。这条守卫只保证**可追溯**（找得到测哪儿），保证不了断言的质量。
// 加锚点时请锚在真的测了那件事的文件上——锚错比不锚更糟，它会让清单说谎。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..', '..')
const RFC_DIR = resolve(REPO, 'design', 'RFC-271-resource-config-package')
const SELF = 'rfc271-ac-coverage.test.ts'

/** 测试所在的四个目录。e2e 也算——它同样是验收证据。 */
const TEST_DIRS = [
  resolve(REPO, 'packages', 'backend', 'tests'),
  resolve(REPO, 'packages', 'shared', 'tests'),
  resolve(REPO, 'packages', 'frontend', 'tests'),
  resolve(REPO, 'e2e'),
]

/** design/proposal/plan 里**加粗定义**的 AC 编号 —— 真值来源，不手抄。 */
function declaredAcs(): string[] {
  const found = new Set<string>()
  for (const name of readdirSync(RFC_DIR)) {
    if (!name.endsWith('.md')) continue
    const src = readFileSync(resolve(RFC_DIR, name), 'utf8')
    // `**AC-7d**` / `**AC-B2h**` / `**AC-K1**` —— 只认加粗的那种，正文里顺带提到
    // 一个编号不算「定义」。
    for (const m of src.matchAll(/\*\*(AC-(?:[0-9]+|B[0-9]+|K[0-9]+)[a-z]?)\*\*/g)) {
      found.add(m[1]!)
    }
  }
  return [...found].sort()
}

function testCorpus(): string {
  const chunks: string[] = []
  for (const dir of TEST_DIRS) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
      if (name === SELF) continue // 自身不算证据，否则错误信息里的编号会自匹配
      chunks.push(readFileSync(resolve(dir, name), 'utf8'))
    }
  }
  return chunks.join('\n')
}

describe('RFC-271 验收条款的覆盖棘轮', () => {
  test('文档里定义的每条 AC 都在测试中被点名', () => {
    const acs = declaredAcs()
    // 先自证抽取有效：抽不到编号说明正则或路径坏了，那样下面的断言会**假绿**。
    expect(acs.length).toBeGreaterThan(50)
    expect(acs).toContain('AC-1')
    expect(acs).toContain('AC-B1')
    expect(acs).toContain('AC-K1')

    const corpus = testCorpus()
    // ⚠️ 用「编号 + 非字母数字边界」匹配：裸 `includes('AC-2')` 会被 `AC-24` 满足，
    // 于是一条真的没覆盖的 AC-2 会被 AC-24 顶替过去。
    const unnamed = acs.filter((ac) => !new RegExp(`${ac}(?![0-9A-Za-z])`).test(corpus))
    expect(unnamed).toEqual([])
  })

  // 验收清单第二条：「**I1–I14 逐条枚举**（不是「12 条」）」。同样机械化——
  // `invariants.md` 的对照表里第三列写着归属，标 `intent 特有` 的三条本 RFC 明确
  // 不需要（design 原话「— 本 RFC 不需要 —」），只要求**归引擎**的那些被点名。
  test('归引擎的不变量逐条在测试中被点名', () => {
    const src = readFileSync(resolve(RFC_DIR, 'invariants.md'), 'utf8')
    const engineOwned: string[] = []
    for (const line of src.split('\n')) {
      // `| I7      | finalize 与资源写同事务 | 引擎 + \`finalizeInTx\` | … |`
      const m = line.match(/^\|\s*\*{0,2}(I\d+)\*{0,2}\s*\|([^|]*)\|([^|]*)\|/)
      if (m === null) continue
      const owner = m[3]!.trim()
      if (owner.includes('intent 特有')) continue
      if (owner.includes('引擎')) engineOwned.push(m[1]!)
    }
    // 自证抽取有效：表格改版导致一条都抽不到时，下面的断言会假绿。
    expect(engineOwned.length).toBeGreaterThanOrEqual(11)
    expect(engineOwned).toContain('I13')
    expect(engineOwned).not.toContain('I10')

    const corpus = testCorpus()
    const unnamed = engineOwned.filter((i) => !new RegExp(`${i}(?![0-9])`).test(corpus))
    expect(unnamed).toEqual([])
  })

  test('边界匹配确实生效（前缀不得顶替）', () => {
    // 这条锁住上面那个正则的意图：`AC-2` 不能被 `AC-24` 满足。
    const corpus = 'covers AC-24 and AC-B2h'
    const hit = (ac: string): boolean => new RegExp(`${ac}(?![0-9A-Za-z])`).test(corpus)
    expect(hit('AC-24')).toBe(true)
    expect(hit('AC-2')).toBe(false)
    expect(hit('AC-B2h')).toBe(true)
    expect(hit('AC-B2')).toBe(false)
  })
})
