// RFC-247 D17 — the API & MCP wiki page.
//
// Everything on it comes from `GET /api/docs/api`, which the daemon generates
// from its live route registry and tool registry. Nothing is written here, so
// the page cannot drift from the platform it documents — which is the failure
// mode every hand-maintained API doc eventually reaches.
//
// Rendering goes through the shared `Prose` component: one markdown path in the
// app (AC-27), so a code block here looks like a code block everywhere else.

import { useQuery } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { Prose } from '@/components/prose/Prose'
import { QueryState } from '@/components/QueryState'
import { buildApiDocsMarkdown, type ApiDocsPayload } from '@/lib/api-docs-markdown'
import { Route as RootRoute } from './__root'

export const DocsApiRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/docs/api',
  component: DocsApiPage,
})

function DocsApiPage() {
  const { t } = useTranslation()
  const docs = useQuery<ApiDocsPayload>({
    queryKey: ['docs', 'api'],
    queryFn: ({ signal }) => api.get('/api/docs/api', undefined, signal),
  })

  return (
    <div className="page">
      <PageHeader title={t('apiDocs.title')}>
        <p className="page__description">{t('apiDocs.subtitle')}</p>
      </PageHeader>
      <QueryState
        query={docs}
        data={docs.data}
        isEmpty={(data) => data === undefined}
        keepDataOnError
      >
        {(payload) =>
          payload === undefined ? null : (
            <Prose
              className="api-docs-prose"
              body={buildApiDocsMarkdown(payload, {
                intro: t('apiDocs.intro'),
                quickStart: t('apiDocs.quickStart'),
                quickStartBody: t('apiDocs.quickStartBody'),
                connecting: t('apiDocs.connecting'),
                toolsHeading: t('apiDocs.toolsHeading'),
                toolsIntro: t('apiDocs.toolsIntro'),
                restHeading: t('apiDocs.restHeading'),
                restIntro: t('apiDocs.restIntro'),
                permissionsHeading: t('apiDocs.permissionsHeading'),
                permissionsIntro: t('apiDocs.permissionsIntro'),
                alwaysGrantedHeading: t('apiDocs.alwaysGrantedHeading'),
                alwaysGrantedIntro: t('apiDocs.alwaysGrantedIntro'),
                resourcesHeading: t('apiDocs.resourcesHeading'),
                resourcesIntro: t('apiDocs.resourcesIntro'),
                colTool: t('apiDocs.colTool'),
                colNeeds: t('apiDocs.colNeeds'),
                colDescription: t('apiDocs.colDescription'),
                colMethod: t('apiDocs.colMethod'),
                colPath: t('apiDocs.colPath'),
                colSummary: t('apiDocs.colSummary'),
                colOperation: t('apiDocs.colOperation'),
                colPermission: t('apiDocs.colPermission'),
                needsNothing: t('apiDocs.needsNothing'),
                notAvailableToYou: t('apiDocs.notAvailableToYou'),
                adminOnly: t('apiDocs.adminOnly'),
                resourceAdminOnly: t('apiDocs.resourceAdminOnly'),
              })}
            />
          )
        }
      </QueryState>
    </div>
  )
}
