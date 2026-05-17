// IndexedDB-backed draft persistence for RFC-023 PR-C T20.
//
// Drafts: a user has opened a clarify session detail page, started filling in
// answers (radio / checkbox / custom text) but not yet submitted. We persist
// the in-flight ClarifyAnswer[] by (taskId, clarifyNodeRunId, sessionId) so
// closing the tab or refreshing doesn't lose work.
//
// Deliberately a separate object store from `review-drafts` so the two
// features can evolve independently. Same IDB facade for parity.

import type { ClarifyAnswer } from '@agent-workflow/shared'

const DB_NAME = 'agent-workflow-drafts'
const STORE = 'clarify-drafts'
const VERSION = 2 // bumped from 1 to add the clarify-drafts store

export interface ClarifyDraftKey {
  taskId: string
  clarifyNodeRunId: string
  sessionId: string
}

export function clarifyDraftKey(k: ClarifyDraftKey): string {
  // 'clarify:' prefix keeps the cursor scan in listDrafts cheap to filter and
  // gives the operator a way to grep the IDB store name in devtools.
  return `clarify:${k.taskId}:${k.clarifyNodeRunId}:${k.sessionId}`
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Keep the older 'review-drafts' store on upgrade so the review draft
      // facade continues to work unchanged.
      if (!db.objectStoreNames.contains('review-drafts')) {
        db.createObjectStore('review-drafts')
      }
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
  return dbPromise
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
  filter: Partial<Pick<ClarifyDraftKey, 'taskId' | 'clarifyNodeRunId'>> = {},
): Promise<{ key: string; answers: ClarifyAnswer[] }[]> {
  const db = await openDb()
  if (db === null) return []
  // The keys are stored as `clarify:<taskId>:<clarifyNodeRunId>:<sessionId>`,
  // so the filter prefix needs the literal 'clarify:' lead-in plus whichever
  // higher-order id segments the caller asked to narrow by.
  const segments: string[] = ['clarify']
  if (filter.taskId !== undefined) segments.push(filter.taskId)
  if (filter.clarifyNodeRunId !== undefined) segments.push(filter.clarifyNodeRunId)
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

/** Test helper — clears the clarify store so suites don't leak between cases. */
export async function clearAllClarifyDraftsForTests(): Promise<void> {
  const db = await openDb()
  if (db === null) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).clear()
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}
