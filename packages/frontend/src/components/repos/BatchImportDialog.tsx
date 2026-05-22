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
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { useWebSocket } from '@/hooks/useWebSocket'

interface BatchImportDialogProps {
  open: boolean
  onClose: () => void
  activeBatchId: string | null
  onActiveBatchIdChange: (id: string | null) => void
  /** Forwarded to <Dialog triggerRef> so close restores focus to the trigger. */
  triggerRef?: RefObject<HTMLElement | null>
}

type View = 'input' | 'progress'

export function BatchImportDialog({
  open,
  onClose,
  activeBatchId,
  onActiveBatchIdChange,
  triggerRef,
}: BatchImportDialogProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [view, setView] = useState<View>(activeBatchId !== null ? 'progress' : 'input')
  const [text, setText] = useState('')
  const [snapshot, setSnapshot] = useState<BatchImportSnapshot | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Initial fetch when reopening with an active batchId.
  useEffect(() => {
    if (!open) return
    if (activeBatchId === null) {
      setView('input')
      setSnapshot(null)
      return
    }
    setView('progress')
    api
      .get<BatchImportSnapshot>(`/api/cached-repos/imports/${encodeURIComponent(activeBatchId)}`)
      .then((snap) => setSnapshot(snap))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          // Stale localStorage; reset to input view.
          onActiveBatchIdChange(null)
          setView('input')
          setSnapshot(null)
          return
        }
        setErrorMsg(describeError(err))
      })
  }, [open, activeBatchId, onActiveBatchIdChange])

  useEffect(() => {
    if (open && view === 'input' && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [open, view])

  // Live progress over WS.
  const onWsMessage = useCallback(
    (msg: unknown) => {
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
    [qc],
  )

  useWebSocket({
    path:
      activeBatchId !== null && open ? `/ws/repo-imports/${encodeURIComponent(activeBatchId)}` : '',
    onMessage: onWsMessage,
    enabled: activeBatchId !== null && open,
  })

  const parsedUrls = useMemo(() => parseTextarea(text), [text])

  if (!open) return null

  async function handleStart(): Promise<void> {
    setSubmitting(true)
    setErrorMsg(null)
    try {
      const snap = await api.post<BatchImportSnapshot>('/api/cached-repos/batch-import', {
        urls: parsedUrls,
      })
      setSnapshot(snap)
      onActiveBatchIdChange(snap.batchId)
      setView('progress')
      // The synchronous snapshot already accounts for born-invalid rows; if
      // every row resolved to 'completed' synchronously we still pre-warm the
      // cached-repos query.
      qc.invalidateQueries({ queryKey: ['cached-repos'] })
    } catch (err) {
      setErrorMsg(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRetry(rowId: string, withOverride: boolean): Promise<void> {
    if (activeBatchId === null) return
    let url: string | undefined
    if (withOverride) {
      const input = window.prompt(t('repos.batchImport.promptOverrideUrl'))
      if (input === null) return
      const trimmed = input.trim()
      url = trimmed.length > 0 ? trimmed : undefined
    }
    try {
      const snap = await api.post<BatchImportSnapshot>(
        `/api/cached-repos/imports/${encodeURIComponent(
          activeBatchId,
        )}/rows/${encodeURIComponent(rowId)}/retry`,
        url !== undefined ? { url } : {},
      )
      setSnapshot(snap)
    } catch (err) {
      setErrorMsg(describeError(err))
    }
  }

  function handleAgain(): void {
    onActiveBatchIdChange(null)
    setSnapshot(null)
    setText('')
    setErrorMsg(null)
    setView('input')
  }

  function handleClose(): void {
    if (snapshot !== null && snapshot.state === 'completed') {
      onActiveBatchIdChange(null)
    }
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
        <button type="button" className="btn btn--sm" onClick={handleClose}>
          {t('repos.batchImport.cancel')}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={submitting || parsedUrls.length === 0 || parsedUrls.length > 100}
          onClick={() => void handleStart()}
          data-testid="batch-import-start"
        >
          {t('repos.batchImport.start')}
        </button>
      </>
    ) : (
      <>
        {snapshot?.state === 'completed' && (
          <button type="button" className="btn btn--sm" onClick={handleAgain}>
            {t('repos.batchImport.again')}
          </button>
        )}
        <button type="button" className="btn btn--sm btn--primary" onClick={handleClose}>
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
      triggerRef={triggerRef}
    >
      <div>
        {errorMsg !== null && <div className="error-box">{errorMsg}</div>}

        {view === 'input' && (
          <>
            <textarea
              ref={textareaRef}
              className="batch-import-dialog__textarea"
              placeholder={t('repos.batchImport.placeholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              data-testid="batch-import-textarea"
            />
            {parsedUrls.length === 0 && text.length > 0 && (
              <div className="muted">{t('repos.batchImport.batchEmpty')}</div>
            )}
            {parsedUrls.length > 100 && (
              <div className="error-box">{t('repos.batchImport.batchTooLarge')}</div>
            )}
          </>
        )}

        {view === 'progress' && snapshot !== null && (
          <>
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
                    data-row-status={row.status}
                    data-testid={`batch-import-row-${row.rowId}`}
                  >
                    <td>{i + 1}</td>
                    <td className="batch-import-table__url">{row.inputUrlRedacted}</td>
                    <td>{describeStatus(row)}</td>
                    <td className="batch-import-table__detail">{row.message ?? ''}</td>
                    <td>
                      {(row.status === 'failed' || row.status === 'done') && (
                        <div className="batch-import-table__actions">
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => void handleRetry(row.rowId, false)}
                          >
                            {t('repos.batchImport.retry')}
                          </button>
                          {row.status === 'failed' && (
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => void handleRetry(row.rowId, true)}
                            >
                              {t('repos.batchImport.retryWithEdit')}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
