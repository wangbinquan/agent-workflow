// RFC-257 UI 修订 — webhook 配置单页：侧栏「运行与仓库」组（远端仓下方），
// 三 tab（端点 / 触发器 / 投递审计），骨架与 tab 语义照抄 /repos（TabBar +
// search param + 无效值归一化）。RFC-260：**读全员、写 admin**——页面对全部
// 角色可见（只读视图），配置动作按 isAdmin 渲染；真正的边界在后端方法门与
// URL 明文的响应分层（非 admin 的响应里就没有 urlToken 明文）。
import { createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { TabPanels } from '@/components/split/TabPanels'
import { TabBar } from '@/components/TabBar'
import { WebhookEndpointCard } from '@/components/WebhookEndpointCard'
import { DeliveriesPanel } from '@/components/webhooks/DeliveriesPanel'
import { TriggersPanel } from '@/components/webhooks/TriggersPanel'
import { useActor, useIsAdmin } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

export type WebhooksTab = 'endpoints' | 'triggers' | 'deliveries'

interface WebhooksSearch extends Record<string, unknown> {
  tab?: WebhooksTab
}

function isWebhooksTab(value: unknown): value is WebhooksTab {
  return value === 'endpoints' || value === 'triggers' || value === 'deliveries'
}

export function validateWebhooksSearch(search: Record<string, unknown>): WebhooksSearch {
  const { tab: _tab, ...adjacent } = search
  return isWebhooksTab(search.tab) ? { ...adjacent, tab: search.tab } : adjacent
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/webhooks',
  validateSearch: validateWebhooksSearch,
  component: WebhooksPage,
})

function WebhooksPage() {
  const { t } = useTranslation()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const actor = useActor()
  const isAdmin = useIsAdmin()
  const tab: WebhooksTab = search.tab ?? 'endpoints'

  // RFC-260：页面全员可见。加载中给 Loading；isAdmin 决定配置动作是否渲染
  //（后端方法门与 URL 响应分层才是真正边界，这里只是 UX）。
  if (actor.isLoading) {
    return (
      <div className="page page--operations webhooks-page">
        <LoadingState data-testid="webhooks-loading" />
      </div>
    )
  }
  const selectTab = (next: WebhooksTab) =>
    void navigate({ search: (previous) => ({ ...previous, tab: next }) })

  return (
    <div className="page page--operations webhooks-page">
      <div className="operations-surface">
        <PageHeader title={t('webhooksPage.title')} className="operations-surface__header">
          <p className="operations-surface__subtitle">{t('webhooksPage.subtitle')}</p>
        </PageHeader>

        <TabBar<WebhooksTab>
          active={tab}
          onSelect={selectTab}
          ariaLabel={t('webhooksPage.tabAria')}
          idPrefix="webhooks"
          rootTestid="webhooks-tab"
          className="repo-kind-tabs"
          tabs={[
            {
              key: 'endpoints',
              testid: 'webhooks-tab-endpoints',
              label: (
                <span className="repo-kind-tabs__label">{t('webhooksPage.tabs.endpoints')}</span>
              ),
            },
            {
              key: 'triggers',
              testid: 'webhooks-tab-triggers',
              label: (
                <span className="repo-kind-tabs__label">{t('webhooksPage.tabs.triggers')}</span>
              ),
            },
            {
              key: 'deliveries',
              testid: 'webhooks-tab-deliveries',
              label: (
                <span className="repo-kind-tabs__label">{t('webhooksPage.tabs.deliveries')}</span>
              ),
            },
          ]}
        />

        <TabPanels<WebhooksTab>
          active={tab}
          idPrefix="webhooks"
          panels={[
            {
              key: 'endpoints',
              testid: 'webhooks-panel-endpoints',
              content: <WebhookEndpointCard isAdmin={isAdmin} />,
            },
            {
              key: 'triggers',
              testid: 'webhooks-panel-triggers',
              content: <TriggersPanel isAdmin={isAdmin} />,
            },
            {
              key: 'deliveries',
              testid: 'webhooks-panel-deliveries',
              content: <DeliveriesPanel isAdmin={isAdmin} />,
            },
          ]}
        />
      </div>
    </div>
  )
}
