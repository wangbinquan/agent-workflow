// Shared IndexedDB façade for all in-flight draft stores.
//
// WHY THIS EXISTS
// ---------------
// `clarify/draftStore.ts` and `review/draftStore.ts` both persist drafts into
// the SAME database (`agent-workflow-drafts`) but each used to open it with its
// own version + its own upgrade handler:
//   - review opened at version 1, creating only `review-drafts`
//   - clarify opened at version 2, creating `clarify-drafts` (and, defensively,
//     `review-drafts`)
// IndexedDB has ONE version per database. Once clarify opened it at v2, review's
// `indexedDB.open(name, 1)` fired a VersionError (you cannot open below the
// existing version) → its promise resolved null → every review draft op silently
// became a no-op. Since clarify is a common flow, review drafts frequently
// failed to persist with no error surfaced.
//
// The structural fix: ONE opener, ONE version, ONE upgrade that creates ALL
// stores. Both feature stores go through it, so a version can never diverge
// again. See design/test-guard-audit-2026-07-21 gap F3-review-1.

/** Every store that lives in the shared drafts database. Adding a feature draft
 *  store = add its name here (and bump DRAFT_DB_VERSION). */
export const DRAFT_DB_NAME = 'agent-workflow-drafts'
export const DRAFT_STORES = ['review-drafts', 'clarify-drafts'] as const
export type DraftStoreName = (typeof DRAFT_STORES)[number]

/**
 * Monotonic. Bump ONLY when adding a store to DRAFT_STORES. Because the single
 * upgrade handler below creates every store in DRAFT_STORES idempotently, an
 * upgrade from any prior version converges to the full set — no per-store
 * upgrade drift.
 */
export const DRAFT_DB_VERSION = 2

let dbPromise: Promise<IDBDatabase | null> | null = null

/**
 * Open (once, memoised) the shared drafts DB. Resolves null when IndexedDB is
 * unavailable (SSR / the happy-dom test env / a private-mode failure) — callers
 * then degrade to no-ops, exactly as before.
 */
export function openDraftDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    const req = indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Create EVERY store, not just one — a store added in a later version
      // must exist even for a connection that triggered no upgrade of its own.
      for (const store of DRAFT_STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
  return dbPromise
}

/** Reset the memoised connection (test-only; each case starts fresh). */
export function resetDraftDbForTest(): void {
  dbPromise = null
}
