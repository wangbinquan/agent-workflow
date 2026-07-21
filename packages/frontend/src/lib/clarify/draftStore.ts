// IndexedDB-backed draft persistence for RFC-023 PR-C T20.
//
// Drafts: a user has opened a clarify session detail page, started filling in
// answers (radio / checkbox / custom text) but not yet submitted. We persist
// the in-flight ClarifyAnswer[] by (taskId, intermediaryNodeRunId, roundId)
// so closing the tab or refreshing doesn't lose work. RFC-058 renamed the
// key fields from (clarifyNodeRunId, sessionId) to
// (intermediaryNodeRunId, roundId) — the IDB key prefix bumped to
// `clarify-round:` so prior drafts don't shadow new ones with stale ids.
//
// Deliberately a separate object store from `review-drafts` so the two
// features can evolve independently. Same IDB facade for parity.

import type { ClarifyAnswer } from '@agent-workflow/shared'
import { openDraftDb } from '../draftDb'

// RFC-023/058 — clarify shares `agent-workflow-drafts` with review, through the
// single shared façade (openDraftDb) so the two can never diverge on version
// again (design/test-guard-audit-2026-07-21 F3).
const STORE = 'clarify-drafts'

export interface ClarifyDraftKey {
  taskId: string
  intermediaryNodeRunId: string
  roundId: string
}

export function clarifyDraftKey(k: ClarifyDraftKey): string {
  // 'clarify-round:' prefix matches the RFC-058 rename; legacy `clarify:`
  // entries from pre-PR-B builds are intentionally left in place (no
  // migration) because the draft store is best-effort and reset on the
  // next answer submit anyway.
  return `clarify-round:${k.taskId}:${k.intermediaryNodeRunId}:${k.roundId}`
}

function openDb(): Promise<IDBDatabase | null> {
  return openDraftDb()
}

export async function getClarifyDraft(k: ClarifyDraftKey): Promise<ClarifyAnswer[] | null> {
  const db = await openDb()
  if (db === null) return null
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(clarifyDraftKey(k))
    req.onsuccess = () => {
      const v = req.result
      if (typeof v !== 'string') {
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(v) as unknown
        resolve(Array.isArray(parsed) ? (parsed as ClarifyAnswer[]) : null)
      } catch {
        resolve(null)
      }
    }
    req.onerror = () => resolve(null)
  })
}

export async function setClarifyDraft(k: ClarifyDraftKey, answers: ClarifyAnswer[]): Promise<void> {
  const db = await openDb()
  if (db === null) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(JSON.stringify(answers), clarifyDraftKey(k))
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

export async function deleteClarifyDraft(k: ClarifyDraftKey): Promise<void> {
  const db = await openDb()
  if (db === null) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).delete(clarifyDraftKey(k))
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

export async function listClarifyDrafts(
  filter: Partial<Pick<ClarifyDraftKey, 'taskId' | 'intermediaryNodeRunId'>> = {},
): Promise<{ key: string; answers: ClarifyAnswer[] }[]> {
  const db = await openDb()
  if (db === null) return []
  // Keys are `clarify-round:<taskId>:<intermediaryNodeRunId>:<roundId>`.
  // Filter narrowed via prefix segments.
  const segments: string[] = ['clarify-round']
  if (filter.taskId !== undefined) segments.push(filter.taskId)
  if (filter.intermediaryNodeRunId !== undefined) segments.push(filter.intermediaryNodeRunId)
  const prefix = segments.join(':')
  return new Promise((resolve) => {
    const out: { key: string; answers: ClarifyAnswer[] }[] = []
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor === null) {
        resolve(out)
        return
      }
      const k = String(cursor.key)
      if (k.startsWith(prefix)) {
        if (typeof cursor.value === 'string') {
          try {
            const parsed = JSON.parse(cursor.value) as unknown
            if (Array.isArray(parsed)) out.push({ key: k, answers: parsed as ClarifyAnswer[] })
          } catch {
            /* skip corrupt entry */
          }
        }
      }
      cursor.continue()
    }
    req.onerror = () => resolve(out)
  })
}

/** Clears the ENTIRE clarify draft store. Used on logout (wipe the prior
 *  account's private drafts on a shared browser — RFC-099 audit) and by test
 *  suites to avoid leaking between cases. */
export async function clearAllClarifyDrafts(): Promise<void> {
  const db = await openDb()
  if (db === null) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).clear()
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}
