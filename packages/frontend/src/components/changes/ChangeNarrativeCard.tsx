// RFC-239 §G7 — the manually-triggered AI change narrative. Four states:
// button (nothing yet) / generating (poll) / ready (overview + reading order;
// group sentences render in the sidebar group headers via `narrative`) /
// failed (retry). Members trigger; everyone reads the disk cache. A digest
// mismatch against the CURRENT structural response marks the narrative stale
// (both values are backend-computed — the frontend only compares).

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ChangeNarrative, ChangeNarrativeStatus } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'

/** localStorage key remembering the fold, per task. */
const collapseKey = (taskId: string): string => `aw:changes-narrative-collapsed:${taskId}`

export function useChangeNarrative(taskId: string, enabled: boolean) {
  return useQuery<ChangeNarrativeStatus | null>({
    queryKey: ['tasks', taskId, 'change-narrative'],
    queryFn: async ({ signal }) => {
      try {
        return await api.get<ChangeNarrativeStatus>(
          `/api/tasks/${encodeURIComponent(taskId)}/change-narrative`,
          undefined,
          signal,
        )
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null // button state
        throw err
      }
    },
    enabled,
    refetchInterval: (q) => (q.state.data?.status === 'generating' ? 2000 : false),
    retry: false,
  })
}

export function ChangeNarrativeCard({
  taskId,
  status,
  contentDigest,
  onJumpToRef,
}: {
  taskId: string
  status: ChangeNarrativeStatus | null | undefined
  /** The CURRENT structural response's digest (backend-computed). */
  contentDigest: string | undefined
  /** Jump to a reading-order ref (group key or file path). */
  onJumpToRef?: (ref: string) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const trigger = useMutation({
    mutationFn: () =>
      api.post(`/api/tasks/${encodeURIComponent(taskId)}/change-narrative`, { scope: 'task' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['tasks', taskId, 'change-narrative'] }),
  })
  // Collapsible (user feedback: the walkthrough box eats vertical space once
  // read). Folded state is remembered per task.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(collapseKey(taskId)) === '1'
    } catch {
      return false
    }
  })
  const toggleCollapsed = (): void =>
    setCollapsed((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(collapseKey(taskId), next ? '1' : '0')
      } catch {
        /* private mode — session-only fold */
      }
      return next
    })

  if (status === undefined) return null // query disabled / initial
  if (status === null || status.status === 'failed') {
    return (
      <div className="changes__narrative changes__narrative--idle">
        {status?.status === 'failed' && (
          <span className="changes__narrative-error">{t('tasks.changesNarrativeFailed')}</span>
        )}
        <button
          type="button"
          className="btn btn--sm"
          disabled={trigger.isPending}
          onClick={() => trigger.mutate()}
        >
          {status?.status === 'failed'
            ? t('tasks.changesNarrativeRetry')
            : t('tasks.changesNarrativeGenerate')}
        </button>
        {trigger.isError && (
          <span className="changes__narrative-error">
            {trigger.error instanceof ApiError
              ? trigger.error.message
              : t('tasks.changesNarrativeFailed')}
          </span>
        )}
      </div>
    )
  }
  if (status.status === 'generating') {
    return (
      <div className="changes__narrative changes__narrative--generating" role="status">
        {t('tasks.changesNarrativeGenerating')}
      </div>
    )
  }
  const n: ChangeNarrative = status.narrative
  const stale = contentDigest !== undefined && n.inputDigest !== contentDigest
  return (
    <div className="changes__narrative" data-testid="change-narrative">
      <button
        type="button"
        className="changes__outline-fold changes__narrative-fold"
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
      >
        {collapsed ? '▸' : '▾'} {t('tasks.changesNarrativeTitle')}
      </button>
      {!collapsed && <div className="changes__narrative-overview">{n.overview}</div>}
      {!collapsed && n.readingOrder.length > 0 && (
        <ol className="changes__narrative-order">
          {n.readingOrder.map((step, i) => (
            <li key={`${step.ref}-${i}`}>
              {onJumpToRef !== undefined ? (
                <button
                  type="button"
                  className="changes__narrative-ref"
                  onClick={() => onJumpToRef(step.ref)}
                >
                  {step.ref}
                </button>
              ) : (
                <span className="changes__narrative-ref">{step.ref}</span>
              )}
              <span className="changes__narrative-why">{step.why}</span>
            </li>
          ))}
        </ol>
      )}
      {!collapsed && stale && (
        <div className="changes__narrative-stale">
          {t('tasks.changesNarrativeStale')}
          <button
            type="button"
            className="btn btn--xs"
            disabled={trigger.isPending}
            onClick={() => trigger.mutate()}
          >
            {t('tasks.changesNarrativeRegenerate')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Group-key → sentence map for the sidebar group headers. */
export function narrativeGroupSummaries(
  status: ChangeNarrativeStatus | null | undefined,
): ReadonlyMap<string, string> {
  if (status == null || status.status !== 'ready') return new Map()
  return new Map(status.narrative.groups.map((g) => [g.key, g.summary]))
}
