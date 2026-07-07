// flag-audit W0（design/flag-audit-2026-07-07.md §4.6 / §3-5/6/7）——状态→chip 映射表驱动收口的回归锁。
//
// 收口前的三类漂移 bug（本文件逐一锁死，勿回退）：
//   1. noderunTone 三份拷贝对 `interrupted` 意见不一（任务表 amber、抽屉/会话切换器 gray）
//      → 单一 NODE_RUN_STATUS_KIND，canonical = 'warn'（与任务级 TASK_STATUS_KIND 一致）。
//   2. clarify 列表 self 行只判 `!== 'awaiting_human'`，已取消轮渲染绿色「已回答」
//      → CLARIFY_ROUND_STATUS_CHIP.canceled = neutral + 专属 label。
//   3. 评审决策映射 3 份 2 套色名体系（legacy green/red/blue/gray vs 语义名），superseded
//      只有 1 份处理 → DECISION_CHIP_KIND 单表 + 全语义色名；legacy 别名 class 已从
//      styles.css 删除，源码里不得再出现任何 legacy 色名 producer。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { NODE_RUN_STATUS } from '@agent-workflow/shared'
import { NODE_RUN_STATUS_KIND, nodeRunStatusToKind } from '../src/lib/noderun-status'
import { DECISION_CHIP_KIND, decisionChipKind } from '../src/lib/review/decisionChip'
import { CLARIFY_ROUND_STATUS_CHIP } from '../src/lib/clarify-status'
import { toolStatusKind, toolStatusLabel } from '../src/components/node-session/toolStatus'

const SRC_DIR = join(__dirname, '..', 'src')

function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkSources(p, out)
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p)
  }
  return out
}

describe('NODE_RUN_STATUS_KIND（noderunTone 三份拷贝收口）', () => {
  test('覆盖 NodeRunStatus 全集（新增状态时 Record 编译红 + 本断言双保险）', () => {
    for (const s of NODE_RUN_STATUS) {
      expect(NODE_RUN_STATUS_KIND[s], `missing kind for ${s}`).toBeTruthy()
    }
  })

  test('interrupted → warn（锁死 amber/gray 漂移的裁决）', () => {
    expect(nodeRunStatusToKind('interrupted')).toBe('warn')
  })
})

describe('DECISION_CHIP_KIND（评审决策 3 份映射收口）', () => {
  test('superseded → neutral（收口前 2/3 的映射静默漏掉它）', () => {
    expect(DECISION_CHIP_KIND.superseded).toBe('neutral')
  })

  test('tolerant accessor：未知/空决策回落 neutral 不抛错', () => {
    expect(decisionChipKind(null)).toBe('neutral')
    expect(decisionChipKind(undefined)).toBe('neutral')
    expect(decisionChipKind('not-a-decision')).toBe('neutral')
    expect(decisionChipKind('approved')).toBe('success')
  })
})

describe('CLARIFY_ROUND_STATUS_CHIP（已取消轮显示绿色「已回答」bug 锁）', () => {
  test('canceled 不是 success、label 也不是 statusAnswered', () => {
    const canceled = CLARIFY_ROUND_STATUS_CHIP.canceled
    expect(canceled.kind).toBe('neutral')
    expect(canceled.labelKey).toBe('clarify.list.statusCanceled')
  })

  test('abandoned → danger（cross 专属终态维持红色语义）', () => {
    expect(CLARIFY_ROUND_STATUS_CHIP.abandoned.kind).toBe('danger')
  })
})

describe('toolStatus（ConversationFlow/SubagentBlock 双拷贝 + fallback 漂移收口）', () => {
  test('未知状态：neutral + 原样回显（不再伪装成 pending）', () => {
    expect(toolStatusKind('weird-upstream-status')).toBe('neutral')
    expect(toolStatusLabel('weird-upstream-status', (k) => `t:${k}`)).toBe('weird-upstream-status')
  })

  test('已知状态走 i18n key', () => {
    expect(toolStatusKind('completed')).toBe('success')
    expect(toolStatusLabel('completed', (k) => `t:${k}`)).toBe('t:session.statusCompleted')
  })
})

describe('legacy 色名 producer 全量清零（styles.css 别名块已删，出现即裸奔）', () => {
  test('src/ 下不再出现 status-chip--{green,red,blue,gray,amber,warning} 与 legacy status-dot 色名', () => {
    const offenders: string[] = []
    for (const file of walkSources(SRC_DIR)) {
      const src = readFileSync(file, 'utf8')
      if (/status-chip--(green|red|blue|gray|amber|warning)\b/.test(src)) {
        offenders.push(`chip:${file}`)
      }
      if (/status-dot--(green|red|blue|gray|amber)\b/.test(src)) {
        offenders.push(`dot:${file}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('三个曾各自 fork tone 映射的文件不得再定义本地映射函数', () => {
    for (const rel of [
      'routes/tasks.detail.tsx',
      'components/NodeDetailDrawer.tsx',
      'components/node-session/SessionTab.tsx',
      'components/node-session/ConversationFlow.tsx',
      'components/node-session/SubagentBlock.tsx',
    ]) {
      const src = readFileSync(join(SRC_DIR, rel), 'utf8')
      expect(src, `${rel} re-forked a local tone mapper`).not.toMatch(
        /function (noderunTone|toneFor)\(/,
      )
    }
  })
})
