import type { IntentSessionDetail } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'

export type IntentJourneyKind =
  | 'generating'
  | 'clarifying'
  | 'review-ready'
  | 'review-blocked'
  | 'applying'
  | 'applied'
  | 'error'
  | 'idle-active'
  | 'archived'

export interface IntentJourneyState {
  kind: IntentJourneyKind
  step: 0 | 1 | 2 | 3
  completedThrough: -1 | 0 | 1 | 2 | 3
}

export function deriveIntentJourneyState(detail: IntentSessionDetail): IntentJourneyState {
  const latestAgentTurn = [...detail.turns]
    .filter((turn) => turn.role === 'agent')
    .sort((a, b) => b.seq - a.seq || b.id.localeCompare(a.id))[0]
  const latestTurn = [...detail.turns].sort((a, b) => b.seq - a.seq || b.id.localeCompare(a.id))[0]
  const latestCommit = [...detail.commits].sort(
    (a, b) => b.createdAt - a.createdAt || b.journalId.localeCompare(a.journalId),
  )[0]

  const active = (): IntentJourneyState => {
    if (latestCommit?.state === 'prepared' || latestCommit?.state === 'applying') {
      return { kind: 'applying', step: 3, completedThrough: 2 }
    }
    if (detail.session.inFlight) {
      return { kind: 'generating', step: 1, completedThrough: 0 }
    }
    if (latestAgentTurn?.kind === 'questions') {
      return { kind: 'clarifying', step: 1, completedThrough: 0 }
    }
    if (detail.currentDraft !== null) {
      if (detail.currentDraft.stale || detail.currentDraft.validation.errors.length > 0) {
        return { kind: 'review-blocked', step: 2, completedThrough: 1 }
      }
      if (latestCommit?.state === 'failed') {
        return { kind: 'error', step: 3, completedThrough: 2 }
      }
      return { kind: 'review-ready', step: 2, completedThrough: 1 }
    }
    if (latestTurn?.kind === 'error') {
      return { kind: 'error', step: 1, completedThrough: 0 }
    }
    if (latestCommit?.state === 'committed') {
      return { kind: 'applied', step: 3, completedThrough: 3 }
    }
    return { kind: 'idle-active', step: 0, completedThrough: -1 }
  }

  if (detail.session.status === 'archived') {
    const base = active()
    return { ...base, kind: 'archived' }
  }
  return active()
}

export function IntentJourneyProgress({ detail }: { detail: IntentSessionDetail }) {
  const { t } = useTranslation()
  const state = deriveIntentJourneyState(detail)
  const steps = [
    t('intent.journey.goal'),
    t('intent.journey.generate'),
    t('intent.journey.review'),
    t('intent.journey.apply'),
  ]

  return (
    <section className="intent-journey" aria-label={t('intent.journey.ariaLabel')}>
      <ol className="intent-journey__steps">
        {steps.map((label, index) => {
          const status =
            index <= state.completedThrough
              ? 'done'
              : index === state.step && state.kind !== 'archived'
                ? state.kind === 'error' || state.kind === 'review-blocked'
                  ? 'blocked'
                  : 'current'
                : 'todo'
          return (
            <li
              key={label}
              className={`intent-journey__step intent-journey__step--${status}`}
              aria-current={status === 'current' || status === 'blocked' ? 'step' : undefined}
            >
              <span className="intent-journey__marker" aria-hidden="true">
                {status === 'done' ? '✓' : status === 'blocked' ? '!' : index + 1}
              </span>
              <span>{label}</span>
            </li>
          )
        })}
      </ol>
      <p className="intent-journey__summary">{t(`intent.journey.state.${state.kind}`)}</p>
    </section>
  )
}
