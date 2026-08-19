// RFC-310 PR-13 — one shared, first-screen answer to “what happens next?”.
// The backend owns the projection; this component only translates and renders
// it. Human actions remain visible even when unavailable, while automatic
// waits explicitly say that no user action is required.

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { StatusChip } from '@/components/StatusChip'

export interface JourneyProjection {
  schemaVersion: 1
  journey: 'employee-setup' | 'mission-delivery'
  current: { key: string; ordinal: number; total: number; detailKey: string }
  next: {
    key: string
    kind: 'navigate' | 'command' | 'form' | 'automatic-wake' | 'external-human' | 'complete'
    detailKey: string
    owner: 'current-user' | 'committer' | 'platform' | 'digital-employee' | 'external-system'
    href: string | null
    command: string | null
    available: boolean
    unavailableReason: string | null
    wake: {
      source: 'webhook' | 'timer' | 'child-mission' | 'approval' | 'mr-facts' | null
      resumeAt: number | null
      deadlineAt: number | null
      descriptionKey: string | null
    }
  }
  steps: Array<{
    key: string
    state: 'done' | 'current' | 'next' | 'pending' | 'blocked' | 'skipped'
    owner: JourneyProjection['next']['owner']
    href: string | null
  }>
  reasonRefs: string[]
  projectionRevision: string
}

interface Props {
  journey: JourneyProjection
  onCommand?: (command: string) => void
  commandPending?: boolean
  className?: string
}

function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

export function JourneyNextAction(props: Props): ReactElement {
  const { t } = useTranslation()
  const automatic =
    props.journey.next.kind === 'automatic-wake' ||
    props.journey.next.owner === 'platform' ||
    props.journey.next.owner === 'digital-employee' ||
    props.journey.next.owner === 'external-system'
  const canInvokeCommand = props.journey.next.command !== null && props.onCommand !== undefined
  const actionLabel = t(`code.journey.next.${props.journey.next.key}`, {
    defaultValue: props.journey.next.key,
  })
  const action = (() => {
    if (automatic && props.journey.next.kind !== 'complete') {
      return <StatusChip kind="info">{t('code.journey.noActionRequired')}</StatusChip>
    }
    if (canInvokeCommand) {
      return (
        <button
          type="button"
          className="btn btn--primary"
          disabled={!props.journey.next.available || props.commandPending === true}
          onClick={() => props.onCommand?.(props.journey.next.command!)}
          data-testid="journey-next-command"
        >
          {props.commandPending === true ? t('common.saving') : actionLabel}
        </button>
      )
    }
    if (props.journey.next.href !== null) {
      return (
        <a
          href={props.journey.next.href}
          className={`btn btn--primary${props.journey.next.available ? '' : ' btn--disabled'}`}
          aria-disabled={!props.journey.next.available}
          onClick={(event) => {
            if (!props.journey.next.available) event.preventDefault()
          }}
          {...(isExternalHref(props.journey.next.href)
            ? { target: '_blank', rel: 'noreferrer' }
            : {})}
          data-testid="journey-next-link"
        >
          {actionLabel}
        </a>
      )
    }
    return null
  })()

  return (
    <section
      className={`journey-next-action${props.className ? ` ${props.className}` : ''}`}
      aria-labelledby="journey-next-action-title"
      data-testid="journey-next-action"
      data-projection-revision={props.journey.projectionRevision}
    >
      <ol className="journey-next-action__steps" aria-label={t('code.journey.progress')}>
        {props.journey.steps.map((step, index) => (
          <li
            key={step.key}
            className={`journey-next-action__step journey-next-action__step--${step.state}`}
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <span className="journey-next-action__marker" aria-hidden="true">
              {step.state === 'done' ? '✓' : index + 1}
            </span>
            <span>
              {t(`code.journey.step.${props.journey.journey}.${step.key}`, {
                defaultValue: step.key,
              })}
            </span>
          </li>
        ))}
      </ol>

      <div className="journey-next-action__body">
        <div className="journey-next-action__current">
          <span className="journey-next-action__eyebrow">
            {t('code.journey.current', {
              current: props.journey.current.ordinal,
              total: props.journey.current.total,
            })}
          </span>
          <strong>
            {t(`code.journey.step.${props.journey.journey}.${props.journey.current.key}`, {
              defaultValue: props.journey.current.key,
            })}
          </strong>
          <span>
            {t(`code.journey.detail.${props.journey.current.detailKey}`, {
              defaultValue: props.journey.current.detailKey,
            })}
          </span>
        </div>

        <div className="journey-next-action__next">
          <div>
            <span className="journey-next-action__eyebrow" id="journey-next-action-title">
              {t('code.journey.nextAction')}
            </span>
            <h2>{actionLabel}</h2>
            <p>
              {t(`code.journey.detail.${props.journey.next.detailKey}`, {
                defaultValue: props.journey.next.detailKey,
              })}
            </p>
            <div className="journey-next-action__meta">
              <StatusChip kind={automatic ? 'info' : 'neutral'} size="sm">
                {t('code.journey.owner', {
                  owner: t(`code.journey.ownerName.${props.journey.next.owner}`),
                })}
              </StatusChip>
              {props.journey.next.wake.descriptionKey !== null ? (
                <span>
                  {t(`code.journey.wake.${props.journey.next.wake.descriptionKey}`, {
                    defaultValue: props.journey.next.wake.descriptionKey,
                  })}
                </span>
              ) : null}
              {props.journey.next.wake.resumeAt !== null ? (
                <span>
                  {t('code.journey.resumeAt', {
                    time: new Date(props.journey.next.wake.resumeAt).toLocaleString(),
                  })}
                </span>
              ) : null}
              {props.journey.next.wake.deadlineAt !== null ? (
                <span>
                  {t('code.journey.deadlineAt', {
                    time: new Date(props.journey.next.wake.deadlineAt).toLocaleString(),
                  })}
                </span>
              ) : null}
            </div>
          </div>
          <div className="journey-next-action__action">
            {action}
            {!props.journey.next.available && props.journey.next.unavailableReason !== null ? (
              <span
                className="journey-next-action__unavailable"
                data-testid="journey-next-unavailable"
              >
                {t('code.journey.unavailable', {
                  reason: props.journey.next.unavailableReason,
                })}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
