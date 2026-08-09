// RFC 索引状态漂移守卫（2026-07-15 加）。
//
// 为什么这条测试存在：一次对 `design/plan.md` 的全量核查发现 **4 条 RFC（108/177/179/
// 180）代码早已上库、索引却还挂着 Draft/In Progress**——加上同期发现的 184/186，是第
// 6、7 次「落地不回填」。最能说明问题的是 RFC-179：RFC-182 的作者**已经发现它陈旧、还在
// 自己的索引条目里写了「索引状态陈旧」——却没顺手改**。根因不是谁偷懒，而是**回填不在
// 任何一步的必经路径上**：实现 PR 不带索引更新，状态就永远冻在立项那天。代价是下一个
// 接手的人要么重复确认「到底做没做」，要么误判成没做而重做。
//
// 设计取舍（重要）：「这个 RFC 做完没有」**无法可靠自动判定**——只有作者知道。实测过两个
// 候选信号，都不成立：
//   · 「Draft + 有源码引用 = 红」→ 在途 RFC 会被误伤（当时 RFC-190 有 22 个源文件引用、
//     RFC-191 有 12 个，但它们正在实现中，Draft 是对的）；
//   · 「最近实现 commit 超过 N 天 = 陈旧」→ 任何后来的 commit 提到该编号就重置时钟
//     （RFC-180 陈旧了却显示「0 天前」，因为别的 commit 提到了它）。
// 所以这里只锁**零误报的硬矛盾**：文档/产物已经证明它落地了，状态格却还没回填。宁可漏报，
// 不可狼来了——一条天天误报的检查会被训练成无视，比没有更糟。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const PLAN = readFileSync(resolve(ROOT, 'design', 'plan.md'), 'utf8')
const STATE = readFileSync(resolve(ROOT, 'STATE.md'), 'utf8')
const MIGRATIONS = readdirSync(resolve(ROOT, 'packages', 'backend', 'db', 'migrations'))

