// RFC-041 PR4 — per-task feedback ("dear future me") panel embedded at
// the bottom of the task detail page.
//
// - GET  /api/tasks/:taskId/feedback     pulls the existing notes.
// - POST /api/tasks/:taskId/feedback     submits a new note. Backend
//   automatically enqueues a memory_distill_job; UI shows "Sent to
//   distiller" badge when feedback.distilled = true.
// - 3-second rate-limit gate on the submit button (client-side), backed
//   by a simple ref so the timer survives re-renders without churn.
// - The textarea is always available regardless of task status (failed /
//   canceled / done all still accept feedback — distillation is a
//   reflective act, not a control flow knob).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskFeedback } from '@agent-workflow/shared'
import type { ApiError } from '@/api/client'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { TextArea } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { describeApiError } from '@/i18n'

interface ListResponse {
  items: TaskFeedback[]
}

interface CreateResponse {
  feedback: TaskFeedback
  distillJobId: string | null
}

export interface TaskFeedbackListProps {
  taskId: string
}

const RATE_LIMIT_MS = 3000

export function feedbackAnchorId(feedbackId: string): string {
  return `feedback-${feedbackId}`
}

/** Decode the browser fragment without letting malformed percent escapes throw. */
function currentFragmentId(): string | null {
  const encoded = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (encoded.length === 0) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

export function TaskFeedbackList({ taskId }: TaskFeedbackListProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const lastSubmitAt = useRef<number>(0)
  const lastAlignedFeedback = useRef<string | null>(null)
  const [rateLimited, setRateLimited] = useState(false)

  const list = useQuery<ListResponse>({
    queryKey: ['task-feedback', taskId],
    queryFn: ({ signal }) =>
      api.get<ListResponse>(`/api/tasks/${encodeURIComponent(taskId)}/feedback`, undefined, signal),
  })

  const create = useMutation<CreateResponse, ApiError, string>({
    mutationFn: (bodyMd) =>
      api.post(`/api/tasks/${encodeURIComponent(taskId)}/feedback`, { bodyMd }),
    onSuccess: () => {
      setDraft('')
      void qc.invalidateQueries({ queryKey: ['task-feedback', taskId] })
    },
  })

  // Clear the rate-limit flag once the cooldown expires.
  useEffect(() => {
    if (!rateLimited) return
    const timer = window.setTimeout(() => setRateLimited(false), RATE_LIMIT_MS)
    return () => window.clearTimeout(timer)
  }, [rateLimited])

  // A source-event deep link can arrive before this async query has mounted
  // its target row. Re-resolve the exact fragment after every list result and
  // on same-page hash navigation; then scroll and move keyboard focus to the
  // row so the destination is both visible and announced.
  useEffect(() => {
    const items = list.data?.items
    if (items === undefined) return

    const focusCurrentFeedback = () => {
      const fragmentId = currentFragmentId()
      if (
        fragmentId === null ||
        fragmentId === lastAlignedFeedback.current ||
        !items.some((item) => feedbackAnchorId(item.id) === fragmentId)
      ) {
        return
      }
      const target = document.getElementById(fragmentId)
      if (!(target instanceof HTMLElement)) return
      target.scrollIntoView?.({ block: 'center' })
      target.focus({ preventScroll: true })
      lastAlignedFeedback.current = fragmentId
    }

    const handleHashChange = () => {
      // Returning to a fragment after visiting another one is a fresh user
      // navigation, even when it targets the same feedback row as before.
      lastAlignedFeedback.current = null
      focusCurrentFeedback()
    }

    focusCurrentFeedback()
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [list.data?.items])

  const trimmed = draft.trim()
  const submitDisabled = trimmed.length === 0 || create.isPending || rateLimited

  const handleSubmit = () => {
    if (submitDisabled) return
    const now = Date.now()
    if (now - lastSubmitAt.current < RATE_LIMIT_MS) {
      setRateLimited(true)
      return
    }
    lastSubmitAt.current = now
    create.mutate(trimmed)
  }

  return (
    <section className="task-feedback" data-testid="task-feedback">
      <header className="task-feedback__header">
        <h2 className="task-feedback__title">{t('taskFeedback.title')}</h2>
        <p className="task-feedback__hint muted">{t('taskFeedback.hint')}</p>
      </header>

      <div className="task-feedback__form">
        <TextArea
          className="task-feedback__textarea"
          placeholder={t('taskFeedback.placeholder')}
          value={draft}
          onChange={setDraft}
          maxLength={4000}
          rows={3}
          data-testid="task-feedback-textarea"
        />
        <div className="task-feedback__form-footer">
          <span className="task-feedback__secret-hint muted">{t('taskFeedback.secretHint')}</span>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={submitDisabled}
            onClick={handleSubmit}
            data-testid="task-feedback-submit"
          >
            {create.isPending ? t('taskFeedback.submitting') : t('taskFeedback.submit')}
          </button>
        </div>
        {rateLimited && (
          <div data-testid="task-feedback-rate-limit">
            <NoticeBanner tone="warning" size="compact">
              {t('taskFeedback.rateLimit')}
            </NoticeBanner>
          </div>
        )}
        {create.error !== null && create.error !== undefined && (
          <div data-testid="task-feedback-error">
            <ErrorBanner
              error={create.error}
              message={`${t('taskFeedback.submitError')}: ${describeApiError(create.error)}`}
            />
          </div>
        )}
      </div>

      {list.isLoading ? (
        <LoadingState size="compact" />
      ) : list.error !== null && list.error !== undefined ? (
        <ErrorBanner
          error={list.error}
          message={`${t('taskFeedback.loadError')}: ${describeApiError(list.error)}`}
        />
      ) : (list.data?.items ?? []).length === 0 ? (
        <EmptyState
          size="compact"
          title={t('taskFeedback.empty')}
          data-testid="task-feedback-empty"
        />
      ) : (
        <ul className="task-feedback__list" data-testid="task-feedback-list">
          {(list.data?.items ?? []).map((row) => (
            <FeedbackItem key={row.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  )
}

function FeedbackItem({ row }: { row: TaskFeedback }) {
  const { t } = useTranslation()
  return (
    <li
      id={feedbackAnchorId(row.id)}
      className="task-feedback__item"
      tabIndex={-1}
      data-testid={`task-feedback-row-${row.id}`}
    >
      <div className="task-feedback__meta muted">
        <code>{row.id}</code>
        <time dateTime={new Date(row.createdAt).toISOString()}>
          {new Date(row.createdAt).toLocaleString()}
        </time>
        {row.distilled && (
          <span className="task-feedback__distilled-chip" data-testid="task-feedback-distilled">
            {t('taskFeedback.distilled')}
          </span>
        )}
      </div>
      <pre className="task-feedback__body">{row.bodyMd}</pre>
    </li>
  )
}
