// RFC-355 T4（RFC-294 W4-E4a）—— apply 大事务里那半「能先算完再写」的部分，两个 provider
// 共用一份之后的正向 / 边界 / 错误覆盖。
//
// 为什么这些用例存在：这段计算此前在 `sqliteIntentApplyOperations` 与
// `postgresqlIntentApplyOperations` 里各抄了一份（约 120 行），**没有任何直接可断言的面**
// ——想验「基线在 prestage 期间被 rebase 掉要拒绝」或「复制的谱系记根不记直接来源」，
// 只能起一个完整的 apply。判据抄两份的代价 T1 已经实测过一次（同一处 changeset 校验两侧
// 真的漂了）。现在钉死在这里，两个 provider 谁改坏了都会红。

import { describe, expect, test } from 'bun:test'
import {
  appliedEntryOf,
  assertIntentApplyBaselineFresh,
  bundleCreatedNamesOf,
  intentApplyCommitMutationOf,
  requireOpForPlan,
} from '../src/modules/intent/application/applyCommitPlan'
import { intentApplyReplayOutcomeOf } from '../src/modules/intent/application/applyReplay'
import type { ResolvedIntentOp } from '../src/modules/intent/application/resolveChangeset'
import type { IntentContextManifest } from '../src/modules/intent/application/manifest'

const CLAIM = { contextRevision: 4, commitSeq: 7, handleWatermarkJson: '{}' }
const FRESH = {
  contextRevision: 4,
  currentDraftId: 'draft-1',
  inFlightTurnId: null,
  contextManifestJson: '[]',
}

describe('RFC-355 T4 —— 提交事务内的基线重验', () => {
  test('三项都对时通过（claim 期与事务内是同一个会话身份）', () => {
    expect(() =>
      assertIntentApplyBaselineFresh({
        claimSession: CLAIM,
        claimDraftId: 'draft-1',
        sessionNow: FRESH,
      }),
    ).not.toThrow()
  })

  test.each([
    ['会话在 prestage 期间被 rebase（代次变了）', { ...FRESH, contextRevision: 5 }],
    ['当前草稿被换成了别的（新一轮生成）', { ...FRESH, currentDraftId: 'draft-2' }],
    ['当前草稿被清空', { ...FRESH, currentDraftId: null }],
    ['又有一轮生成在飞', { ...FRESH, inFlightTurnId: 'turn-9' }],
  ])('%s ⇒ intent-baseline-stale', (_label, sessionNow) => {
    expect(() =>
      assertIntentApplyBaselineFresh({
        claimSession: CLAIM,
        claimDraftId: 'draft-1',
        sessionNow,
      }),
    ).toThrow(expect.objectContaining({ code: 'intent-baseline-stale' }) as unknown as Error)
  })

  test('会话行整个消失与三项不符同形——都是 intent-baseline-stale，不是 404', () => {
    expect(() =>
      assertIntentApplyBaselineFresh({
        claimSession: CLAIM,
        claimDraftId: 'draft-1',
        sessionNow: undefined,
      }),
    ).toThrow(expect.objectContaining({ code: 'intent-baseline-stale' }) as unknown as Error)
  })
})

describe('RFC-355 T4 —— 本 bundle 正在创建的名字', () => {
  test('只收 create、只收 workflow / workgroup 两类，其余一律不进桶', () => {
    const created = bundleCreatedNamesOf([
      { action: 'create', kind: 'workflow', payload: { name: 'wf-a' } },
      { action: 'create', kind: 'workgroup', payload: { name: 'wg-a' } },
      { action: 'update', kind: 'workflow', payload: { name: 'wf-updated' } },
      { action: 'create', kind: 'agent', payload: { name: 'agent-a' } },
    ])
    expect([...created.workflow]).toEqual(['wf-a'])
    expect([...created.workgroup]).toEqual(['wg-a'])
  })

  test('名字缺失 / 非字符串 / 空串都不进桶（进了会把重名校验挡在一个空名上）', () => {
    const created = bundleCreatedNamesOf([
      { action: 'create', kind: 'workflow', payload: {} },
      { action: 'create', kind: 'workflow', payload: { name: '' } },
      { action: 'create', kind: 'workflow', payload: { name: 42 } },
    ])
    expect(created.workflow.size).toBe(0)
  })
})

const OP = (over: Partial<ResolvedIntentOp> = {}): ResolvedIntentOp =>
  ({
    opId: 'op-1',
    resourceType: 'agent',
    resourceId: 'res-1',
    action: 'create',
    fromCopy: false,
    payload: { name: 'first' },
    ...over,
  }) as ResolvedIntentOp

describe('RFC-355 T4 —— plan 与 op 的同序不变量', () => {
  test('同序同 id ⇒ 原样返回那个 op', () => {
    const op = OP()
    expect(requireOpForPlan(op, { operationId: 'op-1' })).toBe(op)
  })

  test('下标越界 ⇒ 抛 intent-resource-plan-order-mismatch', () => {
    expect(() => requireOpForPlan(undefined, { operationId: 'op-1' })).toThrow(
      'intent-resource-plan-order-mismatch',
    )
  })

  test('错位（op-2 的结果会被记到 op-1 上）⇒ 同样抛', () => {
    expect(() => requireOpForPlan(OP({ opId: 'op-2' }), { operationId: 'op-1' })).toThrow(
      'intent-resource-plan-order-mismatch',
    )
  })
})

