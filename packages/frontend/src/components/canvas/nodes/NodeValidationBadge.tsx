import { useTranslation } from 'react-i18next'
import type { CanvasNodeData } from './types'

export function NodeValidationBadge({ data }: { data: CanvasNodeData }) {
  const { t } = useTranslation()
  if (data.surface !== 'editor') return null
  const counts = data.validation
  if (counts === undefined || (counts.errors === 0 && counts.warnings === 0)) return null
  const label = [
    ...(counts.errors > 0 ? [t('editor.validationBadgeErrors', { n: counts.errors })] : []),
    ...(counts.warnings > 0 ? [t('editor.validationBadgeWarnings', { n: counts.warnings })] : []),
  ].join(', ')
  return (
    <div className="canvas-node__validation" aria-label={label} title={label}>
      {counts.errors > 0 ? (
        <span className="canvas-node__validation-error">! {counts.errors}</span>
      ) : null}
      {counts.warnings > 0 ? (
        <span className="canvas-node__validation-warning">⚠ {counts.warnings}</span>
      ) : null}
    </div>
  )
}
