// RFC-257 UI 修订 — webhook 配置单页：侧栏「运行与仓库」组（远端仓下方），
// 三 tab（端点 / 触发器 / 投递审计），骨架与 tab 语义照抄 /repos（TabBar +
// search param + 无效值归一化）。RFC-260/RFC-283/RFC-305：页面按读取权限可见；
// 端点与重放按具体管理权限渲染，触发规则按 method permission + owner/override 判定。
// 真正边界在后端方法门与 URL 明文的响应分层。
import { createRoute, redirect } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { TabPanels } from '@/components/split/TabPanels'
import { TabBar } from '@/components/TabBar'
import { WebhookEndpointCard } from '@/components/WebhookEndpointCard'
import { DeliveriesPanel } from '@/components/webhooks/DeliveriesPanel'
import { TriggersPanel } from '@/components/webhooks/TriggersPanel'
import { useActor, usePermission } from '@/hooks/useActor'
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
  beforeLoad: ({ search }) => {
    const tab = isWebhooksTab(search.tab) ? search.tab : 'endpoints'
    throw redirect({
      to: '/events',
      search: {
        tab:
          tab === 'endpoints'
            ? ('sources' as const)
            : tab === 'triggers'
              ? ('subscriptions' as const)
              : ('deliveries' as const),
      },
      replace: true,
    })
  },
  component: WebhooksPage,
})

function WebhooksPage() {
  const { t } = useTranslation()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tab: WebhooksTab = search.tab ?? 'endpoints'
  const selectTab = (next: WebhooksTab) =>
    void navigate({ search: (previous) => ({ ...previous, tab: next }) })

  return (
    <div className="page page--operations webhooks-page">
      <div className="operations-surface">
        <PageHeader title={t('webhooksPage.title')} className="operations-surface__header">
          <p className="operations-surface__subtitle">{t('webhooksPage.subtitle')}</p>
        </PageHeader>
        <WebhookManagement active={tab} onSelect={selectTab} />
      </div>
    </div>
  )
}

/**
 * Webhook is a push-based source family inside the global Event Center. The
 * existing endpoint, routing-rule, and delivery implementations remain shared
 * here while `/webhooks` is only a compatibility redirect.
 */
export function WebhookManagement({
  active,
  onSelect,
}: {
  active: WebhooksTab
  onSelect: (tab: WebhooksTab) => void
}) {
  const { t } = useTranslation()
  const actor = useActor()
  const canManageEndpoints = usePermission('webhook-endpoints:manage')

  if (actor.isLoading) return <LoadingState data-testid="webhooks-loading" />

  return (
    <div className="webhook-event-source" data-testid="event-center-webhooks">
      <TabBar<WebhooksTab>
        active={active}
        onSelect={onSelect}
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
            label: <span className="repo-kind-tabs__label">{t('webhooksPage.tabs.triggers')}</span>,
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
        active={active}
        idPrefix="webhooks"
        panels={[
          {
            key: 'endpoints',
            testid: 'webhooks-panel-endpoints',
            content: <WebhookEndpointCard canManage={canManageEndpoints} />,
          },
          {
            key: 'triggers',
            testid: 'webhooks-panel-triggers',
            content: <TriggersPanel />,
          },
          {
            key: 'deliveries',
            testid: 'webhooks-panel-deliveries',
            content: <DeliveriesPanel canReplay={canManageEndpoints} />,
          },
        ]}
      />
    </div>
  )
}
