import { useQuery } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import type { EmployeeTypePackage, LocalizedText } from '@/components/digital-employees/types'
import { localized, typeRefKey } from '@/components/digital-employees/types'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { Route as RootRoute } from './__root'

interface DigitalEmployeesSearch extends Record<string, unknown> {
  view?: 'events'
}

function validateSearch(raw: Record<string, unknown>): DigitalEmployeesSearch {
  return raw.view === 'events' ? { view: 'events' } : {}
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/digital-employees',
  validateSearch,
  component: DigitalEmployeesPage,
})

function DigitalEmployeesPage(): ReactElement {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const search = Route.useSearch()
  const view = search.view ?? 'types'
  const navigate = Route.useNavigate()
  const query = useQuery<{ items: EmployeeTypePackage[] }>({
    queryKey: ['digital-employee-types'],
    queryFn: ({ signal }) => api.get('/api/digital-employee-types', undefined, signal),
    enabled: view === 'types',
  })
  const zh = language.startsWith('zh')
  const panelIds = tabDomIds('digital-employees-sections', view)

  return (
    <div className="page page--operations digital-employees-page">
      <div className="operations-surface">
        <PageHeader
          className="operations-surface__header"
          title={zh ? '数字员工' : 'Digital employees'}
          actions={
            <Link to="/tasks/employee-cases/new" className="btn btn--primary">
              {zh ? '交给数字员工' : 'Assign work'}
            </Link>
          }
        >
          <p className="operations-surface__subtitle">
            {zh
              ? '先选择员工分类，再在固定职责图上配置每个工作项使用的工具。运行统一进入任务列表。'
              : 'Choose an employee type, then configure each work item on its fixed responsibility map. Runs stay in the unified task list.'}
          </p>
        </PageHeader>

        <TabBar
          active={view}
          onSelect={(next) =>
            void navigate({ search: next === 'events' ? { view: 'events' } : {}, replace: true })
          }
          ariaLabel={zh ? '数字员工平台' : 'Digital employee platform'}
          idPrefix="digital-employees-sections"
          variant="segment"
          tabs={[
            { key: 'types', label: zh ? '员工分类' : 'Employee types' },
            { key: 'events', label: zh ? '事件中心' : 'Event Center' },
          ]}
        />

        <div role="tabpanel" id={panelIds.panelId} aria-labelledby={panelIds.tabId} tabIndex={0}>
          {view === 'events' ? (
            <EventCenterPanel language={language} />
          ) : (
            <>
              {query.isPending ? <LoadingState /> : null}
              {query.isError ? <ErrorBanner error={query.error} /> : null}
              {query.data?.items.length === 0 ? (
                <EmptyState
                  title={zh ? '还没有员工分类' : 'No employee types'}
                  description={
                    zh
                      ? '员工分类由程序化类型包注册。'
                      : 'Employee types are registered by programmable type packages.'
                  }
                />
              ) : null}
              <div className="employee-type-grid" data-testid="digital-employee-type-list">
                {query.data?.items.map((type) => (
                  <Link
                    key={typeRefKey(type.typeRef)}
                    to="/digital-employees/$typeRef"
                    params={{ typeRef: typeRefKey(type.typeRef) }}
                    search={{ view: 'employees' }}
                    className="employee-type-card"
                    data-testid={`digital-employee-type-${type.typeRef.typeId}`}
                  >
                    <span className="employee-type-card__eyebrow">
                      {zh ? '数字员工分类' : 'Employee type'}
                    </span>
                    <strong>{localized(type.displayName, language)}</strong>
                    <p>{localized(type.description, language)}</p>
                    <dl>
                      <div>
                        <dt>{zh ? '职责' : 'Work items'}</dt>
                        <dd>{type.authoringManifest.workItems.length}</dd>
                      </div>
                      <div>
                        <dt>{zh ? '生命周期' : 'Lifecycle regions'}</dt>
                        <dd>{type.authoringManifest.lifecycleRegions.length}</dd>
                      </div>
                    </dl>
                    <span className="employee-type-card__open">
                      {zh ? '进入配置' : 'Configure'} →
                    </span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface EventCatalog {
  sources: Array<{
    sourceRef: { id: string; revision: number }
    displayName: LocalizedText
    description: LocalizedText
    observationMode: 'passive' | 'active' | 'hybrid'
    pollIntervalMs: number
  }>
  eventTypes: Array<{
    eventTypeRef: { id: string; revision: number }
    sourceRef: { id: string; revision: number }
    displayName: LocalizedText
    description: LocalizedText
    priority: number
  }>
}

interface EventSubscription {
  id: string
  eventTypeRef: { id: string; revision: number }
  subject: { typeId: string; subjectRef: string }
  subscriber: { kind: 'employee-case' | 'employee-invocation' | 'system'; subscriberRef: string }
  state: 'active' | 'cancelled'
}

interface ObserverHealth {
  sourceRef: { id: string; revision: number }
  subscriberCount: number
  state: 'idle' | 'active' | 'draining' | 'blocked'
  nextScanAt: number | null
  lastSuccessAt: number | null
  lastErrorCode: string | null
}

function sameRef(
  left: { id: string; revision: number },
  right: { id: string; revision: number },
): boolean {
  return left.id === right.id && left.revision === right.revision
}

function EventCenterPanel({ language }: { language: string }): ReactElement {
  const zh = language.startsWith('zh')
  const catalog = useQuery<EventCatalog>({
    queryKey: ['event-center', 'catalog'],
    queryFn: ({ signal }) => api.get('/api/event-center/catalog', undefined, signal),
  })
  const subscriptions = useQuery<EventSubscription[]>({
    queryKey: ['event-center', 'subscriptions'],
    queryFn: ({ signal }) => api.get('/api/event-center/subscriptions', undefined, signal),
    refetchInterval: 5_000,
  })
  const observers = useQuery<{ items: ObserverHealth[] }>({
    queryKey: ['event-center', 'observers'],
    queryFn: ({ signal }) => api.get('/api/event-center/observers', undefined, signal),
    refetchInterval: 5_000,
  })
  if (catalog.isPending || subscriptions.isPending || observers.isPending) return <LoadingState />
  if (catalog.isError) return <ErrorBanner error={catalog.error} />
  if (subscriptions.isError) return <ErrorBanner error={subscriptions.error} />
  if (observers.isError) return <ErrorBanner error={observers.error} />

  const eventName = (ref: { id: string; revision: number }): string => {
    const event = catalog.data.eventTypes.find((candidate) => sameRef(candidate.eventTypeRef, ref))
    return event === undefined ? ref.id : localized(event.displayName, language)
  }

  return (
    <div className="event-center-panel" data-testid="event-center-panel">
      <NoticeBanner
        tone="info"
        title={
          zh ? '订阅驱动观察器，不需要人工启停' : 'Subscriptions drive observers automatically'
        }
      >
        {zh
          ? '第一个订阅出现时启动主动轮询；最后一个订阅取消后停止。事件统一去重，再送入每个数字员工自己的优先队列。'
          : 'The first subscription starts active polling and the last cancellation stops it. Events are deduplicated before entering each employee queue.'}
      </NoticeBanner>

      <div className="event-center-summary">
        <Card title={zh ? '事件种类' : 'Event types'}>
          <strong>{catalog.data.eventTypes.length}</strong>
        </Card>
        <Card title={zh ? '有效订阅' : 'Active subscriptions'}>
          <strong>{subscriptions.data.filter((item) => item.state === 'active').length}</strong>
        </Card>
        <Card title={zh ? '运行中的观察器' : 'Running observers'}>
          <strong>{observers.data.items.filter((item) => item.state === 'active').length}</strong>
        </Card>
      </div>

      <section className="employee-node-panel">
        <header>
          <div>
            <span className="employee-node-panel__eyebrow">
              {zh ? '事件目录' : 'Event catalog'}
            </span>
            <h2>{zh ? '数字员工能关注什么' : 'What employees can watch'}</h2>
            <p>
              {zh
                ? '业务名称是主信息，程序标识只作为辅助信息显示。'
                : 'Business names lead; machine identifiers are secondary.'}
            </p>
          </div>
        </header>
        <div className="node-tool-list">
          {[...catalog.data.eventTypes]
            .sort((left, right) => right.priority - left.priority)
            .map((event) => (
              <article
                key={`${event.eventTypeRef.id}@${event.eventTypeRef.revision}`}
                className="node-tool-row"
              >
                <div>
                  <strong>{localized(event.displayName, language)}</strong>
                  <span>{localized(event.description, language)}</span>
                  <small>{event.eventTypeRef.id}</small>
                </div>
                <StatusChip kind="info">
                  {zh ? `优先级 ${event.priority}` : `Priority ${event.priority}`}
                </StatusChip>
              </article>
            ))}
        </div>
      </section>

      <div className="employee-case-detail-grid">
        <section className="employee-node-panel">
          <header>
            <div>
              <span className="employee-node-panel__eyebrow">{zh ? '观察器' : 'Observers'}</span>
              <h2>{zh ? '主动轮询状态' : 'Active polling status'}</h2>
            </div>
          </header>
          <div className="node-tool-list">
            {catalog.data.sources.map((source) => {
              const health = observers.data.items.find((item) =>
                sameRef(item.sourceRef, source.sourceRef),
              )
              const mode =
                source.observationMode === 'active'
                  ? zh
                    ? '主动轮询'
                    : 'Active polling'
                  : source.observationMode === 'passive'
                    ? zh
                      ? '被动推送'
                      : 'Passive delivery'
                    : zh
                      ? '推送 + 轮询'
                      : 'Hybrid'
              return (
                <article
                  key={`${source.sourceRef.id}@${source.sourceRef.revision}`}
                  className="node-tool-row"
                >
                  <div>
                    <strong>{localized(source.displayName, language)}</strong>
                    <span>{localized(source.description, language)}</span>
                    <small>
                      {mode} · {health?.subscriberCount ?? 0} {zh ? '个订阅' : 'subscriptions'}
                    </small>
                    {health?.lastErrorCode ? <small>{health.lastErrorCode}</small> : null}
                  </div>
                  <StatusChip
                    kind={
                      health?.state === 'active'
                        ? 'success'
                        : health?.state === 'blocked'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {health?.state === 'active'
                      ? zh
                        ? '运行中'
                        : 'Running'
                      : health?.state === 'blocked'
                        ? zh
                          ? '异常'
                          : 'Blocked'
                        : zh
                          ? '按需停止'
                          : 'Stopped on demand'}
                  </StatusChip>
                </article>
              )
            })}
          </div>
        </section>

        <section className="employee-node-panel">
          <header>
            <div>
              <span className="employee-node-panel__eyebrow">
                {zh ? '实时订阅' : 'Live subscriptions'}
              </span>
              <h2>{zh ? '谁在等待什么' : 'Who is waiting for what'}</h2>
            </div>
          </header>
          <div className="node-tool-list">
            {subscriptions.data.filter((item) => item.state === 'active').length === 0 ? (
              <p className="node-tool-list__empty">
                {zh ? '当前没有有效订阅。' : 'No active subscriptions.'}
              </p>
            ) : (
              subscriptions.data
                .filter((item) => item.state === 'active')
                .map((subscription) => (
                  <article key={subscription.id} className="node-tool-row">
                    <div>
                      <strong>{eventName(subscription.eventTypeRef)}</strong>
                      <span>{subscription.subject.subjectRef}</span>
                    </div>
                    {subscription.subscriber.kind === 'employee-case' ? (
                      <Link
                        to="/tasks/employee-cases/$caseId"
                        params={{ caseId: subscription.subscriber.subscriberRef }}
                        className="btn btn--sm"
                      >
                        {zh ? '查看任务' : 'View task'}
                      </Link>
                    ) : (
                      <StatusChip kind="neutral">{subscription.subscriber.kind}</StatusChip>
                    )}
                  </article>
                ))
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
