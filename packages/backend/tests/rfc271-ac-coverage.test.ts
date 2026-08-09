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

/**
 * 把一条加粗声明展开成它实际声明的全部 AC 编号。
 *
 * `AC-26/27` -> [AC-26, AC-27]；`AC-30/30b` -> [AC-30, AC-30b]；
 * `AC-31~34` -> [AC-31, AC-32, AC-33, AC-34]；其余原样。
 */
export function expandAcDeclaration(raw: string): string[] {
  const body = raw.slice('AC-'.length)
  const range = body.match(/^([0-9]+)~([0-9]+)$/)
  if (range !== null) {
    const from = Number(range[1])
    const to = Number(range[2])
    if (from <= to && to - from < 100) {
      return Array.from({ length: to - from + 1 }, (_, i) => `AC-${from + i}`)
    }
  }
  return body.split('/').map((part) => `AC-${part}`)
}

/**
 * **唯一被批准的改判条款**。每一条都必须在 design/proposal 里同时留下删除线与
 * 「【已改判】」说明，两边缺一不可。
 *
 * · AC-11（超 SKILL_ZIP_LIMITS 就 422）—— 用户拍板「技能整棵树进包、不设任何上限」，
 *   截断会产出一个「看起来成功」的残包，比大包糟得多。
 */
const APPROVED_SUPERSEDED = new Set<string>(['AC-11'])

/**
 * 已知的验收条款**全集快照**（2026-08-09）。真值集必须**包含**它的每一条。
 *
 * 为什么不是「数量下限」：我先写的是 `acs.length >= 66`，反向验证时发现它挡不住去粗体
 * ——`**AC-12**` 在 proposal / design / plan 里都加粗，去掉一处后集合去重仍是 66，守卫
 * 一声不响。数量只能发现「某条在**唯一**一处被去粗体」，而这恰恰是最少见的情形。
 *
 * 所以照 RFC-223 的 allowlist 手法钉**具体编号**：任何一条从文档里消失（去粗体、删除、
 * 改名）都会点名报出来，必须**显式改判**——从这个列表里删掉它，并在 commit 里说明它
 * 为什么不再是验收条款。新增 AC 不需要动这里（超集即可）。
 */
const KNOWN_ACS: readonly string[] = [
  'AC-1',
  'AC-2',
  'AC-2b',
  'AC-3',
  'AC-4',
  'AC-4b',
  'AC-5',
  'AC-6',
  'AC-7',
  'AC-7b',
  'AC-7c',
  'AC-7d',
  'AC-8',
  'AC-9',
  'AC-10',
  // ⚠️ AC-11 **不在**这里：它是已批准的改判条款，由 `APPROVED_SUPERSEDED` 单独
  // 跟踪，`declaredAcs()` 会把它滤掉。两处都列会让这条守卫恒红。
  'AC-12',
  'AC-13',
  'AC-14',
  'AC-14b',
  'AC-15',
  'AC-15b',
  'AC-16',
  'AC-17',
  'AC-18',
  'AC-19',
  'AC-20',
  'AC-20b',
  'AC-21',
  'AC-22',
  'AC-23',
  'AC-24',
  'AC-24c',
  'AC-24d',
  'AC-24e',
  'AC-24f',
  'AC-24g',
  'AC-24h',
  'AC-25',
  'AC-25b',
  'AC-26',
  'AC-26b',
  'AC-27',
  'AC-28',
  'AC-29',
  'AC-30',
  'AC-30b',
  'AC-30c',
  'AC-31',
  'AC-32',
  'AC-33',
  'AC-34',
  'AC-B1',
  'AC-B2',
  'AC-B2b',
  'AC-B2c',
  'AC-B2d',
  'AC-B2e',
  'AC-B2f',
  'AC-B2g',
  'AC-B2h',
  'AC-B3',
  'AC-B3b',
  'AC-B4',
  'AC-B4b',
  'AC-B4c',
  'AC-B5',
  'AC-B6',
  'AC-K1',
  'AC-K2',
]

/** design/proposal/plan 里**加粗定义**的 AC 编号 —— 真值来源，不手抄。 */
function declaredAcs(): string[] {
  const found = new Set<string>()
  for (const name of readdirSync(RFC_DIR)) {
    if (!name.endsWith('.md')) continue
    const src = readFileSync(resolve(RFC_DIR, name), 'utf8')
    // 只认**加粗**的那种，正文里顺带提到一个编号不算「定义」。
    //
    // ⚠️ 文档里有**三种**写法，只认第一种会漏掉 8 条（实测 AC-26/27、AC-30/30b、
    // AC-31~34 全部抽不到，于是删掉它们的实现与测试守卫照样绿）：
    //   ① 单个     `**AC-7d**` / `**AC-B2h**` / `**AC-K1**`
    //   ② 斜杠复合 `**AC-26/27**` / `**AC-30/30b**`
    //   ③ 波浪范围 `**AC-31~34**`
    for (const m of src.matchAll(/\*\*(AC-[0-9A-Za-z/~]+)\*\*/g)) {
      for (const id of expandAcDeclaration(m[1]!)) found.add(id)
    }
    // **显式改判**的条款不再要求覆盖：`~~**AC-11**~~ 【已改判…】`。
    // 这条出口是必要的——产品决策会取消某条 AC（AC-11 就是用户拍板「技能整棵树进包、
    // 不设上限」取消的），逼着为一个**故意不实现**的行为写测试才是真的坏。
    // ⚠️ 但它必须**显式**：删掉 AC 或悄悄改文案都不算，必须留下删除线 + 改判说明，
    // 让下一个人看得见「这条为什么不见了」。
    for (const m of src.matchAll(/~~\*\*(AC-[0-9A-Za-z]+)\*\*~~\s*\*\*【已改判/g)) {
      // ⚠️ **只认白名单里的那几条**。不锁死的话，给任意一条 AC 包上删除线 +
      // 「已改判」就能把它连同它的测试一起免掉 —— 豁免出口本身变成绕过守卫的手段。
      // 要新增豁免，必须**同时**改这里（一次显式的、看得见的授权动作）。
      if (!APPROVED_SUPERSEDED.has(m[1]!)) continue
      found.delete(m[1]!)
    }
  }
  return [...found].sort()
}

