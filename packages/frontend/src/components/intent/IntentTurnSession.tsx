import { useEffect, useId, useRef, useState } from 'react'
import type { IntentTurnDto } from '@agent-workflow/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { INTENT_QUERY_KEYS } from '@/hooks/useIntentSessionsWs'
import { NoticeBanner } from '@/components/NoticeBanner'
import { StatusChip } from '@/components/StatusChip'
import { SessionConversationPanel } from '@/components/node-session/SessionConversationPanel'

export function IntentTurnSession(props: {
  sessionId: string
  turn: IntentTurnDto
  defaultOpen: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const execution = props.turn.execution
  const [open, setOpen] = useState(props.defaultOpen)
  const previousCaptureCursor = useRef<string | null>(null)
  const contentId = useId()

  useEffect(() => {
    if (execution === null) {
      previousCaptureCursor.current = null
      return
    }
    const cursor = `${execution.captureState}:${execution.lastEventSeq}`
    const previous = previousCaptureCursor.current
    previousCaptureCursor.current = cursor
    if (!open || previous === null || previous === cursor) return

    // The detail query and this Session query have independent 1.5s fallback
    // polls. If detail observes terminal first, pollMs becomes false on this
    // render; force one cursor-driven fetch so the final event batch cannot be
    // stranded in cache until a reload.
    void queryClient.refetchQueries({
      queryKey: INTENT_QUERY_KEYS.turnSession(props.sessionId, props.turn.id),
      exact: true,
      type: 'active',
    })
  }, [execution, open, props.sessionId, props.turn.id, queryClient])

  if (execution === null) return null

  const chipKind =
    execution.captureState === 'complete'
      ? 'success'
      : execution.captureState === 'live'
        ? 'info'
        : 'warn'

  return (
    <section className="intent-turn-session" data-testid={`intent-turn-session-${props.turn.id}`}>
      <button
        type="button"
        className="intent-turn-session__toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="intent-turn-session__chevron" aria-hidden="true">
          {open ? '⌄' : '›'}
        </span>
        <span>{t('intent.executionTitle')}</span>
        <StatusChip kind={chipKind} size="sm">
          {t(`intent.executionState.${execution.captureState}`)}
        </StatusChip>
        <span className="intent-turn-session__count">
          {t('intent.executionEvents', { count: execution.lastEventSeq })}
        </span>
      </button>
      {open ? (
        <div id={contentId} className="intent-turn-session__content">
          {execution.captureState === 'truncated' ? (
            <NoticeBanner tone="warning">{t('intent.executionTruncatedNotice')}</NoticeBanner>
          ) : null}
          {execution.captureState === 'incomplete' ? (
            <NoticeBanner tone="warning">{t('intent.executionIncompleteNotice')}</NoticeBanner>
          ) : null}
          <SessionConversationPanel
            queryKey={INTENT_QUERY_KEYS.turnSession(props.sessionId, props.turn.id)}
            load={(signal) =>
              api.get(
                `/api/intent-sessions/${encodeURIComponent(props.sessionId)}/turns/${encodeURIComponent(props.turn.id)}/session`,
                undefined,
                signal,
              )
            }
            pollMs={execution.captureState === 'live' ? 1500 : false}
            className="intent-turn-session__flow"
          />
        </div>
      ) : null}
    </section>
  )
}
