import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { NoticeBanner } from '@/components/NoticeBanner'
import { ExecutionStatusContext } from '@/hooks/useExecutionAvailability'

/** RFC-370 v2 H7: only a CrewStation-hosted instance without execution shows this. */
export function ExecutionStandbyBanner() {
  const status = useContext(ExecutionStatusContext)
  const { t, i18n } = useTranslation()
  if (status === undefined || status.state === 'active') return null
  const reasonKey = `execution.reasons.${status.reason ?? ''}`
  const description =
    status.reason !== null && i18n.exists(reasonKey)
      ? t(reasonKey)
      : t(`execution.${status.state}Description`)
  return (
    <NoticeBanner tone="warning" title={t(`execution.${status.state}`)} testid="execution-status">
      {description}
    </NoticeBanner>
  )
}