/**
 * ⚠️ **语料必须限定在本 RFC 的测试内**，否则整条守卫是假绿的。
 *
 * AC 编号是**每个 RFC 各自的命名空间**：`rfc257-webhook-dispatch.test.ts` 里有
 * `AC-14`，`rfc109-sync-task-workflow.test.ts` 里有 `AC-7`……全仓 `AC-1`…`AC-47`
 * 被十几个 RFC 用过。第一版守卫扫了**所有**测试文件，于是 RFC-271 的 AC-1…AC-30
 * 几乎全被别的 RFC 的同名编号顶替 —— 它报「62 条全部点名」，而限定语料后实测有
 * **22 条根本没被点名**。跨 RFC 顶替比前缀顶替更隐蔽：编号完全相同，肉眼查不出来。
 *
 * 判据：文件名带 `rfc271`，或文件内容里出现 `RFC-271`（后者让前端 / e2e 里明确
 * 声明服务于本 RFC 的测试也能算数）。
 */
function testCorpus(): string {
  const chunks: string[] = []
  for (const dir of TEST_DIRS) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
      if (name === SELF) continue // 自身不算证据，否则错误信息里的编号会自匹配
      const src = readFileSync(resolve(dir, name), 'utf8')
      // ⚠️ 判据必须是**显式声明**，不能是「内容里出现过 RFC-271」：
      // `rfc270-privileged-node-read-lens.test.ts` 只因一句迁移注释提到 RFC-271，
      // 就让它里面 RFC-270 的 AC-2/3/4 成了 RFC-271 这三个编号的唯一命中 —— 又一种
      // 跨 RFC 顶替。所以只认①文件名带 rfc271，或②文件头写了「覆盖验收条款：」这个
      // 锚点（那是作者明确声明「本文件覆盖 RFC-271 的哪几条」）。
      if (!name.includes('rfc271') && !src.includes('覆盖验收条款：')) continue
      chunks.push(src)
    }
  }
  return chunks.join('\n')
}

describe('RFC-271 验收条款的覆盖棘轮', () => {
  test('文档里定义的每条 AC 都在测试中被点名', () => {
    const acs = declaredAcs()
    // 先自证抽取有效：抽不到编号说明正则或路径坏了，那样下面的断言会**假绿**。
    expect(acs.length).toBeGreaterThan(50)

    // **真值数棘轮**（实现门第三轮补）。上面那条 `> 50` 太松：真值只认加粗的
    // `**AC-x**`，所以在文档里把某一条的粗体去掉——一次看起来纯排版的编辑——就能让它
    // **静默退出真值集**，从此没人再要求它被覆盖。实测把 `**AC-12**` 改成 `AC-12`：
    // 真值 69 → 68，而守卫一声不响。
    //
    // 与 RFC-223 的 allowlist 同一手法：钉住**具体编号**，任何一条消失都点名报出来。
    const vanished = KNOWN_ACS.filter((ac) => !acs.includes(ac))
    expect(vanished).toEqual([])
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

  test('点名 AC 的文件必须真的有断言 —— 注释不算覆盖', () => {
    // 实现门第三轮的第二个假绿面：语料是**整份源码含注释**，最终只 regex 搜编号。
    // 于是把一个文件的行为断言全删光、只留文件头那句 `// 覆盖验收条款：AC-12`，
    // 棘轮照样报「已覆盖」。
    //
    // 完全堵死需要把「哪条断言对应哪条 AC」也机械化，那个代价远超收益（作者会开始
    // 写敷衍的一对一断言来喂守卫）。这里取一个便宜且有效的下限：**凡是声明了自己
    // 覆盖某些 AC 的文件，必须真的在跑断言**。它挡不住「断言写得烂」，但挡得住
    // 「断言被删干净、锚点留着」——那正是重构时最容易发生、也最难肉眼发现的一种。
    const offenders: string[] = []
    for (const dir of TEST_DIRS) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
        if (name === SELF) continue
        const src = readFileSync(resolve(dir, name), 'utf8')
        if (!src.includes('覆盖验收条款：')) continue
        // `expect(` 是本仓所有测试的断言入口（bun:test 与 vitest 同名）。
        if (!src.includes('expect(')) offenders.push(name)
      }
    }
    expect(offenders).toEqual([])
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
