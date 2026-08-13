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

/** finally 里那次 discard 的保护形态。 */
type Guard = 'try-catch' | 'dot-catch' | 'none'

function guardOfFinallyDiscard(fnSignature: string): Guard {
  const start = SCHEDULER.indexOf(fnSignature)
  expect(start, `未找到函数：${fnSignature}`).toBeGreaterThan(-1)
  const rest = SCHEDULER.slice(start)
  const finallyAt = rest.indexOf('} finally {')
  expect(finallyAt).toBeGreaterThan(-1)
  const block = rest.slice(finallyAt, finallyAt + 700)
  const discardAt = block.indexOf('discardNodeIso(')
  expect(discardAt, `${fnSignature} 的 finally 里应有 discardNodeIso`).toBeGreaterThan(-1)
  const tail = block.slice(discardAt, discardAt + 200)
  if (/\.catch\(/.test(tail)) return 'dot-catch'
  if (/try\s*\{[\s\S]{0,200}discardNodeIso/.test(block.slice(0, discardAt + 40))) return 'try-catch'
  return 'none'
}

describe('RFC-287 T1⑤ — iso 清理失败的处置现状（C3b 基线）', () => {
  test('剩余未迁线仍是「完全没兜」的现状', () => {
    // RFC-287 T3/T4 改锚：两条 fanout 线的 finally 已迁入骨架（骨架统一「吞掉并
    // 记 warn」，即 C3b 对它们已落地）；只剩 agent 线仍是现状。
    for (const sig of ['async function runOneNode(']) {
      expect(guardOfFinallyDiscard(sig), sig).toBe('none')
    }
  })

  test('脚本线用 .catch 吞', () => {
    expect(guardOfFinallyDiscard('async function runScriptNode(')).toBe('dot-catch')
  })

  test('工作组主机线用 try/catch 吞（best-effort）', () => {
    expect(guardOfFinallyDiscard('function buildWorkgroupHooks(')).toBe('try-catch')
  })
})
