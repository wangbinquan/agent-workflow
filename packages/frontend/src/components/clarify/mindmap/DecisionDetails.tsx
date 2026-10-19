import { useTranslation } from 'react-i18next'
import {
  normalizeClarifyDecision,
  type ClarifyAnswer,
  type ClarifyDecision,
} from '@agent-workflow/shared'
import { Field, TextArea, TextInput } from '@/components/Form'
import { Segmented } from '@/components/Segmented'

const fields = ['rationale', 'tradeoff', 'uncertainty', 'validationOwner', 'revisitWhen'] as const

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
              <dt>{t(`mindmap.decision.${field}`)}</dt>
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

export function DecisionDetails({
  answer,
  disabled,
  onChange,
}: {
  answer: ClarifyAnswer
  disabled: boolean
  onChange(answer: ClarifyAnswer): void
}) {
  const { t } = useTranslation()
  const decision = answer.decision
  const change = (patch: Partial<ClarifyDecision>) =>
    onChange({
      ...answer,
      decision: normalizeClarifyDecision({ ...decision, ...patch }),
      confirmedBasis: undefined,
    })
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
          <Field label={t('mindmap.decision.status')} group>
            <Segmented
              value={decision?.status ?? 'unmarked'}
              options={(['unmarked', 'decided', 'provisional'] as const).map((value) => ({
                value,
                label: t(`mindmap.decision.${value}`),
              }))}
              ariaLabel={t('mindmap.decision.status')}
              onChange={(status) => change({ status: status === 'unmarked' ? undefined : status })}
            />
          </Field>
          {fields.map((field) => (
            <Field key={field} label={t(`mindmap.decision.${field}`)}>
              {field === 'validationOwner' || field === 'revisitWhen' ? (
                <TextInput
                  value={decision?.[field] ?? ''}
                  maxLength={field === 'validationOwner' ? 200 : 500}
                  onChange={(value) => change({ [field]: value })}
                />
              ) : (
                <TextArea
                  value={decision?.[field] ?? ''}
                  rows={2}
                  maxLength={2000}
                  onChange={(value) => change({ [field]: value })}
                />
              )}
            </Field>
          ))}
        </div>
      )}
    </details>
  )
}
