// Regression: approving a review reads local drafts first. A cached closing
// IDBDatabase used to reject that read with InvalidStateError, preventing the
// decision from reaching the API. Exercise the real stores against controlled
// connection failures; review-decision-confirm-dialog.spec.ts covers native IDB.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDraftDb, resetDraftDbForTest } from '../src/lib/draftDb'
import {
  clearAllReviewDrafts,
  deleteDraft,
  getDraft,
  listDrafts,
  setDraft,
} from '../src/lib/review/draftStore'
import {
  clearAllClarifyDrafts,
  deleteClarifyDraft,
  getClarifyDraft,
  listClarifyDrafts,
  setClarifyDraft,
} from '../src/lib/clarify/draftStore'

const reviewKey = { taskId: 't', nodeRunId: 'n', docVersionId: 'v', anchorHash: 'a' }
const clarifyKey = { taskId: 't', intermediaryNodeRunId: 'n', roundId: 'r' }

function connection() {
  let closed = false
  const transaction = vi.fn(() => {
    if (closed) throw new DOMException('The database connection is closing.', 'InvalidStateError')
    const tx = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: vi.fn(() => {
        const request = () => {
          const req = { result: null, onsuccess: null } as unknown as IDBRequest
          queueMicrotask(() => {
            req.onsuccess?.call(req, new Event('success'))
            tx.oncomplete?.call(tx, new Event('complete'))
          })
          return req
        }
        return { get: request, put: request, delete: request, clear: request, openCursor: request }
      }),
    } as unknown as IDBTransaction
    return tx
  })
  const db = {
    transaction,
    close: vi.fn(() => {
      closed = true
    }),
    onclose: null,
    onversionchange: null,
  } as unknown as IDBDatabase
  return { db, transaction }
}

function installOpener(...connections: IDBDatabase[]) {
  let index = 0
  const open = vi.fn(() => {
    const db = connections[index++]
    if (db === undefined) throw new Error('unexpected extra open')
    const req = { result: db, onsuccess: null } as unknown as IDBOpenDBRequest
    queueMicrotask(() => req.onsuccess?.call(req, new Event('success')))
    return req
  })
  vi.stubGlobal('indexedDB', { open })
  return open
}

afterEach(() => {
  resetDraftDbForTest()
  vi.unstubAllGlobals()
})

