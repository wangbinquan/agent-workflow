// RFC-033 batch-import modal mounted on /repos. Two views:
//   - 'input': textarea + Start; POST returns a batchId + initial snapshot.
//   - 'progress': table per row, live-updated from `/ws/repo-imports/{batchId}`.
//
// Rows whose `cachedRepoId` becomes set drive a react-query invalidation on
// the parent so the main /repos table picks up the new cache entries.
//
// RFC-035 PR3: overlay + panel + ESC + outside click + body overflow lock
// are now owned by the shared <Dialog>; this component owns just the body
// (textarea + table) and renders an action footer.

import type { BatchImportRow, BatchImportSnapshot } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { TableViewport } from '@/components/TableViewport'
import { useAuthSessionRevision } from '@/hooks/useActor'
import { useWebSocket } from '@/hooks/useWebSocket'
import { getAuthSessionRevision } from '@/stores/auth'

interface BatchImportDialogProps {
  open: boolean
  onClose: () => void
  activeBatchId: string | null
  onActiveBatchIdChange: (id: string | null) => void
  canCreate: boolean
  canExecute: boolean
  hasPermission: (permission: 'repos:create' | 'repos:execute') => boolean
  /** Forwarded to <Dialog triggerRef> so close restores focus to the trigger. */
  triggerRef?: RefObject<HTMLElement | null>
}

type View = 'input' | 'progress'

