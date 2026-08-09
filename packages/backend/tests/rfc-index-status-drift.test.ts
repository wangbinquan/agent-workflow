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

/** RFC 编号 → 索引状态格（Draft / In Progress / Done / Superseded）。 */
function indexStatuses(): Map<string, string> {
  const out = new Map<string, string>()
  const re = /^\| \[RFC-(\d+)\]\(\.\/RFC-[^)]+\).*?\| ([A-Za-z ]+) \|\s*$/gm
  for (const m of PLAN.matchAll(re)) out.set(m[1] as string, (m[2] as string).trim())
  return out
}

const STATUSES = indexStatuses()
/** 未完工的（本守卫只关心这些是否其实已经落地）。 */
const OPEN = [...STATUSES].filter(([, s]) => s !== 'Done' && s !== 'Superseded').map(([n]) => n)

describe('RFC 索引状态漂移守卫', () => {
  test('索引本身可解析（防止表格被改坏后守卫静默失效）', () => {
    // 守卫的前提是能读出状态格；解析不出来时必须响，而不是「零违规」蒙混过关。
    expect(STATUSES.size).toBeGreaterThan(100)
    for (const [n, s] of STATUSES) {
      expect(['Draft', 'In Progress', 'Done', 'Superseded'], `RFC-${n} 状态格非法：${s}`).toContain(
        s,
      )
    }
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
  test('已被文档断言「已落地/已落库」的 RFC，状态不得仍是 Draft/In Progress', () => {
    const docs = `${PLAN}\n${STATE}`
    const CLAIM =
      /(?:已落地|承接已落地|已落库|已落 HEAD|全部落地|已上库)[^。\n]{0,40}RFC-(\d+)|RFC-(\d+)[^。\n]{0,60}(?:已落地|已落库|已落 HEAD|全部落地|已上库)/g
    const drift = new Set<string>()
    for (const m of docs.matchAll(CLAIM)) {
      const n = (m[1] ?? m[2]) as string
      if (OPEN.includes(n)) drift.add(`RFC-${n}（状态 ${STATUSES.get(n)}）`)
    }
    expect(
      [...drift],
      `以下 RFC 已被 design/plan.md 或 STATE.md 描述为「已落地/已落库」，状态格却仍未回填` +
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
