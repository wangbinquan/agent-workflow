import {
  ImportRefAmbiguitySchema,
  importRefSelectorKey,
  type ImportRefAmbiguity,
  type ImportRefSelection,
} from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/client'
import { Field } from './Form'
import { Select } from './Select'

export function importRefAmbiguitiesFromError(error: unknown): ImportRefAmbiguity[] | null {
  if (!(error instanceof ApiError) || error.code !== 'import-ref-ambiguous') return null
  return importRefChoicesFromDetails(error.details)
}

export function importRefStaleChoicesFromError(error: unknown): ImportRefAmbiguity[] | null {
  if (!(error instanceof ApiError) || error.code !== 'import-ref-selection-stale') return null
  return importRefChoicesFromDetails(error.details)
}

function importRefChoicesFromDetails(details: unknown): ImportRefAmbiguity[] | null {
  if (typeof details !== 'object' || details === null) return null
  const parsed = ImportRefAmbiguitySchema.array().safeParse(
    (details as { ambiguities?: unknown }).ambiguities,
  )
  return parsed.success ? parsed.data : null
}

export function ImportRefMappingFields(props: {
  ambiguities: readonly ImportRefAmbiguity[]
  selections: readonly ImportRefSelection[]
  onChange: (selections: ImportRefSelection[]) => void
  disabled?: boolean
  testidPrefix: string
}) {
  const { t } = useTranslation()
  const selectedByKey = new Map(
    props.selections.map((selection) => [importRefSelectorKey(selection.selector), selection]),
  )
  return (
    <div className="stack--sm" data-testid={`${props.testidPrefix}-mapping`}>
      {props.ambiguities.map((ambiguity) => {
        const key = importRefSelectorKey(ambiguity.selector)
        const value = selectedByKey.get(key)?.resourceId ?? ''
        const typeLabel = t(`importRefs.resourceType.${ambiguity.selector.type}`)
        const label = t('importRefs.selectorLabel', {
          type: typeLabel,
          name: ambiguity.selector.name,
        })
        return (
          <Field label={label} group key={key}>
            <Select
              value={value}
              disabled={props.disabled}
              ariaLabel={label}
              placeholder={t('importRefs.selectOwner')}
              data-testid={`${props.testidPrefix}-mapping-${ambiguity.selector.type}-${ambiguity.selector.name}`}
              options={ambiguity.candidates.map((candidate) => ({
                value: candidate.id,
                label: candidate.ownerUsername ?? candidate.ownerUserId ?? t('acl.systemOwner'),
                description: t('importRefs.candidateDescription', {
                  visibility: t(`acl.visibilityValue.${candidate.visibility}`),
                  id: candidate.id,
                }),
              }))}
              onChange={(resourceId) => {
                const retained = props.selections.filter(
                  (selection) => importRefSelectorKey(selection.selector) !== key,
                )
                const candidate = ambiguity.candidates.find((item) => item.id === resourceId)
                props.onChange(
                  candidate === undefined
                    ? retained
                    : [
                        ...retained,
                        {
                          selector: ambiguity.selector,
                          resourceId,
                          expectedAclRevision: candidate.aclRevision,
                        },
                      ],
                )
              }}
            />
          </Field>
        )
      })}
    </div>
  )
}

export function hasEveryImportRefSelection(
  ambiguities: readonly ImportRefAmbiguity[],
  selections: readonly ImportRefSelection[],
): boolean {
  const selected = new Map(
    selections.map((selection) => [importRefSelectorKey(selection.selector), selection]),
  )
  return ambiguities.every((ambiguity) => {
    const selection = selected.get(importRefSelectorKey(ambiguity.selector))
    return (
      selection !== undefined &&
      ambiguity.candidates.some(
        (candidate) =>
          candidate.id === selection.resourceId &&
          candidate.aclRevision === selection.expectedAclRevision,
      )
    )
  })
}