export function BatchImportDialog({
  open,
  onClose,
  activeBatchId,
  onActiveBatchIdChange,
  canCreate,
  canExecute,
  hasPermission,
  triggerRef,
}: BatchImportDialogProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const authRevision = useAuthSessionRevision()
  const [view, setView] = useState<View>(activeBatchId !== null ? 'progress' : 'input')
  const [text, setText] = useState('')
  const [snapshot, setSnapshot] = useState<BatchImportSnapshot | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [editingRowId, setEditingRowId] = useState<string | null>(null)
  const [draftUrl, setDraftUrl] = useState('')
  const [retryPending, setRetryPending] = useState(false)
  const [retryError, setRetryError] = useState<unknown | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const overrideInputRef = useRef<HTMLInputElement | null>(null)
  const retryInFlightRef = useRef(false)
  const hasPermissionRef = useRef(hasPermission)
  hasPermissionRef.current = hasPermission
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>())
  const retryRefs = useRef(new Map<string, HTMLButtonElement>())
  const editRefs = useRef(new Map<string, HTMLButtonElement>())
  const canAccessBatch = canCreate || (canExecute && activeBatchId !== null)
  const permissionSessionRef = useRef(0)
  const activeAuthRevisionRef = useRef(authRevision)
  const hasCurrentPermission = useCallback(
    (permission: 'repos:create' | 'repos:execute'): boolean =>
      getAuthSessionRevision() === authRevision && hasPermissionRef.current(permission),
    [authRevision],
  )

  useLayoutEffect(() => {
    // Opening/closing, capability changes and batch identity changes are all
    // async-continuation boundaries. Old responses may finish, but they cannot
    // populate a later dialog session.
    permissionSessionRef.current += 1
    const authChanged = activeAuthRevisionRef.current !== authRevision
    activeAuthRevisionRef.current = authRevision
    retryInFlightRef.current = false
    setSubmitting(false)
    setRetryPending(false)
    setErrorMsg(null)
    setRetryError(null)
    if (!canExecute) {
      setEditingRowId(null)
      setDraftUrl('')
    }
    if (authChanged || !open || !canAccessBatch) {
      setEditingRowId(null)
      setDraftUrl('')
      setText('')
      setSnapshot(null)
      setView(activeBatchId !== null ? 'progress' : 'input')
    }
  }, [activeBatchId, authRevision, canAccessBatch, canCreate, canExecute, open])

  useEffect(() => {
    if (open && !canAccessBatch) onClose()
    if (!canExecute) {
      setEditingRowId(null)
      setDraftUrl('')
      setRetryError(null)
    }
  }, [canAccessBatch, canExecute, onClose, open])

  // Initial fetch when reopening with an active batchId.
  useEffect(() => {
    if (!open || !canAccessBatch) return
    const session = permissionSessionRef.current
    setEditingRowId(null)
    setDraftUrl('')
    setRetryError(null)
    if (activeBatchId === null) {
      setView('input')
      setSnapshot(null)
      return
    }
    setView('progress')
    api
      .get<BatchImportSnapshot>(`/api/cached-repos/imports/${encodeURIComponent(activeBatchId)}`)
      .then((snap) => {
        if (
          session !== permissionSessionRef.current ||
          (!hasCurrentPermission('repos:create') && !hasCurrentPermission('repos:execute'))
        ) {
          return
        }
        setSnapshot(snap)
      })
      .catch((err) => {
        if (
          session !== permissionSessionRef.current ||
          (!hasCurrentPermission('repos:create') && !hasCurrentPermission('repos:execute'))
        ) {
          return
        }
        if (err instanceof ApiError && err.status === 404) {
          // Stale localStorage; reset to input view.
          onActiveBatchIdChange(null)
          setView('input')
          setSnapshot(null)
          return
        }
        setErrorMsg(describeApiError(err))
      })
  }, [activeBatchId, canAccessBatch, hasCurrentPermission, onActiveBatchIdChange, open])

  useEffect(() => {
    if (open && canCreate && view === 'input' && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [canCreate, open, view])

  useEffect(() => {
    if (!open || !canAccessBatch || !canExecute || editingRowId === null) return
    const id = window.setTimeout(() => overrideInputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [canAccessBatch, canExecute, editingRowId, open])

  // Live progress over WS.
  const onWsMessage = useCallback(
    (msg: unknown) => {
      if (!hasCurrentPermission('repos:create') && !hasCurrentPermission('repos:execute')) return
      if (msg === null || typeof msg !== 'object') return
      const m = msg as { type?: string }
      if (m.type === 'row.update') {
        const row = (m as { row: BatchImportRow }).row
        setSnapshot((prev) => {
          if (prev === null) return prev
          const idx = prev.rows.findIndex((r) => r.rowId === row.rowId)
          if (idx === -1) return prev
          const next = { ...prev, rows: prev.rows.slice() }
          next.rows[idx] = row
          return next
        })
        if (row.status === 'done' && row.cachedRepoId !== null) {
          qc.invalidateQueries({ queryKey: ['cached-repos'] })
        }
      } else if (m.type === 'batch.completed') {
        setSnapshot((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                state: 'completed',
                completedAt: (m as { completedAt: string }).completedAt,
              },
        )
      }
    },
    [hasCurrentPermission, qc],
  )

  // RFC-152 — the subscription path comes from the shared WS_PATHS constant
  // (double-ended single source; the backend registry's pathRe is
  // interlock-tested against it).
  useWebSocket({
    path:
      activeBatchId !== null && open && canAccessBatch ? WS_PATHS.repoImport(activeBatchId) : '',
    onMessage: onWsMessage,
    enabled: activeBatchId !== null && open && canAccessBatch,
  })

  const parsedUrls = useMemo(() => parseTextarea(text), [text])

  if (!open || !canAccessBatch) return null

  async function handleStart(): Promise<void> {
    if (!hasCurrentPermission('repos:create')) return
    const session = permissionSessionRef.current
    setSubmitting(true)
    setErrorMsg(null)
    try {
      const snap = await api.post<BatchImportSnapshot>('/api/cached-repos/batch-import', {
        urls: parsedUrls,
      })
      if (session !== permissionSessionRef.current || !hasCurrentPermission('repos:create')) return
      setSnapshot(snap)
      onActiveBatchIdChange(snap.batchId)
      setView('progress')
      // The synchronous snapshot already accounts for born-invalid rows; if
      // every row resolved to 'completed' synchronously we still pre-warm the
      // cached-repos query.
      qc.invalidateQueries({ queryKey: ['cached-repos'] })
    } catch (err) {
      if (session !== permissionSessionRef.current || !hasCurrentPermission('repos:create')) return
      setErrorMsg(describeApiError(err))
    } finally {
      if (session === permissionSessionRef.current) setSubmitting(false)
    }
  }

  function restoreRowFocus(rowId: string, preferred: 'edit' | 'retry'): void {
    window.setTimeout(() => {
      const target =
        (preferred === 'edit' ? editRefs.current.get(rowId) : retryRefs.current.get(rowId)) ??
        rowRefs.current.get(rowId)
      if (target?.isConnected === true) target.focus()
    }, 0)
  }

  function beginOverride(rowId: string): void {
    if (
      !hasCurrentPermission('repos:execute') ||
      retryPending ||
      (editingRowId !== null && editingRowId !== rowId)
    )
      return
    setEditingRowId(rowId)
    setDraftUrl('')
    setRetryError(null)
  }

  function cancelOverride(): void {
    if (retryPending || editingRowId === null) return
    const rowId = editingRowId
    setEditingRowId(null)
    setDraftUrl('')
    setRetryError(null)
    restoreRowFocus(rowId, 'edit')
  }

  async function handleRetry(
    rowId: string,
    body: Record<string, never> | { url: string },
    fromEditor: boolean,
  ): Promise<void> {
    if (
      !hasCurrentPermission('repos:execute') ||
      activeBatchId === null ||
      retryInFlightRef.current
    )
      return
    const session = permissionSessionRef.current
    retryInFlightRef.current = true
    const batchId = activeBatchId
    setRetryPending(true)
    if (fromEditor) setRetryError(null)
    else setErrorMsg(null)
    try {
      const snap = await api.post<BatchImportSnapshot>(
        `/api/cached-repos/imports/${encodeURIComponent(
          batchId,
        )}/rows/${encodeURIComponent(rowId)}/retry`,
        body,
      )
      if (session !== permissionSessionRef.current || !hasCurrentPermission('repos:execute')) return
      setSnapshot(snap)
      if (fromEditor) {
        setEditingRowId(null)
        setDraftUrl('')
        setRetryError(null)
      }
      restoreRowFocus(rowId, 'retry')
    } catch (err) {
      if (session !== permissionSessionRef.current || !hasCurrentPermission('repos:execute')) return
      if (fromEditor) setRetryError(err)
      else setErrorMsg(describeApiError(err))
    } finally {
      if (session === permissionSessionRef.current) {
        retryInFlightRef.current = false
        setRetryPending(false)
      }
    }
  }

  function submitOverride(): void {
    if (!hasCurrentPermission('repos:execute') || editingRowId === null || retryPending) return
    const rowId = editingRowId
    const trimmed = draftUrl.trim()
    void handleRetry(rowId, trimmed.length === 0 ? {} : { url: trimmed }, true)
  }

  function handleAgain(): void {
    if (!hasCurrentPermission('repos:create')) return
    onActiveBatchIdChange(null)
    setSnapshot(null)
    setText('')
    setErrorMsg(null)
    setEditingRowId(null)
    setDraftUrl('')
    setRetryError(null)
    setView('input')
  }

  function handleClose(): void {
    if (submitting || retryPending) return
    if (snapshot !== null && snapshot.state === 'completed') {
      onActiveBatchIdChange(null)
    }
    setEditingRowId(null)
    setDraftUrl('')
    setRetryError(null)
    onClose()
  }

  function describeStatus(row: BatchImportRow): string {
    switch (row.status) {
      case 'queued':
        return t('repos.batchImport.statusQueued')
      case 'cloning':
        return t('repos.batchImport.statusCloning')
      case 'done':
        if (row.cold === true) return t('repos.batchImport.statusDoneCold')
        if (row.fetchOk === false) return t('repos.batchImport.statusDoneHitFetchFail')
        return t('repos.batchImport.statusDoneHit')
      case 'failed':
        return t('repos.batchImport.statusFailed')
    }
  }

  const footer =
    view === 'input' ? (
      <>
        <button type="button" className="btn btn--sm" onClick={handleClose} disabled={submitting}>
          {t('repos.batchImport.cancel')}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={!canCreate || submitting || parsedUrls.length === 0 || parsedUrls.length > 100}
          onClick={() => void handleStart()}
          data-testid="batch-import-start"
        >
          {t('repos.batchImport.start')}
        </button>
      </>
    ) : (
      <>
        {canCreate && snapshot?.state === 'completed' && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={handleAgain}
            disabled={retryPending}
          >
            {t('repos.batchImport.again')}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={handleClose}
          disabled={retryPending}
        >
          {t('repos.batchImport.close')}
        </button>
      </>
    )

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('repos.batchImport.title')}
      size="lg"
      panelClassName="batch-import-dialog"
      data-testid="batch-import-dialog"
      footer={footer}
      initialFocusRef={textareaRef}
      triggerRef={triggerRef}
      dismissDisabled={submitting || retryPending}
    >
      <div>
        {errorMsg !== null && <ErrorBanner error={errorMsg} />}

        {view === 'input' && (
          <>
            <TextArea
              textareaRef={textareaRef}
              className="batch-import-dialog__textarea"
              placeholder={t('repos.batchImport.placeholder')}
              value={text}
              onChange={setText}
              rows={10}
              data-testid="batch-import-textarea"
            />
            {parsedUrls.length === 0 && text.length > 0 && (
              <div className="muted">{t('repos.batchImport.batchEmpty')}</div>
            )}
            {parsedUrls.length > 100 && (
              <ErrorBanner error={t('repos.batchImport.batchTooLarge')} />
            )}
          </>
        )}

        {view === 'progress' && snapshot !== null && (
          <>
            <TableViewport label={t('repos.batchImport.title')} minWidth="lg">
              <table className="batch-import-table" data-testid="batch-import-table">
                <thead>
                  <tr>
                    <th>{t('repos.batchImport.colIndex')}</th>
                    <th>{t('repos.batchImport.colUrl')}</th>
                    <th>{t('repos.batchImport.colStatus')}</th>
                    <th>{t('repos.batchImport.colDetail')}</th>
                    <th>{t('repos.batchImport.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.rows.map((row, i) => (
                    <tr
                      key={row.rowId}
                      ref={(element) => {
                        if (element === null) rowRefs.current.delete(row.rowId)
                        else rowRefs.current.set(row.rowId, element)
                      }}
                      tabIndex={-1}
                      data-row-status={row.status}
                      data-testid={`batch-import-row-${row.rowId}`}
                    >
                      <td>{i + 1}</td>
                      <td className="batch-import-table__url">{row.inputUrlRedacted}</td>
                      <td>{describeStatus(row)}</td>
                      <td className="batch-import-table__detail">{row.message ?? ''}</td>
                      <td>
                        {canExecute && editingRowId === row.rowId ? (
                          <div
                            className="stack--sm"
                            data-testid={`batch-import-override-${row.rowId}`}
                            aria-busy={retryPending || undefined}
                          >
                            <Field label={t('repos.batchImport.promptOverrideUrl')}>
                              <TextInput
                                value={draftUrl}
                                onChange={setDraftUrl}
                                type="url"
                                disabled={retryPending}
                                inputRef={overrideInputRef}
                                data-testid="batch-import-override-input"
                              />
                            </Field>
                            {retryError !== null && <ErrorBanner error={retryError} />}
                            <div className="batch-import-table__actions">
                              <button
                                type="button"
                                className="btn btn--sm"
                                disabled={retryPending}
                                onClick={cancelOverride}
                                data-testid="batch-import-override-cancel"
                              >
                                {t('common.cancel')}
                              </button>
                              <button
                                type="button"
                                className="btn btn--sm btn--primary"
                                disabled={retryPending}
                                aria-busy={retryPending || undefined}
                                onClick={submitOverride}
                                data-testid="batch-import-override-submit"
                              >
                                {t('repos.batchImport.retry')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          canExecute &&
                          (row.status === 'failed' || row.status === 'done') && (
                            <div className="batch-import-table__actions">
                              <button
                                type="button"
                                className="btn btn--sm"
                                ref={(element) => {
                                  if (element === null) retryRefs.current.delete(row.rowId)
                                  else retryRefs.current.set(row.rowId, element)
                                }}
                                disabled={retryPending || editingRowId !== null}
                                onClick={() => void handleRetry(row.rowId, {}, false)}
                                data-testid={`batch-import-retry-${row.rowId}`}
                              >
                                {t('repos.batchImport.retry')}
                              </button>
                              {row.status === 'failed' && (
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  ref={(element) => {
                                    if (element === null) editRefs.current.delete(row.rowId)
                                    else editRefs.current.set(row.rowId, element)
                                  }}
                                  disabled={retryPending || editingRowId !== null}
                                  onClick={() => beginOverride(row.rowId)}
                                  data-testid={`batch-import-edit-${row.rowId}`}
                                >
                                  {t('repos.batchImport.retryWithEdit')}
                                </button>
                              )}
                            </div>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          </>
        )}
      </div>
    </Dialog>
  )
}

export function parseTextarea(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}
