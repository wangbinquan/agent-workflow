// RFC-108 T13 (AR-07) — autoApplyEligible classifier + the auto-apply selector.
//
// 为什么这条测试存在：自动修复 loop（T19）只有在「规则恰有一个 autoApplyEligible +
// available 的选项」时才无人值守地应用，否则升级给人。`autoApplyEligible` 必须满足
// 硬安全不变式（risk==='low' && !destructive）——否则分类器会把破坏性/中高危选项判成
// 可自动应用。本测试：
//   ① 对全部已实现修复选项断言不变式（autoApplyInvariantHolds）；
//   ② 锁定 v1 eligible 集 = 恰 {S4.kick-task}（决策 D5「首发仅 S4.kick」，防误扩）；
//   ③ selectAutoApplyOption 只在「恰一个 eligible+available」时返回，零/多个 → null。

import { describe, expect, test } from 'bun:test'

import {
  autoApplyInvariantHolds,
  selectAutoApplyOption,
  type RepairOption,
} from '@agent-workflow/shared'

import { OPTION_DEFINITIONS } from '../src/modules/task-execution/infrastructure/postgresqlTaskRouteRepairOperations'

// RFC-359 第 8 刀：两份修复实现合成一份，这里读的就是那唯一一张元数据表。
const ALL_OPTIONS: RepairOption[] = Object.values(OPTION_DEFINITIONS) as RepairOption[]

describe('RFC-108 T13 — autoApplyEligible safety invariant', () => {
  test('every repair option satisfies: autoApplyEligible ⟹ risk===low && !destructive', () => {
    for (const o of ALL_OPTIONS) {
      expect(autoApplyInvariantHolds(o)).toBe(true)
    }
  })

  test('v1 auto-eligible set is EXACTLY {S4.kick-task} (decision D5 — conservative start)', () => {
    const eligible = ALL_OPTIONS.filter((o) => o.autoApplyEligible === true)
      .map((o) => o.id)
      .sort()
    expect(eligible).toEqual(['S4.kick-task'])
  })

  test('no acknowledge / mark-failed / cancel / U1 / reopen option is auto-eligible', () => {
    for (const o of ALL_OPTIONS) {
      if (
        o.id.endsWith('.acknowledge') ||
        o.id.endsWith('.mark-task-failed') ||
        o.id.endsWith('.cancel-task') ||
        o.rule === 'U1' ||
        o.id.endsWith('.reopen-session')
      ) {
        expect(o.autoApplyEligible ?? false).toBe(false)
      }
    }
  })
})

describe('RFC-108 T13 — selectAutoApplyOption (the loop gate)', () => {
  const mk = (id: string, autoApplyEligible: boolean, available: boolean): RepairOption => ({
    id,
    rule: 'S4',
    labelKey: 'l',
    descriptionKey: 'd',
    risk: 'low',
    destructive: false,
    autoApplyEligible,
    available,
    previewSteps: [],
  })

  test('exactly one eligible+available → returns it', () => {
    const got = selectAutoApplyOption([mk('a', true, true), mk('b', false, true)])
    expect(got?.id).toBe('a')
  })

  test('eligible but NOT available → null', () => {
    expect(selectAutoApplyOption([mk('a', true, false)])).toBeNull()
  })

  test('two eligible+available → null (ambiguous, escalate to human)', () => {
    expect(selectAutoApplyOption([mk('a', true, true), mk('b', true, true)])).toBeNull()
  })

  test('zero eligible → null', () => {
    expect(selectAutoApplyOption([mk('a', false, true), mk('b', false, true)])).toBeNull()
  })
})
