// IndexedDB-backed draft persistence for RFC-005 PR-D T23.
//
// Drafts: a user has selected text + opened the popover but not yet hit
// Submit. We persist the in-flight text by (taskId, nodeRunId, docVersionId,
// anchorHash) so closing the tab / refreshing doesn't lose work. localStorage
// would do, but IDB keeps the data per-origin without bumping the localStorage
// quota for hundreds of in-flight drafts.

import { openDraftDb } from '../draftDb'

// RFC-005 — the review store shares `agent-workflow-drafts` with clarify. It
// MUST go through the shared façade (openDraftDb): opening the DB itself with a
// local version diverges from clarify's and throws VersionError, silently
// killing review draft persistence (design/test-guard-audit-2026-07-21 F3).
const STORE = 'review-drafts'

export interface DraftKey {
  taskId: string
  nodeRunId: string
  docVersionId: string
  anchorHash: string
}

export function draftKey(k: DraftKey): string {
  return `${k.taskId}:${k.nodeRunId}:${k.docVersionId}:${k.anchorHash}`
}

function openDb(): Promise<IDBDatabase | null> {
  return openDraftDb()
}

export async function getDraft(k: DraftKey): Promise<string | null> {
  const db = await openDb()
  if (db === null) return null
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(draftKey(k))
    req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null)
    req.onerror = () => resolve(null)
  })
}

export async function setDraft(k: DraftKey, text: string): Promise<void> {
  const db = await openDb()
  if (db === null) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(text, draftKey(k))
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

export async function deleteDraft(k: DraftKey): Promise<void> {
  const db = await openDb()
  if (db === null) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).delete(draftKey(k))
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

export async function listDrafts(
  filter: Partial<Pick<DraftKey, 'taskId' | 'nodeRunId' | 'docVersionId'>>,
): Promise<{ key: string; text: string }[]> {
  const db = await openDb()
  if (db === null) return []
  const prefix = [filter.taskId, filter.nodeRunId, filter.docVersionId]
    .filter((s): s is string => typeof s === 'string')
    .join(':')
  return new Promise((resolve) => {
    const out: { key: string; text: string }[] = []
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor === null) {
        resolve(out)
        return
      }
      const k = String(cursor.key)
      if (prefix.length === 0 || k.startsWith(prefix)) {
        if (typeof cursor.value === 'string') {
          out.push({ key: k, text: cursor.value })
        }
      }
      cursor.continue()
    }
    req.onerror = () => resolve(out)
  })
}

/** Clears the ENTIRE review draft store. Used on logout (wipe the prior
 *  account's private drafts on a shared browser — RFC-099 audit) and by test
 *  suites to avoid leaking between cases. */
export async function clearAllReviewDrafts(): Promise<void> {
  const db = await openDb()
  if (db === null) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).clear()
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}
