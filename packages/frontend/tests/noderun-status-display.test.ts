// Locks the contract between services/review.ts supersede markers and the
// frontend's user-facing status label. If services/review.ts changes the
// `superseded-by-review-*` prefix shape, this file must move with it.
//
// Why these cases matter: a "canceled" row produced by review iterate that
// kept worktree files should read as "Superseded", not "Canceled" — the
// user only thinks of "canceled" as something they did manually. The
// `-rollback` suffix is the reverse signal: rollback succeeded, the row
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
    clarifyIteration: partial.clarifyIteration ?? 0,
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    pid: partial.pid ?? null,
    exitCode: partial.exitCode ?? null,
    errorMessage: partial.errorMessage ?? null,
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
  test('plain superseded-by-review-iterated → superseded', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      errorMessage:
        'superseded-by-review-iterated: Replaced by retry_index 1 due to review iterated of rev_1',
    })
    expect(classifyCanceled(r)).toBe('superseded')
  })

  test('plain superseded-by-review-rejected → superseded', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      errorMessage: 'superseded-by-review-rejected: …',
    })
    expect(classifyCanceled(r)).toBe('superseded')
  })

  test('superseded-by-review-iterated-rollback → rollback', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      errorMessage:
        'superseded-by-review-iterated-rollback: Replaced by retry_index 1 due to review iterated of rev_1',
    })
    expect(classifyCanceled(r)).toBe('rollback')
  })

  test('superseded-by-review-rejected-rollback → rollback', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      errorMessage:
        'superseded-by-review-rejected-rollback: Replaced by retry_index 1 due to review rejected of rev_1',
    })
    expect(classifyCanceled(r)).toBe('rollback')
  })

  test('canceled row with null errorMessage is manual', () => {
    const r = makeRun({ id: 'a', status: 'canceled', errorMessage: null })
    expect(classifyCanceled(r)).toBe('manual')
  })

  test('canceled row with unrelated errorMessage is manual', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      errorMessage: 'task interrupted by user',
    })
    expect(classifyCanceled(r)).toBe('manual')
  })

  test('non-canceled status is always manual (no marker classification)', () => {
    for (const s of [
      'pending',
      'running',
      'done',
      'failed',
      'awaiting_review',
    ] as NodeRunStatus[]) {
      const r = makeRun({
        id: 's',
        status: s,
        // Even with a stray supersede-looking message we should ignore it
        // when status !== 'canceled' — services/review.ts never writes the
        // marker on a non-canceled row.
        errorMessage: 'superseded-by-review-iterated: not real',
      })
      expect(classifyCanceled(r)).toBe('manual')
    }
  })
})

describe('supersededDecision', () => {
  test('iterated marker (plain or rollback) → "iterated"', () => {
    expect(
      supersededDecision(
        makeRun({ id: 'a', status: 'canceled', errorMessage: 'superseded-by-review-iterated: …' }),
      ),
    ).toBe('iterated')
    expect(
      supersededDecision(
        makeRun({
          id: 'b',
          status: 'canceled',
          errorMessage: 'superseded-by-review-iterated-rollback: …',
        }),
      ),
    ).toBe('iterated')
  })

  test('rejected marker (plain or rollback) → "rejected"', () => {
    expect(
      supersededDecision(
        makeRun({ id: 'a', status: 'canceled', errorMessage: 'superseded-by-review-rejected: …' }),
      ),
    ).toBe('rejected')
    expect(
      supersededDecision(
        makeRun({
          id: 'b',
          status: 'canceled',
          errorMessage: 'superseded-by-review-rejected-rollback: …',
        }),
      ),
    ).toBe('rejected')
  })

  test('non-supersede canceled or non-canceled rows return null', () => {
    expect(
      supersededDecision(makeRun({ id: 'a', status: 'canceled', errorMessage: null })),
    ).toBeNull()
    expect(supersededDecision(makeRun({ id: 'b', status: 'failed' }))).toBeNull()
  })
})

describe('displayNoderunStatusKey', () => {
  test('superseded canceled row returns the friendly key', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      errorMessage: 'superseded-by-review-iterated: …',
    })
    expect(displayNoderunStatusKey(r)).toBe('noderunStatus.superseded')
  })

  test('rollback canceled row falls back to the per-status key (Canceled)', () => {
    const r = makeRun({
      id: 'a',
      status: 'canceled',
      errorMessage: 'superseded-by-review-rejected-rollback: …',
    })
    expect(displayNoderunStatusKey(r)).toBe('noderunStatus.canceled')
  })

  test('plain canceled row falls back to per-status key (Canceled)', () => {
    expect(
      displayNoderunStatusKey(makeRun({ id: 'a', status: 'canceled', errorMessage: null })),
    ).toBe('noderunStatus.canceled')
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
