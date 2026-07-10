// RFC-165 (T11) — the shared multi-step wizard primitive.
//
// Renders a numbered step header (visited steps are clickable for backtrack,
// the current step is highlighted, completed steps show a check), the current
// step's content slot, and a footer action row (Back / Next or the caller's
// terminal actions on the last step). Purely controlled: the caller owns the
// `current` index and validity gating — the primitive never advances on its
// own, it only reports intents via `onNavigate`.
//
// A11y: the header is a list of buttons with `aria-current="step"` on the
// active one; forward jumps beyond the reachable frontier are disabled, so
// keyboard users cannot skip gating.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface StepperStep {
  /** Stable key — used for testids (`stepper-step-<key>`). */
  key: string
  /** Header label for the step. */
  title: string
}

export interface StepperProps {
  steps: ReadonlyArray<StepperStep>
  /** Zero-based index of the active step. */
  current: number
  /**
   * Highest step index the user may reach directly (inclusive). Visited
   * steps stay clickable for backtracking; anything past `maxReachable` is
   * disabled until the caller's gating opens it. Defaults to `current`.
   */
  maxReachable?: number
  /** The active step's body. */
  children: ReactNode
  /** Step-change intent (header click or Back button). */
  onNavigate: (index: number) => void
  /**
   * Whether the Next button is enabled (the caller's per-step gate).
   * Ignored on the last step, where `finalActions` replaces Next.
   */
  nextEnabled?: boolean
  /** Terminal action buttons rendered instead of Next on the LAST step. */
  finalActions?: ReactNode
  /** Optional extra class names on the root. */
  className?: string
  rootTestid?: string
}

export function Stepper({
  steps,
  current,
  maxReachable,
  children,
  onNavigate,
  nextEnabled = true,
  finalActions,
  className,
  rootTestid,
}: StepperProps) {
  const { t } = useTranslation()
  const reachable = maxReachable ?? current
  const isLast = current === steps.length - 1

  return (
    <div className={`stepper${className ? ` ${className}` : ''}`} data-testid={rootTestid}>
      <ol className="stepper__header" aria-label={t('stepper.progress')}>
        {steps.map((step, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'todo'
          const clickable = i !== current && i <= reachable
          return (
            <li key={step.key} className={`stepper__item stepper__item--${state}`}>
              <button
                type="button"
                className="stepper__step"
                data-testid={`stepper-step-${step.key}`}
                disabled={!clickable}
                aria-current={i === current ? 'step' : undefined}
                onClick={() => onNavigate(i)}
              >
                <span className="stepper__index" aria-hidden="true">
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span className="stepper__title">{step.title}</span>
              </button>
            </li>
          )
        })}
      </ol>

      <div className="stepper__body">{children}</div>

      <div className="stepper__actions form-actions">
        {current > 0 && (
          <button
            type="button"
            className="btn"
            data-testid="stepper-back"
            onClick={() => onNavigate(current - 1)}
          >
            {t('stepper.back')}
          </button>
        )}
        {!isLast ? (
          <button
            type="button"
            className="btn btn--primary"
            data-testid="stepper-next"
            disabled={!nextEnabled}
            onClick={() => onNavigate(current + 1)}
          >
            {t('stepper.next')}
          </button>
        ) : (
          finalActions
        )}
      </div>
    </div>
  )
}