describe('draft connection recovery', () => {
  it.each([
    ['review approval draft list', () => listDrafts(reviewKey)],
    ['review read', () => getDraft(reviewKey)],
    ['review write', () => setDraft(reviewKey, 'draft')],
    ['review delete', () => deleteDraft(reviewKey)],
    ['review logout cleanup', () => clearAllReviewDrafts()],
    ['clarify list', () => listClarifyDrafts(clarifyKey)],
    ['clarify read', () => getClarifyDraft(clarifyKey)],
    ['clarify write', () => setClarifyDraft(clarifyKey, [])],
    ['clarify delete', () => deleteClarifyDraft(clarifyKey)],
    ['clarify logout cleanup', () => clearAllClarifyDrafts()],
  ] as const)('reopens a closing connection for %s', async (_name, operation) => {
    const stale = connection()
    const fresh = connection()
    const open = installOpener(stale.db, fresh.db)
    expect(await openDraftDb()).toBe(stale.db)
    stale.db.close() // Native close() does not fire a close event.

    await operation()

    expect(open).toHaveBeenCalledTimes(2)
    expect(fresh.transaction).toHaveBeenCalledTimes(1)
  })

  it.each(['close', 'versionchange'] as const)('invalidates on %s', async (event) => {
    const old = connection()
    const fresh = connection()
    installOpener(old.db, fresh.db)
    await openDraftDb()
    if (event === 'close') old.db.onclose?.call(old.db, new Event('close'))
    else old.db.onversionchange?.call(old.db, new Event('versionchange') as IDBVersionChangeEvent)
    expect(await openDraftDb()).toBe(fresh.db)
    if (event === 'versionchange') expect(old.db.close).toHaveBeenCalledOnce()
    // A late notification from the old connection must not evict its replacement.
    old.db.onclose?.call(old.db, new Event('close'))
    expect(await openDraftDb()).toBe(fresh.db)
  })

  it('shares one reconnect between concurrent review and clarify reads', async () => {
    const stale = connection()
    const fresh = connection()
    const open = installOpener(stale.db, fresh.db)
    await openDraftDb()
    stale.db.close()
    await expect(
      Promise.all([listDrafts(reviewKey), getClarifyDraft(clarifyKey)]),
    ).resolves.toEqual([[], null])
    expect(open).toHaveBeenCalledTimes(2)
    expect(fresh.transaction).toHaveBeenCalledTimes(2)
  })

  it('bounds recovery when both connections are closed', async () => {
    const stale = connection()
    const fresh = connection()
    stale.db.close()
    fresh.db.close()
    const open = installOpener(stale.db, fresh.db)
    await expect(listDrafts(reviewKey)).resolves.toEqual([])
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('keeps clarify writes visibly failed when recovery cannot open storage', async () => {
    const stale = connection()
    stale.db.close()
    const open = installOpener(stale.db)
    await expect(setClarifyDraft(clarifyKey, [])).rejects.toThrow(
      'clarify draft storage unavailable',
    )
    expect(open).toHaveBeenCalledTimes(2)
  })

  it.each(['sync', 'async'] as const)('does not cache a %s open failure', async (failure) => {
    const fresh = connection()
    const open = installOpener(fresh.db)
    open.mockImplementationOnce(() => {
      if (failure === 'sync') throw new DOMException('storage unavailable', 'UnknownError')
      const req = { onerror: null } as unknown as IDBOpenDBRequest
      queueMicrotask(() => req.onerror?.call(req, new Event('error')))
      return req
    })
    await expect(openDraftDb()).resolves.toBeNull()
    expect(await openDraftDb()).toBe(fresh.db)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('does not retry unrelated transaction creation failures', async () => {
    const db = connection()
    const error = new DOMException('missing store', 'NotFoundError')
    db.transaction.mockImplementationOnce(() => {
      throw error
    })
    const open = installOpener(db.db)
    await expect(listDrafts(reviewKey)).rejects.toBe(error)
    expect(open).toHaveBeenCalledOnce()
  })

  it.each(['complete', 'abort'] as const)(
    'waits for the reconnected clarify write to %s without replaying it',
    async (event) => {
      const stale = connection()
      const fresh = connection()
      stale.db.close()
      const put = vi.fn()
      const tx = { objectStore: () => ({ put }), error: null } as unknown as IDBTransaction
      fresh.transaction.mockReturnValueOnce(tx)
      const open = installOpener(stale.db, fresh.db)
      let settled = false
      const result = setClarifyDraft(clarifyKey, []).then(
        () => {
          settled = true
          return 'saved'
        },
        (error: Error) => {
          settled = true
          return error.message
        },
      )
      await vi.waitFor(() => expect(put).toHaveBeenCalledOnce())
      expect(settled).toBe(false)
      if (event === 'complete') tx.oncomplete?.call(tx, new Event('complete'))
      else tx.onabort?.call(tx, new Event('abort'))
      await expect(result).resolves.toBe(
        event === 'complete' ? 'saved' : 'clarify draft write aborted',
      )
      expect(put).toHaveBeenCalledOnce()
      expect(open).toHaveBeenCalledTimes(2)
    },
  )

  it('does not replay an operation after its transaction was created', async () => {
    const db = connection()
    const error = new DOMException('store was deleted', 'InvalidStateError')
    db.transaction.mockImplementationOnce(
      () =>
        ({
          objectStore: () => {
            throw error
          },
        }) as unknown as IDBTransaction,
    )
    const open = installOpener(db.db)
    await expect(setDraft(reviewKey, 'draft')).rejects.toBe(error)
    expect(open).toHaveBeenCalledOnce()
  })
})
