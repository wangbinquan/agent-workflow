import { useQuery } from '@tanstack/react-query'
import { SessionViewResponseSchema } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { ConversationFlow } from './ConversationFlow'

export interface SessionConversationPanelProps {
  queryKey: readonly unknown[]
  load: (signal: AbortSignal) => Promise<unknown>
  pollMs?: number | false
  refetchOnMount?: boolean | 'always'
  className?: string
}

/**
 * Shared query/contract/loading shell for every SessionTree consumer. Business
 * identifiers remain in the caller's loader; this component owns only the
 * strict response parse and the canonical ConversationFlow renderer.
 */
export function SessionConversationPanel(props: SessionConversationPanelProps) {
  const { t } = useTranslation()
  const query = useQuery<unknown>({
    queryKey: props.queryKey,
    queryFn: ({ signal }) => props.load(signal),
    refetchInterval: props.pollMs ?? false,
    refetchOnMount: props.refetchOnMount,
  })
  if (query.isLoading) return <LoadingState size="compact" />
  if (query.error !== null && query.error !== undefined) {
    return <ErrorBanner error={query.error} message={t('session.loadError')} />
  }
  const parsed = SessionViewResponseSchema.safeParse(query.data)
  if (!parsed.success) {
    return <ErrorBanner error={null} message={t('session.loadError')} />
  }
  return (
    <div className={props.className}>
      <ConversationFlow tree={parsed.data.tree} />
    </div>
  )
}
