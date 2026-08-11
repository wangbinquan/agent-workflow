import type {
  IntentJourneyKind,
  IntentJourneySnapshot,
  IntentSessionDetail,
  IntentSessionSummary,
} from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { StatusChip, type StatusChipKind, type StatusChipSize } from '@/components/StatusChip'

export type IntentJourneyState = IntentJourneySnapshot

const JOURNEY_STEP_KEYS = ['goal', 'generate', 'review', 'apply'] as const

export function deriveIntentJourneyState(detail: IntentSessionDetail): IntentJourneyState {
  return detail.session.journey
}

export function deriveIntentSummaryJourneyState(session: IntentSessionSummary): IntentJourneyState {
  return session.journey
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
    case 'goal':
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
  const stage = t(`intent.journey.${JOURNEY_STEP_KEYS[props.state.step - 1]}`)
  const stageStatus = t('intent.journey.stageStatus', {
    current: props.state.step,
    total: JOURNEY_STEP_KEYS.length,
    stage,
  })
  const label =
    props.state.kind === 'archived'
      ? t('intent.journey.archivedStageStatus', { stageStatus })
      : stageStatus
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
      data-step={state.step}
    >
      <ol className="intent-journey__steps">
        {steps.map((label, index) => {
          const status =
            index + 1 <= state.completedThrough
              ? 'done'
              : index + 1 === state.step && state.kind !== 'archived'
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
            current: state.step,
            total: steps.length,
          })}
        </span>
        <strong className="intent-journey__summary-stage">{steps[state.step - 1]}</strong>
        <span className="intent-journey__summary-detail">
          {t(`intent.journey.reason.${state.reason}`)}
        </span>
      </div>
    </section>
  )
}
