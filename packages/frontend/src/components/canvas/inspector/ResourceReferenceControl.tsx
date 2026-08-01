import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

type ResourceReferenceKind = 'agent' | 'workflow' | 'workgroup'

interface ResourceReferenceControlProps {
  children: ReactNode
  kind: ResourceReferenceKind
  resourceId?: string
  resourceName?: string
  resourceLabel: string
  testId: string
}

/** Picker + stable-id detail link shared by resource-backed node inspectors. */
export function ResourceReferenceControl({
  children,
  kind,
  resourceId,
  resourceName,
  resourceLabel,
  testId,
}: ResourceReferenceControlProps) {
  const { t } = useTranslation()
  const resolved =
    typeof resourceId === 'string' &&
    resourceId.length > 0 &&
    typeof resourceName === 'string' &&
    resourceName.length > 0
  const accessibleLabel = resolved
    ? t('inspector.openReferencedResourceAria', {
        resource: resourceLabel,
        name: resourceName,
      })
    : ''
  const href = resolved
    ? `/${kind === 'agent' ? 'agents' : kind === 'workflow' ? 'workflows' : 'workgroups'}/${encodeURIComponent(resourceId)}`
    : ''
  const linkContents = (
    <>
      {t('inspector.openReferencedResource')}
      <span aria-hidden="true">↗</span>
    </>
  )

  return (
    <div className="inspector__resource-reference">
      <div className="inspector__resource-reference-picker">{children}</div>
      {resolved ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="btn btn--sm btn--ghost inspector__resource-reference-link"
          aria-label={accessibleLabel}
          title={accessibleLabel}
          data-testid={testId}
        >
          {linkContents}
        </a>
      ) : null}
    </div>
  )
}
