// RFC-257 UI 修订 — webhook 配置单页：侧栏「运行与仓库」组（远端仓下方），
// 三 tab（端点 / 触发器 / 投递审计），骨架与 tab 语义照抄 /repos（TabBar +
// search param + 无效值归一化）。**仅 admin**：侧栏项 adminOnly 过滤 +
// 本页对非 admin 渲染拒绝态（直输 URL 的兜底）。
import { createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { TabBar } from '@/components/TabBar'
import { WebhookEndpointCard } from '@/components/WebhookEndpointCard'
import { DeliveriesPanel } from '@/components/webhooks/DeliveriesPanel'
import { TriggersPanel } from '@/components/webhooks/TriggersPanel'
import { useActor } from '@/hooks/useActor'
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
  const tab: WebhooksTab = search.tab ?? 'endpoints'

  // admin 守卫（AC：非 admin 不可见）。加载中给 Loading；已加载非 admin 给
  // 拒绝态——不渲染任何配置数据（API 层权限点是真正的边界，这里是 UX 兜底）。
  if (actor.isLoading) {
    return (
      <div className="page page--operations webhooks-page">
        <LoadingState data-testid="webhooks-loading" />
      </div>
    )
  }
  if (actor.data?.user.role !== 'admin') {
    return (
      <div className="page page--operations webhooks-page">
        <EmptyState
          title={t('webhooksPage.forbiddenTitle')}
          description={t('webhooksPage.forbiddenDescription')}
          data-testid="webhooks-forbidden"
        />
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

        {tab === 'endpoints' && <WebhookEndpointCard />}
        {tab === 'triggers' && <TriggersPanel />}
        {tab === 'deliveries' && <DeliveriesPanel />}
      </div>
    </div>
  )
}
