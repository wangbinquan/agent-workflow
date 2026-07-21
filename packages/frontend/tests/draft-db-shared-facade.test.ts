// design/test-guard-audit-2026-07-21 gap F3-review-1 (P0) — the clarify and
// review draft stores share ONE IndexedDB (`agent-workflow-drafts`). Before the
// fix each opened it with its own version + its own upgrade handler: review at
// v1, clarify at v2. IndexedDB has one version per DB, so once clarify opened it
// at v2, review's `open(name, 1)` threw VersionError → review draft persistence
// silently died. review/draftStore.ts had ZERO tests.
//
// TESTABILITY NOTE: happy-dom provides no `indexedDB`, so the version-conflict
// cannot be reproduced behaviourally here (both stores take the null-DB no-op
// path). Real behavioural IDB testing needs `fake-indexeddb` — a follow-up that
// would also un-no-op the existing clarify round-trip. Until then the recurrence
// guard is STRUCTURAL: the drift that caused the bug was two files declaring
// their own version/opener, so assert that (a) both go through the single
// façade and (b) every store they use is one the façade creates. That is the
// exact invariant, and a config-consistency invariant is legitimately a
// source-level lock (same class as the CI-topology / migration-breakpoint
// guards) — not text-assertion masquerading as behaviour.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DRAFT_DB_NAME, DRAFT_DB_VERSION, DRAFT_STORES, openDraftDb } from '../src/lib/draftDb'
import { getDraft, setDraft, deleteDraft, listDrafts } from '../src/lib/review/draftStore'
import { getClarifyDraft, setClarifyDraft, listClarifyDrafts } from '../src/lib/clarify/draftStore'

const src = (rel: string): string => readFileSync(resolve(__dirname, '..', 'src', rel), 'utf8')

describe('shared draft DB façade (F3)', () => {
  it('declares a single version and every feature store', () => {
    expect(DRAFT_DB_NAME).toBe('agent-workflow-drafts')
    expect([...DRAFT_STORES].sort()).toEqual(['clarify-drafts', 'review-drafts'])
    // Version must be at least the store count so an all-stores-idempotent
    // upgrade has actually run for each.
    expect(DRAFT_DB_VERSION).toBeGreaterThanOrEqual(DRAFT_STORES.length)
  })

  it('every store a draft file uses is created by the façade', () => {
    // The original bug was review using a store/version the shared upgrade
    // didn't account for. Pin the store name each file operates on and require
    // it to be in the façade's DRAFT_STORES.
    for (const [file, store] of [
      ['lib/review/draftStore.ts', 'review-drafts'],
      ['lib/clarify/draftStore.ts', 'clarify-drafts'],
    ] as const) {
      const text = src(file)
      expect(text.includes(`const STORE = '${store}'`)).toBe(true)
      expect((DRAFT_STORES as readonly string[]).includes(store)).toBe(true)
    }
  })

  it('neither draft store opens the DB itself (must go through the façade)', () => {
    // A local `indexedDB.open(` with a local version is exactly the drift that
    // broke review. Forbid it: the shared façade is the only opener.
    for (const file of ['lib/review/draftStore.ts', 'lib/clarify/draftStore.ts']) {
      const text = src(file)
      expect(`${file}: opens DB itself = ${text.includes('indexedDB.open(')}`).toBe(
        `${file}: opens DB itself = false`,
      )
      expect(text.includes("from '../draftDb'")).toBe(true)
      // No stray local version constant to diverge from the façade's.
      expect(/const\s+VERSION\s*=/.test(text)).toBe(false)
    }
  })
})

describe('draft stores degrade to no-ops without IndexedDB (F3 wiring)', () => {
  // happy-dom has no indexedDB, so this exercises the shared-façade null path
  // end-to-end for BOTH stores — proving the review store is wired to the façade
  // and does not throw (its ops used to just silently fail; now they degrade
  // identically to clarify through one code path).
  it('the façade resolves null when IndexedDB is unavailable', async () => {
    expect(typeof indexedDB).toBe('undefined')
    expect(await openDraftDb()).toBeNull()
  })

  it('review draft ops are safe no-ops on the null path', async () => {
    const key = { taskId: 't', nodeRunId: 'n', docVersionId: 'v', anchorHash: 'a' }
    await expect(setDraft(key, 'x')).resolves.toBeUndefined()
    expect(await getDraft(key)).toBeNull()
    await expect(deleteDraft(key)).resolves.toBeUndefined()
    expect(await listDrafts({ taskId: 't' })).toEqual([])
  })

  it('clarify draft ops are safe no-ops on the same null path', async () => {
    const key = { taskId: 't', intermediaryNodeRunId: 'n', roundId: 'r' }
    await expect(
      setClarifyDraft(key, [
        { questionId: 'q', selectedOptionIndices: [], selectedOptionLabels: [], customText: '' },
      ]),
    ).resolves.toBeUndefined()
    expect(await getClarifyDraft(key)).toBeNull()
    expect(await listClarifyDrafts({ taskId: 't' })).toEqual([])
  })
})
