import type { IntentSessionSummary } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { RelativeTime } from '@/components/RelativeTime'
import { StatusChip } from '@/components/StatusChip'

export function IntentSessionList(props: {
  sessions: IntentSessionSummary[] | undefined
  loading: boolean
  error: unknown
}) {
  const { t } = useTranslation()
  return (
    <section className="intent-recent" aria-labelledby="intent-recent-title">
      <div className="intent-recent__heading">
        <div>
          <h2 id="intent-recent-title">{t('intent.recentSessions')}</h2>
          <p>{t('intent.recentSessionsHint')}</p>
        </div>
      </div>
      {props.loading ? <LoadingState size="compact" /> : null}
      {props.error !== null && props.error !== undefined ? (
        <ErrorBanner error={props.error} />
      ) : null}
      {props.sessions !== undefined && props.sessions.length === 0 ? (
        <EmptyState
          size="compact"
          title={t('intent.emptyTitle')}
          description={t('intent.emptyDescription')}
        />
      ) : null}
      {props.sessions !== undefined && props.sessions.length > 0 ? (
        <ul className="intent-recent__grid">
          {props.sessions.map((session) => (
            <li key={session.id}>
              <Card
                to="/intent/$sessionId"
                params={{ sessionId: session.id }}
                interactive
                highlighted={session.inFlight}
                className="intent-session-card"
                title={<span title={session.title}>{session.title}</span>}
                actions={
                  session.inFlight ? (
                    <StatusChip kind="info" withDot>
                      {t('intent.statusRunning')}
                    </StatusChip>
                  ) : session.status === 'archived' ? (
                    <StatusChip kind="neutral">{t('intent.statusArchived')}</StatusChip>
                  ) : (
                    <StatusChip kind="success">{t('intent.statusActive')}</StatusChip>
                  )
                }
              >
                <div className="intent-session-card__meta">
                  <span>{t('intent.roundsCount', { count: session.turnSeq })}</span>
                  <span>{t('intent.commitsCount', { count: session.commitSeq })}</span>
                  <RelativeTime ts={session.updatedAt} />
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
