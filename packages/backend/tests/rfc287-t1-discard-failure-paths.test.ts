// RFC-287 T1⑤ —— iso 清理失败的处置现状（C3b 的红→绿对基线）。
//
// 为什么存在：`discardNodeIso` **会抛**（nodeIsolation 里 deleteIsoRefs /
// anchorNewPathsAtDiscard / dropNodePoolRefs 都在 removeWorktree 的 try 之外），
// 而各条装配线对它的保护**互不相同**：
//   · 工作组主机线：try/catch 吞（best-effort）
//   · 脚本线：`.catch(() => {})` 吞
//   · agent / fanout 分片 / 聚合：**完全没兜** —— 从 finally 抛出会吃掉 return 值，
//     表现成「节点明明跑完了却报了个清理错」
// 骨架统一成「吞掉并记 warn」对后三条是**行为变更**（C3b），必须配红→绿，不能
// 靠「统一默认」偷渡。本文件先把现状钉死。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCHEDULER = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)
const NODE_MECHANICS = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'nodeMechanics.ts',
  ),
  'utf8',
)

// RFC-287 T7：五条线全部迁入骨架后，「逐函数看 finally 里那次 discard 的保护形态」
// 这个探针没有消费者了（scheduler.ts 里已无 finally-discard）——连同它的 Guard 类型
// 一起删掉，留着会让人以为还有未迁的线。
describe('RFC-287 T1⑤ — iso 清理失败的处置现状（C3b 基线）', () => {
  test('终局：scheduler.ts 里已无 finally-discard，C3b 对五条线全部落地', () => {
    // RFC-287 T7：agent 线是最后一条。此前本条断言的是「剩余未迁线仍是完全没兜」
    // ——那个集合到此**归零**，所以断言翻面：scheduler.ts 里不得再有任何「在
    // finally 里清理 iso」的站点，清理与其失败处置单点收敛在骨架。
    // 反向锁（比原来的正向枚举更强）：新写一条线若自己起 finally 清 iso，这里立刻红。
    const mechanics = `${SCHEDULER}\n${NODE_MECHANICS}`
    const finallyBlocks = [...mechanics.matchAll(/\bfinally\s*\{/g)].map((m) =>
      mechanics.slice(m.index ?? 0, (m.index ?? 0) + 900),
    )
    const offenders = finallyBlocks.filter((b) => b.includes('discardNodeIso('))
    expect(offenders.map((b) => b.slice(0, 120))).toEqual([])
    // 防空扫：scheduler.ts 里仍有 finally（只是都不清 iso 了），确保正则没整个失配。
    expect(finallyBlocks.length).toBeGreaterThan(0)
  })

  test('脚本线（已迁骨架）：清理由骨架统一「吞掉并记 warn」', () => {
    // RFC-287 T5c 落地时这条断言锁的是**本地** `.catch(() => {})`，注释却写着
    // 「外层再由骨架统一记 warn」——两句话互相矛盾：本地先吞掉，Promise 就变成
    // 成功，骨架的 `.catch(err => log.warn('iso discard failed'))` 根本不会触发。
    // 于是残留 worktree / ref 的清理失败全程静默，C3b 对这条线其实**没有**落地。
    // T14 实现门抓到后修掉本地那道吞法：五条线（L1/L4/L5/L6/L7）现在一致地把清理
    // 失败交给骨架单点处置，warn 真正可达。断言随之翻面。
    const body = NODE_MECHANICS.slice(NODE_MECHANICS.indexOf('async function runScriptNode('))
    const m = body.slice(0, 20000).match(/discardIso: async \(h: IsoLike\)[\s\S]{0,240}?\n {6}\}/)
    expect(m).not.toBeNull()
    expect(m![0]).toContain('discardNodeIso(')
    expect(m![0]).not.toMatch(/\.catch\(/)
    // 二轮门自查：只认 `.catch(` 的话，换成 `try { … } catch {}` 这种**同性质**吞法
    // 仍会全绿。agent 线与工作组线的同类锁本就带这一条，脚本线补齐。
    expect(m![0], '也不得用 try/catch 吞掉').not.toMatch(
      /try \{[\s\S]{0,160}await discardNodeIso\(/,
    )
  })

  test('agent 线（已迁骨架，T7 最后一条）：清理由骨架统一「吞掉并记 warn」', () => {
    // 迁移前本线是三条「完全没兜」之一：finally 抛出会吃掉 return 值，表现成
    // 「节点明明跑完了却报了个清理错」。骨架的 `.catch(+warn)` 落地了 C3b。
    const start = NODE_MECHANICS.indexOf('async function runAgentSingleNode(')
    expect(start).toBeGreaterThan(-1)
    // 窗口要够到函数尾：runOneNode 有 1400 行，取到下一个顶格 `}`。
    const end = NODE_MECHANICS.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    const body = NODE_MECHANICS.slice(start, end)
    expect(body).toMatch(/discardIso: async \(h\) => \{[\s\S]{0,400}await discardNodeIso\(/)
    expect(body).not.toMatch(/try \{[^}]{0,120}await discardNodeIso\(/)
  })

  test('工作组主机线（已迁骨架）：清理由骨架统一「吞掉并记 warn」', () => {
    // RFC-287 T6：该线的 finally 已迁入骨架。原来的 try/catch 吞法被骨架的
    // `.catch(+warn)` 取代——**同性质、更强**（原来 catch 里是静默的，现在有 warn），
    // 故 C3b 对它也已落地。注入实现本身不再自兜，兜底责任单点在骨架。
    const start = NODE_MECHANICS.indexOf('async function executeWorkgroupHostMechanics(')
    expect(start).toBeGreaterThan(-1)
    const body = NODE_MECHANICS.slice(start, start + 40000)
    expect(body).toMatch(/discardIso: async \(h: IsoLike\) => \{\s*\n\s*await discardNodeIso\(/)
    // 反向：本线不得再自己起 try/catch 兜清理（会把骨架的 warn 吃掉）。
    expect(body).not.toMatch(/try \{[^}]{0,120}await discardNodeIso\(/)
  })
})
