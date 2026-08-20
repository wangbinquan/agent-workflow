// RFC-310 T58 余项 —— verification 结果升为 catalog fact。
//
// 为什么这条值得单独立一个文件：`verification.repair` 这条能力从 PR-4 起就存在
// （capability 定义、envelope 成员、validator 全都在），但它**永远排不上**——
// verification 的结果只写进 `__delivery.*` 内部 cells，而规则谓词只能读 closed
// catalog 里登记的 fact。于是无论跑挂了什么，发布链一律以 typed block
// `verification-failed:<profile>` 收场，组织连「失败就派修复」这条最基本的规则都
// **写不出来**（写了会在 publish 期被 catalog 以 unknown-fact 拒掉）。
//
// 锁三层：①投影口径（required 覆盖度与「跑过的都过了」是两件事）；②catalog 准入
// （规则现在写得出来，且 phase 门仍然生效）；③真实链路——跑挂一个 profile 之后，
// 三个 fact 确实出现在 mission 的 cells 里，规则读得到。

import { describe, expect, test } from 'bun:test'

import {
  buildFactSnapshot,
  checkPredicateAgainstCatalog,
  evaluatePredicate,
  factLeaf,
} from '../src/modules/development-automation/domain/facts'
import { projectVerificationCells } from '../src/modules/development-automation/domain/verificationFacts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import type { FactCellValue } from '../src/modules/development-automation/domain/facts'

function valueOf(
  cells: Record<string, FactCell<FactCellValue>>,
  id: string,
): FactCellValue | 'not-known' {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' ? cell.value : 'not-known'
}

describe('RFC-310 —— verification 结果的 catalog fact 投影', () => {
  test('projection distinguishes "not run yet" from "ran and passed"', () => {
    const none = projectVerificationCells({}, ['unit@1'], 'rev')
    expect({
      last: valueOf(none, 'verification.lastOutcome'),
      all: valueOf(none, 'verification.allRequiredPassed'),
      failed: valueOf(none, 'verification.failedProfileRefs'),
    }).toEqual({ last: 'not-run', all: false, failed: [] })

    // 一个 required 跑过了、另一个还没：**不能**算 allRequiredPassed。
    // 「还没跑」不是「通过了」——与 pipeline 那组同一条硬边界。
    const partial = projectVerificationCells({ 'unit@1': 'passed' }, ['unit@1', 'e2e@2'], 'rev')
    expect({
      last: valueOf(partial, 'verification.lastOutcome'),
      all: valueOf(partial, 'verification.allRequiredPassed'),
      failed: valueOf(partial, 'verification.failedProfileRefs'),
    }).toEqual({ last: 'passed', all: false, failed: [] })

    const allPassed = projectVerificationCells(
      { 'unit@1': 'passed', 'e2e@2': 'passed' },
      ['unit@1', 'e2e@2'],
      'rev',
    )
    expect(valueOf(allPassed, 'verification.allRequiredPassed')).toBe(true)
  })

  test('failed profiles are enumerated; a non-required failure still marks lastOutcome failed', () => {
    const cells = projectVerificationCells(
      { 'unit@1': 'passed', 'e2e@2': 'failed', 'lint@1': 'failed' },
      ['unit@1'],
      'rev',
    )
    expect({
      last: valueOf(cells, 'verification.lastOutcome'),
      // required（unit@1）确实全过 ⇒ 发布放行判据成立……
      all: valueOf(cells, 'verification.allRequiredPassed'),
      // ……但跑挂的那两个照样如实列出，不因为「不是 required」就消失。
      failed: valueOf(cells, 'verification.failedProfileRefs'),
    }).toEqual({ last: 'failed', all: true, failed: ['e2e@2', 'lint@1'] })
  })

  test('the three leaves are in the closed catalog, post-admission only', () => {
    for (const id of [
      'verification.lastOutcome',
      'verification.allRequiredPassed',
      'verification.failedProfileRefs',
    ]) {
      const leaf = factLeaf(id)
      expect(leaf).toBeDefined()
      expect(leaf!.group).toBe('verification')
      // admission 时还没有 candidate、更没跑过 verification：读它没有意义，
      // 与 pipeline/mr 那两组同款 phase 约束。
      expect(leaf!.phases).toEqual(['action-decision', 'readiness'])
    }
  })

  test('a repair rule reading verification.* now passes the catalog gate (it did not before)', () => {
    const predicate = {
      kind: 'boolean-is' as const,
      fact: 'verification.allRequiredPassed',
      value: false,
    }
    // action-decision 阶段：这正是「失败就派 verification.repair」要写的规则。
    expect(checkPredicateAgainstCatalog(predicate, 'action-decision')).toEqual([])
    // admission 阶段仍然拒——phase 门没有被这次扩容放宽。
    expect(checkPredicateAgainstCatalog(predicate, 'admission-selection')).toEqual([
      {
        code: 'phase-not-allowed',
        factId: 'verification.allRequiredPassed',
        detail: "phase 'admission-selection' cannot read this fact",
      },
    ])
  })

  test('the projected cells actually satisfy such a rule', () => {
    const cells = projectVerificationCells({ 'unit@1': 'failed' }, ['unit@1'], 'rev')
    const snapshot = buildFactSnapshot({
      missionRevision: 0,
      capturedAt: '2026-08-20T00:00:00+00:00',
      cells,
    })
    expect(
      evaluatePredicate(snapshot, {
        kind: 'boolean-is',
        fact: 'verification.allRequiredPassed',
        value: false,
      }).value,
    ).toBe(true)
    expect(
      evaluatePredicate(snapshot, {
        kind: 'set-contains-any',
        fact: 'verification.failedProfileRefs',
        values: ['unit@1'],
      }).value,
    ).toBe(true)
  })
})