describe('RFC-355 T4 —— receipt 的 applied 行', () => {
  test('六个字段逐字取自已解析的 op（name 取 payload，不取 manifest）', () => {
    expect(
      appliedEntryOf(
        OP({
          opId: 'op-9',
          resourceType: 'workflow',
          resourceId: 'wf-9',
          action: 'update',
          fromCopy: true,
          payload: { name: 'nine' },
        } as Partial<ResolvedIntentOp>),
      ),
    ).toEqual({
      opId: 'op-9',
      resourceType: 'workflow',
      resourceId: 'wf-9',
      action: 'update',
      fromCopy: true,
      name: 'nine',
    })
  })
})

const manifestJson = (entries: IntentContextManifest): string => JSON.stringify(entries)

describe('RFC-355 T4 —— 关闭代次 + 挂载迁移一次算完', () => {
  test('没有 create / copy 时：只推进 commitSeq 与 contextRevision，manifest 原样', () => {
    const before: IntentContextManifest = []
    const mutation = intentApplyCommitMutationOf({
      claimSession: CLAIM,
      preCommitManifestJson: manifestJson(before),
      ops: [OP({ action: 'update' })],
    })
    expect(mutation.commitSeq).toBe(8)
    expect(mutation.contextRevision).toBe(5)
    expect(JSON.parse(mutation.contextManifestJson)).toEqual([])
  })

  test('create 会挂进 manifest（下一轮 dump 才补 fence，这里 dumped=false）', () => {
    const mutation = intentApplyCommitMutationOf({
      claimSession: CLAIM,
      preCommitManifestJson: manifestJson([]),
      ops: [OP({ resourceType: 'agent', resourceId: 'res-new' })],
    })
    const next = JSON.parse(mutation.contextManifestJson) as IntentContextManifest
    expect(next.map((entry) => entry.resourceId)).toEqual(['res-new'])
    expect(next[0]?.root).toBe(true)
  })

  test('复制记的是**根**不是直接来源：O→C1 之后再 C1→C2，C2 的谱系指向 O', () => {
    const before: IntentContextManifest = [
      {
        handle: 'a1',
        resourceType: 'agent',
        resourceId: 'c1',
        root: true,
        detail: true,
        copiedFromResourceId: 'origin',
      },
    ]
    const mutation = intentApplyCommitMutationOf({
      claimSession: CLAIM,
      preCommitManifestJson: manifestJson(before),
      ops: [
        OP({
          resourceId: 'c2',
          fromCopy: true,
          copiedFromHandle: 'a1',
        } as Partial<ResolvedIntentOp>),
      ],
    })
    const next = JSON.parse(mutation.contextManifestJson) as IntentContextManifest
    // 记 c1 会破坏「只保留最新副本」：origin→c1→c2 之后再 origin→c3 会退役 c1 而留下 c2。
    expect(next.find((entry) => entry.resourceId === 'c2')?.copiedFromResourceId).toBe('origin')
  })

  test('解析不出来的来源 handle 退化成「挂上副本、不追谱系」，不让提交失败', () => {
    const mutation = intentApplyCommitMutationOf({
      claimSession: CLAIM,
      preCommitManifestJson: manifestJson([]),
      ops: [
        OP({
          resourceId: 'c2',
          fromCopy: true,
          copiedFromHandle: 'handle-that-is-gone',
        } as Partial<ResolvedIntentOp>),
      ],
    })
    const next = JSON.parse(mutation.contextManifestJson) as IntentContextManifest
    expect(next.find((entry) => entry.resourceId === 'c2')?.copiedFromResourceId).toBeUndefined()
  })

  test('handle 水位随 create 前进——否则后一个代次会把同一个序号再发一次', () => {
    const mutation = intentApplyCommitMutationOf({
      claimSession: { ...CLAIM, handleWatermarkJson: '{}' },
      preCommitManifestJson: manifestJson([]),
      ops: [OP({ resourceType: 'agent', resourceId: 'res-new' })],
    })
    expect(JSON.parse(mutation.handleWatermarkJson)).not.toEqual({})
  })
})

describe('RFC-355 T4 —— clientMutationId 重放的三档', () => {
  test('已提交 ⇒ 原样返回当初的回执', () => {
    expect(
      intentApplyReplayOutcomeOf({
        id: 'j1',
        state: 'committed',
        receiptJson: '{"journalId":"j1","commitSeq":3,"applied":[]}',
        error: null,
      }),
    ).toEqual({ journalId: 'j1', commitSeq: 3, applied: [] })
  })

  test('已失败 ⇒ intent-apply-failed-replay，带上当初的错误文本', () => {
    expect(() =>
      intentApplyReplayOutcomeOf({ id: 'j1', state: 'failed', receiptJson: null, error: 'boom' }),
    ).toThrow(expect.objectContaining({ code: 'intent-apply-failed-replay' }) as unknown as Error)
  })

  test('失败但没记下原因 ⇒ 仍是同一个码，用兜底文案', () => {
    let thrown: unknown
    try {
      intentApplyReplayOutcomeOf({ id: 'j1', state: 'failed', receiptJson: null, error: null })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'intent-apply-failed-replay',
      message: 'this apply attempt failed',
    })
  })

  test.each(['prepared', 'applying'])(
    '%s ⇒ intent-apply-unsettled（那是崩掉、收敛还没扫到的一次，拒绝而不是猜）',
    (state) => {
      expect(() =>
        intentApplyReplayOutcomeOf({ id: 'j1', state, receiptJson: null, error: null }),
      ).toThrow(expect.objectContaining({ code: 'intent-apply-unsettled' }) as unknown as Error)
    },
  )

  test('committed 但 receiptJson 丢了 ⇒ 不是「成功」，落到 unsettled', () => {
    expect(() =>
      intentApplyReplayOutcomeOf({ id: 'j1', state: 'committed', receiptJson: null, error: null }),
    ).toThrow(expect.objectContaining({ code: 'intent-apply-unsettled' }) as unknown as Error)
  })
})
