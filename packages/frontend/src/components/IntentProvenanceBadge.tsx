// RFC-234 (T11, AC-11) — resource-side provenance annotation.
//
// Renders nothing unless the intent-provenance read returns rows: the server
// scopes rows to session viewers (creator/system admin), so for everyone else
// the badge is simply absent — no "someone intent-built this" leak in the DOM.
// Clicking jumps to the originating session (Round-7 decision: 留在会话+资源链接).

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { ReactElement } from 'react'
import type { IntentProvenanceEntry, IntentResourceType } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { StatusChip } from '@/components/StatusChip'

export interface IntentProvenanceBadgeProps {
  resourceType: IntentResourceType
  resourceId: string
}

export function IntentProvenanceBadge(props: IntentProvenanceBadgeProps): ReactElement | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const query = useQuery({
    queryKey: ['intent-provenance', props.resourceType, props.resourceId],
    queryFn: () =>
      api.get<IntentProvenanceEntry[]>(
        `/api/intent-provenance/${props.resourceType}/${props.resourceId}`,
      ),
    staleTime: 60_000,
  })
  const latest = query.data?.[0]
  if (latest === undefined) return null
  return (
    <StatusChip
      kind="info"
      size="sm"
      data-testid="intent-provenance-badge"
      title={latest.sessionTitle}
      onClick={() =>
        void navigate({ to: '/intent/$sessionId', params: { sessionId: latest.sessionId } })
      }
    >
      {t('intent.provenanceBadge')}
    </StatusChip>
  )
}
