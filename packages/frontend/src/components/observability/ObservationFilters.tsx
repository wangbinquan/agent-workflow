import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TASK_STATUS,
  ObservationDimensionSelectionSchema,
  type ObservationDimensionSelection,
} from '@agent-workflow/shared'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import type { ObservationSearch } from './RunObservability'
import { observationPresetRange } from './observationPresetRange'
import { observationCustomRange, observationLocalDateInput } from './observationCustomRange'

export function ObservationFilters({
  search,
  onChange,
  onEditingTimeRange,
}: {
  search: ObservationSearch
  onChange: (search: ObservationSearch) => void
  onEditingTimeRange?: (editing: boolean) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<{
    from: string
    to: string
    original: { from: number; to: number; period: ObservationSearch['period'] }
  } | null>(null)
  const [invalidRange, setInvalidRange] = useState(false)
  const errorId = useId()
  const matchesRange = (value: NonNullable<typeof draft>) =>
    value.original.from === search.from &&
    value.original.to === search.to &&
    value.original.period === search.period
  const activeDraft = draft && matchesRange(draft) ? draft : null
  const from = activeDraft?.from ?? observationLocalDateInput(search.from)
  const to = activeDraft?.to ?? observationLocalDateInput(search.to)
  useEffect(() => {
    // A chart drill-down, back navigation or accepted range application cannot
    // reuse an edit made for another window. Live cutoff movement is paused by
    // the parent while editing; record refresh within this window continues.
    if (draft && !activeDraft) {
      setDraft(null)
      setInvalidRange(false)
      onEditingTimeRange?.(false)
    }
  }, [draft, activeDraft, onEditingTimeRange])
  useEffect(() => () => onEditingTimeRange?.(false), [onEditingTimeRange])
  const editBoundary = (key: 'from' | 'to', value: string) => {
    setDraft((previous) => ({
      ...(previous && matchesRange(previous)
        ? previous
        : {
            from: observationLocalDateInput(search.from),
            to: observationLocalDateInput(search.to),
            original: { from: search.from, to: search.to, period: search.period },
          }),
      [key]: value,
    }))
    setInvalidRange(false)
    onEditingTimeRange?.(true)
  }
  const dimensions = search.selection
    ? ObservationDimensionSelectionSchema.parse(JSON.parse(search.selection))
    : null
  const update = (patch: Partial<ObservationSearch>) =>
    onChange({
      ...search,
      ...patch,
      after: undefined,
      agent: undefined,
      quality: undefined,
      runtime: undefined,
      model: undefined,
    })
  return (
    <div className="observation-filters" role="group" aria-label={t('runObservability.filters')}>
      <div
        className="observation-filters__row"
        role="group"
        aria-label={t(
          search.cohort === 'usage' ? 'runObservability.usagePeriod' : 'runObservability.period',
        )}
      >
        <Field label={t('runObservability.start')}>
          <TextInput
            type="datetime-local"
            aria-label={t('runObservability.start')}
            aria-invalid={invalidRange || undefined}
            aria-describedby={invalidRange ? errorId : undefined}
            value={from}
            onChange={(value) => editBoundary('from', value)}
          />
        </Field>
        <Field label={t('runObservability.end')}>
          <TextInput
            type="datetime-local"
            aria-label={t('runObservability.end')}
            aria-invalid={invalidRange || undefined}
            aria-describedby={invalidRange ? errorId : undefined}
            value={to}
            onChange={(value) => editBoundary('to', value)}
          />
        </Field>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const range = observationCustomRange({ from, to }, activeDraft?.original ?? search)
            if (!range) {
              setInvalidRange(true)
              return
            }
            setInvalidRange(false)
            if (
              range.from === search.from &&
              range.to === search.to &&
              search.period === 'custom'
            ) {
              setDraft(null)
              onEditingTimeRange?.(false)
            } else {
              // Release the pause after the URL accepts the chosen range.
              if (!activeDraft)
                setDraft({
                  from,
                  to,
                  original: { from: search.from, to: search.to, period: search.period },
                })
              onEditingTimeRange?.(true)
            }
            update({ ...range, period: 'custom' })
          }}
        >
          {t('runObservability.applyTimeRange')}
        </button>
        <div className="observation-filters__shortcuts">
          {(['day', 'week', 'month', 'all'] as const).map((period) => (
            <button
              key={period}
              type="button"
              className={`btn${search.period === period ? '' : ' btn--ghost'}`}
              aria-pressed={search.period === period}
              onClick={() => {
                setInvalidRange(false)
                const range = observationPresetRange(period, search.to)
                if (
                  period === search.period &&
                  range.from === search.from &&
                  range.to === search.to
                ) {
                  setDraft(null)
                  onEditingTimeRange?.(false)
                }
                update({ period, ...range })
              }}
            >
              {t(`runObservability.${period}`)}
            </button>
          ))}
        </div>
      </div>
      {invalidRange && (
        <span id={errorId} role="alert" className="form-field__error">
          {t('runObservability.invalidTimeRange')}
        </span>
      )}
      <div className="observation-filters__row">
        <Field label={t('runObservability.taskQuery')}>
          <TextInput
            type="search"
            value={search.q ?? ''}
            aria-label={t('runObservability.taskQuery')}
            maxLength={200}
            onChange={(q) => update({ q: q.trim() ? q : undefined })}
          />
        </Field>
        <Field label={t('runObservability.state')} group>
          <Select<NonNullable<ObservationSearch['status']> | ''>
            value={search.status ?? ''}
            ariaLabel={t('runObservability.state')}
            options={[
              { value: '', label: t('runObservability.allStates') },
              ...TASK_STATUS.map((value) => ({ value, label: t(`tasks.status.${value}`) })),
            ]}
            onChange={(status) => update({ status: status || undefined })}
          />
        </Field>
        <Field label={t('runObservability.repositoryFilter')}>
          <TextInput
            value={search.repository ?? ''}
            aria-label={t('runObservability.repositoryFilter')}
            maxLength={4096}
            placeholder={t('runObservability.repositoryPlaceholder')}
            onChange={(repository) =>
              update({ repository: repository.trim() ? repository : undefined })
            }
          />
        </Field>
        {(search.q || search.status || search.repository || search.workflow) && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() =>
              update({
                q: undefined,
                status: undefined,
                repository: undefined,
                workflow: undefined,
              })
            }
          >
            {t('runObservability.clearFilters')}
          </button>
        )}
      </div>
      {(dimensions || search.workflow) && (
        <div className="observation-filters__row">
          {dimensions &&
            (Object.keys(dimensions) as (keyof ObservationDimensionSelection)[]).map((key) => (
              <button
                key={key}
                type="button"
                className="btn btn--sm btn--ghost"
                aria-label={t('runObservability.clearDimension', {
                  name: t(`runObservability.dimension_${key}`),
                })}
                onClick={() => {
                  const next = { ...dimensions }
                  delete next[key]
                  update({ selection: Object.keys(next).length ? JSON.stringify(next) : undefined })
                }}
              >
                {t(`runObservability.dimension_${key}`)} <span aria-hidden="true">×</span>
              </button>
            ))}
          {dimensions && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => update({ selection: undefined })}
            >
              {t('runObservability.clearDimensions')}
            </button>
          )}
          {search.workflow && (
            <span className="muted">
              {t('runObservability.workflowActive', { id: search.workflow })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
