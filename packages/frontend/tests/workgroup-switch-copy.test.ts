// 工作组三个协作开关命名归一 + goal hint 去内部枚举字面量（2026-07-14 用户拍板）。
//
// 为什么存在这条测试（未来任何 refactor 一旦把它变红，就能立刻看出改动违反了意图）：
//   1. 三开关最终命名沿「成果 vs 消息（点对点/广播）」轴。用户拍板：
//      产出互见→成果共享、定向消息→点对点消息、公共黑板→广播消息。
//      英文侧同步去掉 blackboard 隐喻（Public blackboard → Broadcast messages）；
//      Share outputs / Direct messages 英文本就贴合新语义，保留不动（其正则/精确
//      断言散落在 workgroup-form / workgroup-task-config / workgroup-room 测试里，
//      这里锁死英文值可防它们连锁踩红）。
//   2. launch.fieldGoalHint 曾把内部 enum 字面量 leader_worker / free_collab 直接
//      写进面向用户的中英文案（中文界面赫然读到下划线标识符，且与显示名对不上）。
//      这里锁死两个 locale 的 goal hint 都不得再出现 /leader_worker|free_collab/。

import { describe, expect, test } from 'vitest'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

describe('workgroup collaboration-switch copy', () => {
  test('zh-CN switch labels follow the 成果/点对点/广播 axis', () => {
    expect(zhCN.workgroups.fieldShareOutputs).toBe('成果共享')
    expect(zhCN.workgroups.fieldDirectMessages).toBe('点对点消息')
    expect(zhCN.workgroups.fieldBlackboard).toBe('广播消息')
    // 黑板隐喻不得残留在中文文案（含 hint）里。
    expect(zhCN.workgroups.fieldBlackboard).not.toMatch(/黑板/)
    expect(zhCN.workgroups.fieldBlackboardHint).not.toMatch(/黑板/)
  })

  test('en-US drops the blackboard metaphor; keeps outputs/direct wording', () => {
    expect(enUS.workgroups.fieldShareOutputs).toBe('Share outputs')
    expect(enUS.workgroups.fieldDirectMessages).toBe('Direct messages')
    expect(enUS.workgroups.fieldBlackboard).toBe('Broadcast messages')
    expect(enUS.workgroups.fieldBlackboard).not.toMatch(/blackboard/i)
  })

  test('goal hint no longer leaks internal enum literals in either locale', () => {
    for (const hint of [
      zhCN.workgroups.launch.fieldGoalHint,
      enUS.workgroups.launch.fieldGoalHint,
    ]) {
      expect(hint).not.toMatch(/leader_worker|free_collab/)
    }
  })
})
