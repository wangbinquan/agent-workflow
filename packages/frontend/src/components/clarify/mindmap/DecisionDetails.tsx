import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isClarifySkipStatus,
  normalizeClarifyDecision,
  type ClarifyAnswer,
  type ClarifyDecision,
} from '@agent-workflow/shared'
import { Field, TextArea, TextInput } from '@/components/Form'
import { Segmented } from '@/components/Segmented'

const fields = ['rationale', 'tradeoff', 'uncertainty', 'validationOwner', 'revisitWhen'] as const
/** Everything except the rationale, which the inline layout keeps in view. */
const more = fields.slice(1)

export function DecisionReadback({ decision }: { decision?: ClarifyDecision }) {
  const { t } = useTranslation()
  return (
    <div className="mindmap-decision__readback">
      <span
        className="mindmap-decision__status"
        data-decision-status={decision?.status ?? 'unmarked'}
      >
        {t(`mindmap.decision.${decision?.status ?? 'unmarked'}`)}
      </span>
      <dl>
        {fields.map((field) =>
          decision?.[field] ? (
            <div key={field}>
              <dt>{t(`mindmap.decision.${rationaleKey(field, decision.status)}`)}</dt>
              <dd>{decision[field]}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {decision?.status === 'provisional' &&
        (!decision.validationOwner || !decision.revisitWhen) && (
          <p className="mindmap-decision__unknown">{t('mindmap.decision.missingReview')}</p>
        )}
    </div>
  )
}
/** A skipped question's note explains the skip, not a choice. */
function rationaleKey(field: (typeof fields)[number], status: ClarifyDecision['status']): string {
  if (field !== 'rationale') return field
  return status === 'not-applicable' ? 'naNote' : status === 'deferred' ? 'deferredNote' : field
}

export function DecisionDetails({
  answer,
  disabled,
  layout = 'collapsed',
  part,
  onChange,
}: {
  answer: ClarifyAnswer
  disabled: boolean
  /** `inline` (RFC-490): the rationale and the maturity stay in view; only the
   *  remaining notes fold away. `collapsed` folds everything. */
  layout?: 'collapsed' | 'inline'
  /** With `inline`: render only the always-visible pair (`essentials`) or only the fold
   *  with the remaining notes (`more`), so the two can live in different places. The
   *  mindmap keeps the pair beside its confirm button, where it never scrolls away. */
  part?: 'essentials' | 'more'
  onChange(answer: ClarifyAnswer): void
}) {
  const { t } = useTranslation()
  const decision = answer.decision
  const skipped = isClarifySkipStatus(decision?.status)
  const hasMore = more.some((field) => decision?.[field])
  const [open, setOpen] = useState(decision?.status === 'provisional' || hasMore)
  // Decided once per question: the field must not change kind under the caret.
  const [multiline] = useState(() => decision?.rationale?.includes('\n') ?? false)
  // A provisional decision is the moment its unknowns and review plan are asked for.
  useEffect(() => {
    if (decision?.status === 'provisional') setOpen(true)
  }, [decision?.status])
  const change = (patch: Partial<ClarifyDecision>) =>
    onChange({
      ...answer,
      decision: normalizeClarifyDecision({ ...decision, ...patch }),
      confirmedBasis: undefined,
    })
  // The maturity control only offers its own three values; a skipped answer shows none set.
  const maturity = skipped ? 'unmarked' : (decision?.status ?? 'unmarked')
  const status = (
    <Field label={t('mindmap.decision.status')} group>
      <Segmented
        value={maturity}
        options={(['unmarked', 'decided', 'provisional'] as const).map((value) => ({
          value,
          label: t(`mindmap.decision.${value}`),
        }))}
        ariaLabel={t('mindmap.decision.status')}
        onChange={(value) => change({ status: value === 'unmarked' ? undefined : value })}
      />
    </Field>
  )
  const field = (name: (typeof fields)[number]) => (
    <Field key={name} label={t(`mindmap.decision.${rationaleKey(name, decision?.status)}`)}>
      {name === 'validationOwner' || name === 'revisitWhen' ? (
        <TextInput
          value={decision?.[name] ?? ''}
          maxLength={name === 'validationOwner' ? 200 : 500}
          onChange={(value) => change({ [name]: value })}
        />
      ) : (
        <TextArea
          value={decision?.[name] ?? ''}
          rows={2}
          maxLength={2000}
          onChange={(value) => change({ [name]: value })}
        />
      )}
    </Field>
  )
  if (layout === 'inline' && disabled)
    return part === 'essentials' ? null : (
      <div className="mindmap-decision mindmap-decision--inline">
        <DecisionReadback decision={decision} />
      </div>
    )
  if (layout === 'inline') {
    const essentials = (
      <>
        <Field label={t('mindmap.decision.rationaleOptional')}>
          {multiline ? (
            // Wording written elsewhere over several lines is not squeezed into one.
            <TextArea
              value={decision?.rationale ?? ''}
              rows={2}
              maxLength={2000}
              onChange={(value) => change({ rationale: value })}
            />
          ) : (
            <TextInput
              value={decision?.rationale ?? ''}
              maxLength={2000}
              placeholder={t('mindmap.decision.rationalePlaceholder')}
              onChange={(value) => change({ rationale: value })}
            />
          )}
        </Field>
        {status}
      </>
    )
    const fold = (
      <details
        className="mindmap-decision__more"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>{t('mindmap.decision.more')}</summary>
        <div className="mindmap-decision__fields">
          <p className="muted">{t('mindmap.decision.hint')}</p>
          {more.map((name) => field(name))}
        </div>
      </details>
    )
    if (part === 'essentials')
      return <div className="mindmap-decision mindmap-decision--essentials">{essentials}</div>
    return (
      <div className="mindmap-decision mindmap-decision--inline">
        {part === 'more' ? null : essentials}
        {fold}
      </div>
    )
  }
  return (
    <details className="mindmap-decision" key={answer.questionId}>
      <summary>
        {t('mindmap.decision.title')} · {t(`mindmap.decision.${decision?.status ?? 'unmarked'}`)}
      </summary>
      {disabled ? (
        <DecisionReadback decision={decision} />
      ) : (
        <div className="mindmap-decision__fields">
          <p className="muted">{t('mindmap.decision.hint')}</p>
          {status}
          {fields.map((name) => field(name))}
        </div>
      )}
    </details>
  )
}
