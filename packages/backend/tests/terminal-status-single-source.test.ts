// flag-audit W0（design/flag-audit-2026-07-07.md §3-13 / dedup-audit `task-terminal-status-set`）
// —— 终态集合单源化的回归锁。
//
// 收口前的三类病：
//   1. gc / stuckTaskDetector / fusion / lifecycleRepair R1&R2 各手抄一份终态数组，
//      其中 gc 的裸字面量无 satisfies 守卫（TASK_STATUS 扩枚举时 GC 静默漏收）。
//   2. services/taskQuestions.ts 导出过一个与 shared 同名不同义的 TERMINAL_TASK_STATUSES
//      （2 值「问题不再派发」策略 vs 4 值生命周期终态）——structuralDiff/store.ts 已被迫
//      别名导入避坑。现更名 QUESTION_DISPATCH_CLOSED_TASK_STATUSES。
//   3. orphans.ts 写 / autoResume.ts 读的 'daemon-restart' 是两个独立裸字面量——写侧改
//      一个字即静默瘫痪开机自动恢复。现双端 import 同一 shared 常量。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DAEMON_RESTART_ERROR_SUMMARY, TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import { QUESTION_DISPATCH_CLOSED_TASK_STATUSES } from '../src/services/taskQuestions'

const SRC = (rel: string) => readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')

// 手抄终态数组的特征串（4 值任务终态按固定顺序排列的字面量序列）。
const HAND_COPIED_TERMINAL = /'done',\s*\n?\s*'failed',\s*\n?\s*'canceled',\s*\n?\s*'interrupted'/

describe('终态集合单源化（flag-audit W0）', () => {
  test('曾手抄终态数组的五个文件已全部改引 shared', () => {
    for (const rel of [
      'services/gc.ts',
      'services/stuckTaskDetector.ts',
      'services/fusion.ts',
      'services/lifecycleRepair/options-R1.ts',
      'services/lifecycleRepair/options-R2.ts',
    ]) {
      expect(HAND_COPIED_TERMINAL.test(SRC(rel)), `${rel} still hand-copies the terminal set`).toBe(
        false,
      )
    }
  })

  test('同名异义陷阱已拆除：taskQuestions 不再导出 TERMINAL_TASK_STATUSES', () => {
    const src = SRC('services/taskQuestions.ts')
    expect(src).not.toMatch(/export const TERMINAL_TASK_STATUSES/)
    // 更名后的问题派发关闭集语义不变（刻意窄于生命周期终态——failed/interrupted 可恢复）。
    expect([...QUESTION_DISPATCH_CLOSED_TASK_STATUSES].sort()).toEqual(['canceled', 'done'])
    expect(QUESTION_DISPATCH_CLOSED_TASK_STATUSES.size).toBeLessThan(TERMINAL_TASK_STATUSES.length)
  })

  test('daemon-restart 标记双端共用 shared 常量（写改字瘫痪 autoResume 的病根拆除）', () => {
    expect(DAEMON_RESTART_ERROR_SUMMARY).toBe('daemon-restart')
    for (const rel of ['services/orphans.ts', 'services/autoResume.ts']) {
      const src = SRC(rel)
      expect(src).toContain('DAEMON_RESTART_ERROR_SUMMARY')
      // 生产代码不得再出现裸字面量（注释里允许）。
      const codeOnly = src
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
        .join('\n')
      expect(codeOnly).not.toContain("'daemon-restart'")
    }
  })
})
