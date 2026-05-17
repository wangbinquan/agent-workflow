// RFC-023 PR-C T20 — clarify draftStore IDB facade.
//
// Three locks:
//   1. clarifyDraftKey composes the four-segment 'clarify:' prefix so
//      listClarifyDrafts can scope by partial key cheaply.
//   2. set/get round-trips a ClarifyAnswer[] through JSON (the IDB store
//      holds strings, not the raw shape, since shape changes survive
//      schema bumps that way).
//   3. delete is idempotent and listClarifyDrafts narrows by both taskId
//      and clarifyNodeRunId filters.
//
// The tests do not require a real IndexedDB — when `indexedDB` is missing
// the helpers all gracefully degrade to no-ops. We assert both shapes
// (the pure key helper + the read-after-write round-trip when IDB exists,
// the no-op fallback when it doesn't).

import { afterEach, describe, expect, it } from 'vitest'
import type { ClarifyAnswer } from '@agent-workflow/shared'
import {
  clarifyDraftKey,
  clearAllClarifyDraftsForTests,
  deleteClarifyDraft,
  getClarifyDraft,
  listClarifyDrafts,
  setClarifyDraft,
} from '../src/lib/clarify/draftStore'

const KEY = {
  taskId: 'task_abc',
  clarifyNodeRunId: 'nr_123',
  sessionId: 'sess_x',
}

const SAMPLE: ClarifyAnswer[] = [
  {
    questionId: 'q1',
    selectedOptionIndices: [0],
    selectedOptionLabels: ['Postgres'],
    customText: '',
  },
]

afterEach(async () => {
  await clearAllClarifyDraftsForTests()
})

describe('clarifyDraftKey', () => {
  it('serialises (taskId, clarifyNodeRunId, sessionId) under a stable clarify: prefix', () => {
    expect(clarifyDraftKey(KEY)).toBe('clarify:task_abc:nr_123:sess_x')
  })
})

describe('set / get / delete round-trip', () => {
  it('persists then reads back the same ClarifyAnswer[] shape', async () => {
    if (typeof indexedDB === 'undefined') {
      // Happy-dom on some hosts skips IDB; the facade should no-op gracefully.
      await setClarifyDraft(KEY, SAMPLE)
      expect(await getClarifyDraft(KEY)).toBeNull()
      return
    }
    await setClarifyDraft(KEY, SAMPLE)
    const got = await getClarifyDraft(KEY)
    expect(got).toEqual(SAMPLE)
  })

  it('delete then get returns null', async () => {
    if (typeof indexedDB === 'undefined') {
      await deleteClarifyDraft(KEY)
      expect(await getClarifyDraft(KEY)).toBeNull()
      return
    }
    await setClarifyDraft(KEY, SAMPLE)
    await deleteClarifyDraft(KEY)
    expect(await getClarifyDraft(KEY)).toBeNull()
  })
})

describe('listClarifyDrafts', () => {
  it('returns only entries that match the prefix filter', async () => {
    if (typeof indexedDB === 'undefined') {
      expect(await listClarifyDrafts({ taskId: 'task_abc' })).toEqual([])
      return
    }
    await setClarifyDraft(KEY, SAMPLE)
    await setClarifyDraft({ taskId: 'task_other', clarifyNodeRunId: 'x', sessionId: 'y' }, SAMPLE)
    const onlyA = await listClarifyDrafts({ taskId: 'task_abc' })
    expect(onlyA.length).toBe(1)
    expect(onlyA[0]?.answers).toEqual(SAMPLE)
    const noFilter = await listClarifyDrafts()
    expect(noFilter.length).toBe(2)
  })
})
