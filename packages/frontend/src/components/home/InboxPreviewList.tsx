// RFC-061 PR-C: inbox preview temporarily stubbed pending suspensions-projection
// rebuild. The list always renders empty; PR-C T16+T17 will rewire it to
// `/api/suspensions?status=open` once the new endpoint lands.

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'

export const REVIEWS_HOMEPAGE_QUERY_KEY = ['reviews', 'homepage', 'pending'] as const
export const CLARIFY_HOMEPAGE_QUERY_KEY = ['clarify', 'homepage', 'pending'] as const

interface InboxPreviewListProps {
  onCount?: (n: number) => void
}

export function InboxPreviewList({ onCount }: InboxPreviewListProps) {
  const { t } = useTranslation()
  useEffect(() => {
    onCount?.(0)
  }, [onCount])
  return (
    <EmptyState
      size="compact"
      title={t('home.section.empty.inbox')}
      data-testid="inbox-preview-empty"
    />
  )
}
