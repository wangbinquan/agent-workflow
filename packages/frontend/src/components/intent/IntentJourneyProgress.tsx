import type { IntentSessionDetail, IntentSessionSummary } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { StatusChip, type StatusChipKind, type StatusChipSize } from '@/components/StatusChip'

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

const JOURNEY_STEP_KEYS = ['goal', 'generate', 'review', 'apply'] as const

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
      if (latestCommit?.state === 'failed' && latestCommit.draftId === detail.currentDraft.id) {
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

export function deriveIntentSummaryJourneyState(session: IntentSessionSummary): IntentJourneyState {
  const active = (): IntentJourneyState => {
    if (session.inFlight) return { kind: 'generating', step: 1, completedThrough: 0 }
    if (session.currentDraftRevision !== null) {
      return { kind: 'review-ready', step: 2, completedThrough: 1 }
    }
    if (session.commitSeq > 0) return { kind: 'applied', step: 3, completedThrough: 3 }
    if (session.turnSeq > 1) return { kind: 'generating', step: 1, completedThrough: 0 }
    return { kind: 'idle-active', step: 0, completedThrough: -1 }
  }
  const base = active()
  return session.status === 'archived' ? { ...base, kind: 'archived' } : base
}

function stageChipKind(kind: IntentJourneyKind): StatusChipKind {
  switch (kind) {
    case 'generating':
    case 'applying':
      return 'info'
    case 'clarifying':
    case 'review-ready':
      return 'warn'
    case 'review-blocked':
    case 'error':
      return 'danger'
    case 'applied':
      return 'success'
    case 'idle-active':
    case 'archived':
      return 'neutral'
  }
}

export function IntentStageStatus(props: {
  state: IntentJourneyState
  size?: StatusChipSize
  'data-testid'?: string
}) {
  const { t } = useTranslation()
  const stage = t(`intent.journey.${JOURNEY_STEP_KEYS[props.state.step]}`)
  const label = t('intent.journey.stageStatus', {
    current: props.state.step + 1,
    total: JOURNEY_STEP_KEYS.length,
    stage,
  })
  return (
    <StatusChip
      kind={stageChipKind(props.state.kind)}
      size={props.size}
      withDot={props.state.kind === 'generating' || props.state.kind === 'applying'}
      aria-label={label}
      data-testid={props['data-testid']}
    >
      {label}
    </StatusChip>
  )
}

export function IntentJourneyProgress({ detail }: { detail: IntentSessionDetail }) {
  const { t } = useTranslation()
  const state = deriveIntentJourneyState(detail)
  const steps = JOURNEY_STEP_KEYS.map((key) => t(`intent.journey.${key}`))

  return (
    <section
      className="intent-journey"
      aria-label={t('intent.journey.ariaLabel')}
      data-state={state.kind}
      data-step={state.step + 1}
    >
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
              data-status={status}
              aria-current={status === 'current' || status === 'blocked' ? 'step' : undefined}
            >
              <span className="intent-journey__marker" aria-hidden="true">
                {status === 'done' ? '✓' : status === 'blocked' ? '!' : index + 1}
              </span>
              <span className="intent-journey__label">{label}</span>
            </li>
          )
        })}
      </ol>
      <div
        className="intent-journey__summary"
        data-testid="intent-journey-state"
        aria-live="polite"
      >
        <span className="intent-journey__summary-kicker">
          {t('intent.journey.currentStage', {
            current: state.step + 1,
            total: steps.length,
          })}
        </span>
        <strong className="intent-journey__summary-stage">{steps[state.step]}</strong>
        <span className="intent-journey__summary-detail">
          {t(`intent.journey.state.${state.kind}`)}
        </span>
      </div>
    </section>
  )
}
