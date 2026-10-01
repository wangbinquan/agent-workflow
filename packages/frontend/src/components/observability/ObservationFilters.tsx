import { useTranslation } from 'react-i18next'
import {
  TASK_STATUS,
  ObservationDimensionSelectionSchema,
  type ObservationDimensionSelection,
} from '@agent-workflow/shared'
import { FilterBar, FilterField } from '@/components/FilterBar'
import { TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import type { ObservationSearch } from './RunObservability'

export function ObservationFilters({
  search,
  onChange,
}: {
  search: ObservationSearch
  onChange: (search: ObservationSearch) => void
}) {
  const { t } = useTranslation()
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
    <FilterBar
      ariaLabel={t('runObservability.filters')}
      trailing={
        <>
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
          {(search.q || search.status || search.repository || search.workflow) && (
            <button
              type="button"
              className="btn btn--sm"
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
        </>
      }
    >
      <FilterField label={t('runObservability.period')}>
        <Select
          value={search.period}
          ariaLabel={t('runObservability.period')}
          options={(search.period === 'custom'
            ? (['week', 'month', 'all', 'custom'] as const)
            : (['week', 'month', 'all'] as const)
          ).map((value) => ({ value, label: t(`runObservability.${value}`) }))}
          onChange={(period) => {
            if (period === 'custom') return
            const to = Date.now() + 1
            update({
              period,
              from:
                period === 'all' ? 0 : Math.max(0, to - (period === 'week' ? 7 : 30) * 86400000),
              to,
            })
          }}
        />
      </FilterField>
      <FilterField label={t('runObservability.taskQuery')}>
        <TextInput
          value={search.q ?? ''}
          aria-label={t('runObservability.taskQuery')}
          maxLength={200}
          onChange={(q) => update({ q: q.trim() ? q : undefined })}
        />
      </FilterField>
      <FilterField label={t('runObservability.state')}>
        <Select<NonNullable<ObservationSearch['status']> | ''>
          value={search.status ?? ''}
          ariaLabel={t('runObservability.state')}
          options={[
            { value: '', label: t('runObservability.allStates') },
            ...TASK_STATUS.map((value) => ({
              value,
              label: t(`tasks.status.${value}`),
            })),
          ]}
          onChange={(status) => update({ status: status || undefined })}
        />
      </FilterField>
      <FilterField label={t('runObservability.repositoryFilter')}>
        <TextInput
          value={search.repository ?? ''}
          aria-label={t('runObservability.repositoryFilter')}
          maxLength={4096}
          placeholder={t('runObservability.repositoryPlaceholder')}
          onChange={(repository) =>
            update({ repository: repository.trim() ? repository : undefined })
          }
        />
      </FilterField>
    </FilterBar>
  )
}
