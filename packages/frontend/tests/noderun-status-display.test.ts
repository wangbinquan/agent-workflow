// Locks the contract between services/review.ts supersede writes and the
// frontend's user-facing status label. RFC-145: the contract is the
// STRUCTURED DTO fields (supersededByReview / rolledBack) — errorMessage is
// human breadcrumbs only, and review.ts wording changes can no longer break
// this classification (the old prefix lock-step note is retired).
//
// Why these cases matter: a "canceled" row produced by review iterate that
// kept worktree files should read as "Superseded", not "Canceled" — the
// user only thinks of "canceled" as something they did manually.
// rolledBack === true is the reverse signal: rollback succeeded, the row
// IS truly canceled, label stays "Canceled".

import { describe, expect, test } from 'vitest'
import { NodeRunStatusSchema, type NodeRun, type NodeRunStatus } from '@agent-workflow/shared'
import {
  classifyCanceled,
  displayNoderunStatusKey,
  supersededDecision,
} from '../src/lib/noderun-status'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

function makeRun(partial: Partial<NodeRun> & { id: string }): NodeRun {
  return {
    id: partial.id,
    taskId: 't1',
    nodeId: partial.nodeId ?? 'n1',
    parentNodeRunId: partial.parentNodeRunId ?? null,
    iteration: partial.iteration ?? 0,
    shardKey: partial.shardKey ?? null,
    retryIndex: partial.retryIndex ?? 0,
    reviewIteration: partial.reviewIteration ?? 0,
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    pid: partial.pid ?? null,
    exitCode: partial.exitCode ?? null,
    errorMessage: partial.errorMessage ?? null,
    supersededByReview: partial.supersededByReview ?? null,
    rolledBack: partial.rolledBack ?? null,
    promptText: partial.promptText ?? null,
    tokInput: partial.tokInput ?? null,
    tokOutput: partial.tokOutput ?? null,
    tokTotal: partial.tokTotal ?? null,
    tokCacheCreate: partial.tokCacheCreate ?? null,
    tokCacheRead: partial.tokCacheRead ?? null,
    opencodeSessionId: partial.opencodeSessionId ?? null,
  }
}

describe('classifyCanceled', () => {
  test('superseded (iterated, files kept) → superseded', () => {
    const r = makeRun({ id: 'a', status: 'canceled', supersededByReview: 'iterated' })
    expect(classifyCanceled(r)).toBe('superseded')
  })

  test('superseded (rejected, files kept) → superseded', () => {
    const r = makeRun({ id: 'a', status: 'canceled', supersededByReview: 'rejected' })
    expect(classifyCanceled(r)).toBe('superseded')
  })

  test('superseded + rolledBack (iterated) → rollback', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      supersededByReview: 'iterated',
      rolledBack: true,
    })
    expect(classifyCanceled(r)).toBe('rollback')
  })

  test('superseded + rolledBack (rejected) → rollback', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      supersededByReview: 'rejected',
      rolledBack: true,
    })
    expect(classifyCanceled(r)).toBe('rollback')
  })

  test('canceled row without supersede lineage is manual', () => {
    const r = makeRun({ id: 'a', status: 'canceled' })
    expect(classifyCanceled(r)).toBe('manual')
  })

  test('canceled row with legacy-looking errorMessage but NULL columns is manual（机器地位已取消）', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      errorMessage: 'superseded-by-review-iterated: breadcrumb only',
    })
    expect(classifyCanceled(r)).toBe('manual')
  })

  test('non-canceled status is always manual (no supersede classification)', () => {
    for (const s of [
      'pending',
      'running',
      'done',
      'failed',
      'awaiting_review',
    ] as NodeRunStatus[]) {
      // Even with stray supersede fields we ignore them when status !==
      // 'canceled' — services/review.ts only writes them on the canceled flip.
      const r = makeRun({ id: 's', status: s, supersededByReview: 'iterated' })
      expect(classifyCanceled(r)).toBe('manual')
    }
  })
})

describe('supersededDecision', () => {
  test('iterated（含 rollback）→ "iterated"', () => {
    expect(
      supersededDecision(makeRun({ id: 'a', status: 'canceled', supersededByReview: 'iterated' })),
    ).toBe('iterated')
    expect(
      supersededDecision(
        makeRun({ id: 'b', status: 'canceled', supersededByReview: 'iterated', rolledBack: true }),
      ),
    ).toBe('iterated')
  })

  test('rejected（含 rollback）→ "rejected"', () => {
    expect(
      supersededDecision(makeRun({ id: 'a', status: 'canceled', supersededByReview: 'rejected' })),
    ).toBe('rejected')
    expect(
      supersededDecision(
        makeRun({ id: 'b', status: 'canceled', supersededByReview: 'rejected', rolledBack: true }),
      ),
    ).toBe('rejected')
  })

  test('non-supersede canceled or non-canceled rows return null', () => {
    expect(supersededDecision(makeRun({ id: 'a', status: 'canceled' }))).toBeNull()
    expect(
      supersededDecision(makeRun({ id: 'b', status: 'failed', supersededByReview: 'iterated' })),
    ).toBeNull()
  })
})

describe('displayNoderunStatusKey', () => {
  test('superseded canceled row returns the friendly key', () => {
    const r = makeRun({ id: 'a', status: 'canceled', supersededByReview: 'iterated' })
    expect(displayNoderunStatusKey(r)).toBe('noderunStatus.superseded')
  })

  test('rollback canceled row falls back to the per-status key (Canceled)', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      supersededByReview: 'rejected',
      rolledBack: true,
    })
    expect(displayNoderunStatusKey(r)).toBe('noderunStatus.canceled')
  })

  test('plain canceled row falls back to per-status key (Canceled)', () => {
    expect(displayNoderunStatusKey(makeRun({ id: 'a', status: 'canceled' }))).toBe(
      'noderunStatus.canceled',
    )
  })

  test('every NodeRunStatus value gets a per-status key when not superseded', () => {
    const all: NodeRunStatus[] = [
      'pending',
      'running',
      'done',
      'failed',
      'canceled',
      'interrupted',
      'skipped',
      'exhausted',
      'awaiting_review',
      'awaiting_human',
    ]
    for (const s of all) {
      expect(displayNoderunStatusKey(makeRun({ id: s, status: s }))).toBe(`noderunStatus.${s}`)
    }
  })
})

// Every status the backend can emit must have a label in both locales —
// noderun-status.ts:77 builds the i18n key as `noderunStatus.${rawStatus}`,
// so a missing entry surfaces as the raw key (e.g. "noderunStatus.awaiting_human")
// to end users. RFC-023 added `awaiting_human` and the labels were forgotten;
// this lock catches the next time it happens.
describe('noderunStatus i18n coverage', () => {
  const allStatuses = NodeRunStatusSchema.options as NodeRunStatus[]
  test.each(allStatuses)('zh-CN has noderunStatus.%s', (s) => {
    const label = (zhCN.noderunStatus as unknown as Record<string, string>)[s]
    expect(label, `missing zh-CN noderunStatus.${s}`).toBeTruthy()
  })
  test.each(allStatuses)('en-US has noderunStatus.%s', (s) => {
    const label = (enUS.noderunStatus as unknown as Record<string, string>)[s]
    expect(label, `missing en-US noderunStatus.${s}`).toBeTruthy()
  })
})