/** 索引表的全部 RFC 行（编号 + 原始状态格）。 */
function indexRows(): { num: string; cell: string }[] {
  const out: { num: string; cell: string }[] = []
  for (const line of PLAN.split('\n')) {
    if (!/^\| \[RFC-\d+\]\(\.\/RFC-/.test(line)) continue
    // 表格列以**未转义**的 `|` 分隔；正文里的竖线写作 `\|`（见 plan.md 索引小节的登记格式）。
    const cells = line.split(/(?<!\\)\|/)
    if (cells.length !== 5) continue // 列数不对的行由下面「表格结构完好」单独报错
    out.push({ num: /RFC-(\d+)/.exec(cells[1] as string)![1] as string, cell: cells[3] as string })
  }
  return out
}

/**
 * RFC 编号 → 索引状态（Draft / In Progress / Done / Superseded）。
 *
 * 2026-08-09 重写解析器。旧实现是 `/\| ([A-Za-z ]+) \|\s*$/`——要求整个状态格
 * **只有 ASCII 字母和空格**，于是凡是写成 `**Done**（2026-07-02 交付…）` 这种带
 * 证据的行全被静默跳过：实测 268 行只解析出 140 行（52%），且 RFC-249…271 一条
 * 都没覆盖。守卫的 test #1 本意就是「解析不出来必须响，而不是零违规蒙混过关」，
 * 而它自己正是那个假绿。放宽后立刻抓到三条真漂移：RFC-230（`a2b32196` 已全量
 * 交付却挂 Draft 两周）、RFC-235（migration 已上库却挂 Draft）、RFC-239
 * （STATE.md 记 ✅ 已完成、索引却是 In Progress）。
 *
 * 现在只要求状态格**以四个词之一打头**，后面爱写多少证据写多少。
 */
function indexStatuses(): Map<string, string> {
  const out = new Map<string, string>()
  for (const { num, cell } of indexRows()) {
    const m = /^(Done|Draft|In Progress|Superseded)/.exec(cell.trim().replace(/\*/g, ''))
    if (m) out.set(num, m[1] as string)
  }
  return out
}

const ROWS = indexRows()
const STATUSES = indexStatuses()
/** 未完工的（本守卫只关心这些是否其实已经落地）。 */
const OPEN = [...STATUSES].filter(([, s]) => s !== 'Done' && s !== 'Superseded').map(([n]) => n)

describe('RFC 索引状态漂移守卫', () => {
  test('索引本身可解析（防止表格被改坏后守卫静默失效）', () => {
    // 守卫的前提是能读出状态格；解析不出来时必须响，而不是「零违规」蒙混过关。
    expect(ROWS.length).toBeGreaterThan(100)
    const unparsed = ROWS.filter(({ num }) => !STATUSES.has(num)).map(({ num, cell }) => {
      return `RFC-${num} 状态格未以 Draft / In Progress / Done / Superseded 打头：${cell.trim().slice(0, 60)}`
    })
    expect(
      unparsed,
      `状态格必须以四个词之一**打头**（后面接日期与证据随意）。\n` +
        `解析不出来的行会被本文件所有漂移检查静默跳过：\n  ` +
        unparsed.join('\n  '),
    ).toEqual([])
    // 覆盖率必须是 100%——旧解析器只认纯 ASCII 状态格，静默跳过 48% 的行。
    expect(STATUSES.size).toBe(ROWS.length)
  })

  // 2026-08-09 加：RFC-249…271 共 22 条曾以**表外散文段落**登记（`**[RFC-NNN](…) · 标题**：…`），
  // 于是「哪些 RFC 没收口」一次扫不出来，本文件的漂移检查对它们也完全失明。回填进表后加这三条
  // 结构锁，防止再漂。
  test('表格结构完好：每行三列、无表外散文条目、每个 RFC 目录都已登记', () => {
    const badCols: string[] = []
    for (const line of PLAN.split('\n')) {
      if (!/^\| \[RFC-\d+\]\(\.\/RFC-/.test(line)) continue
      const n = line.split(/(?<!\\)\|/).length - 2
      if (n !== 3) badCols.push(`${/RFC-\d+/.exec(line)?.[0]} 解析出 ${n} 列`)
    }
    expect(
      badCols,
      `正文里的 \`|\` 必须转义成 \`\\|\`（行内代码里的也要，GFM 照样按它切列），否则整行错列：\n  ` +
        badCols.join('\n  '),
    ).toEqual([])

    const prose = [...PLAN.matchAll(/^\*\*\[?RFC-(\d+)\]?/gm)].map((m) => `RFC-${m[1]}`)
    expect(
      prose,
      `RFC 必须登记为索引表的一行，不要在表外另起散文条目（表外条目扫不出状态）：\n  ` +
        prose.join(', '),
    ).toEqual([])

    const dirs = readdirSync(resolve(ROOT, 'design'))
      .filter((d) => /^RFC-\d+-/.test(d))
      .map((d) => /^RFC-(\d+)-/.exec(d)![1] as string)
    const unregistered = dirs.filter((n) => !STATUSES.has(n)).map((n) => `RFC-${n}`)
    expect(
      unregistered,
      `以下 RFC 有 design/ 目录却没在索引表里登记：\n  ${unregistered.join(', ')}`,
    ).toEqual([])
  })

  // 硬信号 1：schema 都上库了，不可能还是 Draft。
  // 校准：当时陈旧的 RFC-180 有 `0093_rfc180_workgroup_autonomous.sql` → 会被抓到；
  // 当时在途的 190/191/192 没有 migration → 不误报。
  test('已合并 migration 的 RFC，状态不得仍是 Draft', () => {
    // 2026-07-22 校准（RFC-217 首例分期 RFC）：migration 信号只抓 **Draft**。
    // In Progress + 已上库 migration 不是漂移——分期交付的 RFC（T2 先落表、
    // T5/T8 还在路上）状态格「仍在做」就是准确回填；本文件顶注也明确保护
    // 在途 RFC 不被误伤。整改文案从立守卫第一天就写着「或 In Progress
    //（若仍在做）」，过滤器此前与它相悖，以文案为准。
    const drift: string[] = []
    for (const n of [...STATUSES].filter(([, s]) => s === 'Draft').map(([n]) => n)) {
      // 用 (?![0-9]) 而非 \b：migration 文件名是 `0093_rfc180_workgroup_autonomous.sql`，
      // 而 `_` 是正则的 word 字符，`rfc180\b` 在 `rfc180_` 处**不成立**——这条规则曾因此
      // 静默失效（负向验证时 A/B 都响了只有它不响，才暴露出来）。
      const hit = MIGRATIONS.filter((f) => new RegExp(`rfc0*${n}(?![0-9])`, 'i').test(f))
      if (hit.length > 0) {
        drift.push(`RFC-${n}（状态 ${STATUSES.get(n)}）已合并 migration：${hit.join(', ')}`)
      }
    }
    expect(
      drift,
      `以下 RFC 的 migration 已经上库，说明至少已落地一部分，索引状态却没回填。\n` +
        `请在 design/plan.md 把状态改成 Done（若确已完工）或 In Progress（若仍在做）：\n  ` +
        drift.join('\n  '),
    ).toEqual([])
  })

  // 硬信号 2：文档里已有人白纸黑字说它落地了，状态格却没跟上。
  // 校准：RFC-182 写过 RFC-179「已落库」、RFC-181 写过「承接已落地 RFC-180」——两条都会被抓到。
  // 2026-08-09 校准（随解析器放宽同批）：与信号 1 的 RFC-217 校准同理，本信号也只抓 **Draft**。
  // 「已落地 / 已上库」只证明**有代码进去了**——对 Draft 是硬矛盾（Draft = 一行没落），对分期
  // 交付的 In Progress 则完全自洽。首例是 RFC-235：STATE.md 写着「首版实现切片…已落地」，而完整
  // 设计仍是 Draft v21 待第 21 轮设计门 + 用户批准，此时 In Progress 正是准确回填。
  // 「In Progress 其实早该 Done」那一类由信号 3 覆盖——它读的是强得多的「✅ 已完成 RFC」。
  test('已被文档断言「已落地/已落库」的 RFC，状态不得仍是 Draft', () => {
    const draftOnly = new Set([...STATUSES].filter(([, s]) => s === 'Draft').map(([n]) => n))
    const docs = `${PLAN}\n${STATE}`
    const CLAIM =
      /(?:已落地|承接已落地|已落库|已落 HEAD|全部落地|已上库)[^。\n]{0,40}RFC-(\d+)|RFC-(\d+)[^。\n]{0,60}(?:已落地|已落库|已落 HEAD|全部落地|已上库)/g
    const drift = new Set<string>()
    for (const m of docs.matchAll(CLAIM)) {
      const n = (m[1] ?? m[2]) as string
      if (draftOnly.has(n)) drift.add(`RFC-${n}（状态 ${STATUSES.get(n)}）`)
    }
    expect(
      [...drift],
      `以下 RFC 已被 design/plan.md 或 STATE.md 描述为「已落地/已落库」，状态格却仍是 Draft` +
        `（RFC-179 就是这样：RFC-182 早已注明它「索引状态陈旧」，但没人改）：\n  ` +
        [...drift].join('\n  '),
    ).toEqual([])
  })

  // 硬信号 3：STATE.md 与索引互相矛盾（一边说完成、一边说没完成）。
  test('STATE.md 标记「已完成」的 RFC，索引状态必须是 Done/Superseded', () => {
    const done = new Set<string>([
      ...[...STATE.matchAll(/✅ \*\*已完成 RFC[^:：]*[:：]\s*\[RFC-(\d+)/g)].map(
        (m) => m[1] as string,
      ),
      // 「已完成 RFC」表里的行
      ...[...STATE.matchAll(/^\| \[RFC-(\d+)\]\(\.\/design\/RFC-/gm)].map((m) => m[1] as string),
    ])
    const drift = [...done]
      .filter((n) => STATUSES.has(n) && OPEN.includes(n))
      .map((n) => `RFC-${n}：STATE.md 说已完成，design/plan.md 却是 ${STATUSES.get(n)}`)
    expect(drift, `STATE.md 与 RFC 索引互相矛盾：\n  ${drift.join('\n  ')}`).toEqual([])
  })
})
