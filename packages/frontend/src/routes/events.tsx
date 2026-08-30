import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { Fragment, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import type { LocalizedText } from '@/components/digital-employees/types'
import { localized } from '@/components/digital-employees/types'
import { Card } from '@/components/Card'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, NumberInput, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Pagination } from '@/components/Pagination'
import { PageHeader } from '@/components/PageHeader'
import { FilterBar, FilterField } from '@/components/FilterBar'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { TableViewport } from '@/components/TableViewport'
import { WebhookEndpointCard } from '@/components/WebhookEndpointCard'
import { OperationsExpandButton } from '@/components/operations/OperationsExpandButton'
import { DeliveriesPanel } from '@/components/webhooks/DeliveriesPanel'
import { TriggersPanel } from '@/components/webhooks/TriggersPanel'
import { EventResponseRulesPanel } from '@/components/events/EventResponseRulesPanel'
import { useActor, usePermission } from '@/hooks/useActor'
import {
  customEventObserverStarter,
  syncManagedObserverSource,
  type CustomObserverLanguage,
} from '@/lib/events/customEventObserverTemplate'
import { Route as RootRoute } from './__root'

export type EventCenterTab = 'overview' | 'sources' | 'subscriptions' | 'deliveries'

interface EventsSearch extends Record<string, unknown> {
  tab?: EventCenterTab
}

function isEventCenterTab(value: unknown): value is EventCenterTab {
  return (
    value === 'overview' ||
    value === 'sources' ||
    value === 'subscriptions' ||
    value === 'deliveries'
  )
}

export function validateEventsSearch(search: Record<string, unknown>): EventsSearch {
  const { tab: _tab, webhookTab: _legacyWebhookTab, ...adjacent } = search
  return {
    ...adjacent,
    ...(isEventCenterTab(search.tab) ? { tab: search.tab } : {}),
  }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/events',
  validateSearch: validateEventsSearch,
  component: EventsPage,
})

type ExactRef = { id: string; revision: number }

interface EventPage<T> {
  items: T[]
  total: number
  page: number
  pageCount: number
}

interface EventCatalog {
  sources: Array<{
    sourceRef: ExactRef
    displayName: LocalizedText
    description: LocalizedText
    observationMode: 'passive' | 'active' | 'hybrid'
    pollIntervalMs: number
    subscriptionCount: number
  }>
  eventTypes: Array<{
    eventTypeRef: ExactRef
    sourceRef: ExactRef
    subjectTypeId: string
    displayName: LocalizedText
    description: LocalizedText
    triggerParameters: {
      namespace: string
      fields: Array<{
        fieldId: string
        displayName: LocalizedText
        description: LocalizedText
      }>
    } | null
  }>
}

interface ExactEventSubscription {
  id: string
  mode: 'exact'
  eventTypeRef: ExactRef
  sourceRef: ExactRef
  subject: { typeId: string; subjectRef: string }
  subscriber: {
    kind: 'employee-case' | 'employee-invocation' | 'automation' | 'system'
    subscriberRef: string
  }
  state: 'active' | 'cancelled'
  createdAt: number
  updatedAt: number
}

interface FilteredEventSubscription {
  id: string
  mode: 'filtered'
  sourceRef: ExactRef
  eventTypeRefs: ExactRef[]
  subjectTypeId: string
  subscriber: {
    kind: 'employee-case' | 'employee-invocation' | 'automation' | 'system'
    subscriberRef: string
  }
  displayName: LocalizedText
  selector: { kind: string; config: unknown }
  state: 'active' | 'paused' | 'invalid'
  createdAt: number
  updatedAt: number
}

type EventSubscription = ExactEventSubscription | FilteredEventSubscription

interface EventDeliveryStatus {
  deliveryId: string
  eventId: string
  subscriptionId: string
  subscriber: EventSubscription['subscriber']
  eventTypeRef: ExactRef
  subject: { typeId: string; subjectRef: string }
  state: 'pending' | 'claimed' | 'accepted' | 'dead-letter'
  attemptCount: number
  nextAttemptAt: number
  lastError: string | null
  createdAt: number
}

interface CommittedEventDeliveryStatus {
  eventId: string
  stage: 'producer-publication' | 'consumer-delivery'
  producer: 'task-execution' | 'collaboration'
  family: 'task-lifecycle' | 'review' | 'clarify' | 'questions'
  eventType: string
  aggregateKind: 'task' | 'review-round' | 'clarify-round' | 'question-gate'
  aggregateId: string
  aggregateSeq: number
  consumerId: string
  mode: 'shadow' | 'dispatchable'
  state: 'pending' | 'claimed' | 'accepted' | 'dead-letter'
  attemptCount: number
  nextAttemptAt: string | null
  leaseEpoch: number
  lastErrorSummary: string | null
  updatedAt: string
  canRetry: boolean
}

interface EventRecordAudit {
  eventId: string
  eventTypeRef: ExactRef
  sourceRef: ExactRef
  subject: { typeId: string; subjectRef: string }
  occurredAt: number
  observedAt: number
  summary: string
  payloadArtifactRef: string | null
}

type SubscriptionView = 'rules' | 'audit'
type DeliveryView = 'consumer' | 'committed' | 'source' | 'webhook'
type DeliveryStateFilter = 'all' | EventDeliveryStatus['state']
type CommittedDeliveryStageFilter = 'all' | CommittedEventDeliveryStatus['stage']
type CommittedDeliveryFamilyFilter = 'all' | CommittedEventDeliveryStatus['family']
const EVENT_AUDIT_PAGE_SIZE = 50

type EventAuditDeliveryState = EventDeliveryStatus['state']

function eventAuditStateKind(
  state: EventAuditDeliveryState,
): 'success' | 'danger' | 'warn' | 'neutral' {
  if (state === 'accepted') return 'success'
  if (state === 'dead-letter') return 'danger'
  if (state === 'claimed') return 'warn'
  return 'neutral'
}

function eventAuditStateLabel(
  state: EventAuditDeliveryState,
  zh: boolean,
  deadLetterLabel: 'failed' | 'dead-letter',
): string {
  if (state === 'accepted') return zh ? '已确认' : 'Accepted'
  if (state === 'claimed') return zh ? '处理中' : 'Processing'
  if (state === 'dead-letter') {
    if (deadLetterLabel === 'dead-letter') return zh ? '死信' : 'Dead letter'
    return zh ? '处理失败' : 'Failed'
  }
  return zh ? '待处理' : 'Pending'
}

interface ObserverHealth {
  sourceRef: ExactRef
  subscriberCount: number
  state: 'idle' | 'active' | 'draining' | 'blocked'
  nextScanAt: number | null
  lastSuccessAt: number | null
  lastErrorCode: string | null
}

interface CustomSourceSummary {
  id: string
  displayName: LocalizedText
  description: LocalizedText
  pollIntervalMs: number
  batchSize: number
  ingestionMode: 'state-change' | 'occurrence'
  eventTypeCount: number
  publishedRevision: number | null
  state: 'draft' | 'changed' | 'published' | 'retired'
  updatedAt: number
}

interface CustomEventTypeDraft {
  eventKey: string
  subjectTypeId: string
  payloadSchemaId: string
  displayName: LocalizedText
  description: LocalizedText
  deliveryClass: string
  triggerParameters: {
    namespace: string
    fields: CustomTriggerFieldDraft[]
  } | null
  fixtureSubjectRef: string
}

interface CustomTriggerFieldDraft {
  editorKey: string
  fieldId: string
  displayName: LocalizedText
  description: LocalizedText
}

type CustomEventTypePayload = Omit<
  CustomEventTypeDraft,
  'fixtureSubjectRef' | 'triggerParameters'
> & {
  triggerParameters: {
    namespace: string
    fields: Array<Omit<CustomTriggerFieldDraft, 'editorKey'>>
  } | null
}

interface CustomSourceDraft {
  schemaVersion: 1
  displayName: LocalizedText
  description: LocalizedText
  pollIntervalMs: number
  batchSize: number
  ingestionMode: 'state-change' | 'occurrence'
  program: {
    language: CustomObserverLanguage
    source: string
    templateManaged?: boolean
    timeoutMs: number
  }
  eventTypes: CustomEventTypePayload[]
  fixture: {
    subjects: Array<{ typeId: string; subjectRef: string }>
    cursorJson: string | null
  }
}

interface CustomSourceAuthoring {
  id: string
  draft: CustomSourceDraft
  publishedRevision: number | null
  retiredAt: number | null
}

function sameRef(left: ExactRef, right: ExactRef): boolean {
  return left.id === right.id && left.revision === right.revision
}

function initialEvent(eventKey = 'status.changed'): CustomEventTypeDraft {
  return {
    eventKey,
    subjectTypeId: 'work.item',
    payloadSchemaId: 'event.summary',
    displayName: { 'zh-CN': '', 'en-US': '' },
    description: { 'zh-CN': '', 'en-US': '' },
    deliveryClass: 'work.status',
    triggerParameters: null,
    fixtureSubjectRef: '',
  }
}

let nextTriggerFieldEditorKey = 1

function initialTriggerField(): CustomTriggerFieldDraft {
  return {
    editorKey: `trigger-field-${nextTriggerFieldEditorKey++}`,
    fieldId: '',
    displayName: { 'zh-CN': '', 'en-US': '' },
    description: { 'zh-CN': '', 'en-US': '' },
  }
}

function triggerNamespaceFromEventKey(eventKey: string): string {
  const normalized = eventKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (normalized === '') return 'event'
  return /^[a-z]/.test(normalized) ? normalized : `event_${normalized}`
}

function nextEventKey(events: readonly CustomEventTypeDraft[]): string {
  const existing = new Set(events.map((event) => event.eventKey))
  let ordinal = 1
  while (existing.has(`event.${ordinal}`)) ordinal += 1
  return `event.${ordinal}`
}

interface CustomSourceEditorForm {
  displayName: LocalizedText
  description: LocalizedText
  pollIntervalSeconds: number
  batchSize: number
  ingestionMode: 'state-change' | 'occurrence'
  language: CustomObserverLanguage
  source: string
  sourceTemplateManaged: boolean
  timeoutSeconds: number
  cursorJson: string
  eventTypes: CustomEventTypeDraft[]
}

function initialDraft(): CustomSourceEditorForm {
  const eventTypes = [initialEvent()]
  return {
    displayName: { 'zh-CN': '', 'en-US': '' },
    description: { 'zh-CN': '', 'en-US': '' },
    pollIntervalSeconds: 60,
    batchSize: 50,
    ingestionMode: 'state-change',
    language: 'node',
    source: customEventObserverStarter('node', eventTypes),
    sourceTemplateManaged: true,
    timeoutSeconds: 30,
    cursorJson: '',
    eventTypes,
  }
}

function withSynchronizedEventTypes(
  current: CustomSourceEditorForm,
  eventTypes: CustomEventTypeDraft[],
): CustomSourceEditorForm {
  return {
    ...current,
    eventTypes,
    source: syncManagedObserverSource({
      language: current.language,
      source: current.source,
      templateManaged: current.sourceTemplateManaged,
      events: eventTypes,
    }),
  }
}

function sourceStateLabel(state: CustomSourceSummary['state'], zh: boolean): string {
  if (state === 'draft') return zh ? '草稿' : 'Draft'
  if (state === 'changed') return zh ? '有未发布修改' : 'Unpublished changes'
  if (state === 'published') return zh ? '已发布' : 'Published'
  return zh ? '已退役' : 'Retired'
}

function sourceStateKind(state: CustomSourceSummary['state']): 'neutral' | 'warn' | 'success' {
  if (state === 'published') return 'success'
  if (state === 'changed') return 'warn'
  return 'neutral'
}

function EventsPage(): ReactElement {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const zh = language.startsWith('zh')
  const actor = useActor()
  const canCreateSource = usePermission('event-sources:create')
  const canUpdateSource = usePermission('event-sources:update')
  const canAuthorScripts = usePermission('scripts:author')
  const canArchive = usePermission('event-sources:archive')
  const canManageEndpoints = usePermission('webhook-endpoints:manage')
  const canCreate = canCreateSource && canAuthorScripts
  const canUpdate = canUpdateSource && canAuthorScripts
  const qc = useQueryClient()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tab: EventCenterTab = search.tab ?? 'overview'
  const panelIds = tabDomIds('event-center', tab)
  const [editor, setEditor] = useState<string | 'new' | null>(null)
  const [subscriptionView, setSubscriptionView] = useState<SubscriptionView>('rules')
  const [subscriptionPage, setSubscriptionPage] = useState(1)
  const [subscriptionSubscriber, setSubscriptionSubscriber] = useState('')
  const [deliveryView, setDeliveryView] = useState<DeliveryView>('consumer')
  const [expandedAuditRow, setExpandedAuditRow] = useState<string | null>(null)
  const [deliveryPage, setDeliveryPage] = useState(1)
  const [deliveryState, setDeliveryState] = useState<DeliveryStateFilter>('all')
  const [deliverySubscriber, setDeliverySubscriber] = useState('')
  const [committedDeliveryPage, setCommittedDeliveryPage] = useState(1)
  const [committedDeliveryState, setCommittedDeliveryState] = useState<DeliveryStateFilter>('all')
  const [committedDeliveryStage, setCommittedDeliveryStage] =
    useState<CommittedDeliveryStageFilter>('all')
  const [committedDeliveryFamily, setCommittedDeliveryFamily] =
    useState<CommittedDeliveryFamilyFilter>('all')
  const [committedDeliveryAggregate, setCommittedDeliveryAggregate] = useState('')
  const [committedDeliveryConsumer, setCommittedDeliveryConsumer] = useState('')
  const [sourceAuditPage, setSourceAuditPage] = useState(1)
  const [sourceAuditSource, setSourceAuditSource] = useState('')

  const catalog = useQuery<EventCatalog>({
    queryKey: ['event-center', 'catalog'],
    queryFn: ({ signal }) => api.get('/api/event-center/catalog', undefined, signal),
  })
  const customSources = useQuery<{ items: CustomSourceSummary[] }>({
    queryKey: ['event-center', 'custom-sources'],
    queryFn: ({ signal }) => api.get('/api/event-center/sources', undefined, signal),
  })
  const subscriptions = useQuery<EventPage<EventSubscription>>({
    queryKey: ['event-center', 'subscriptions', subscriptionPage, subscriptionSubscriber.trim()],
    queryFn: ({ signal }) => {
      const subscriber = subscriptionSubscriber.trim()
      return api.get(
        `/api/event-center/subscriptions/page?page=${subscriptionPage}&limit=${EVENT_AUDIT_PAGE_SIZE}${subscriber === '' ? '' : `&subscriberRef=${encodeURIComponent(subscriber)}`}`,
        undefined,
        signal,
      )
    },
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
  })
  const observers = useQuery<{ items: ObserverHealth[] }>({
    queryKey: ['event-center', 'observers'],
    queryFn: ({ signal }) => api.get('/api/event-center/observers', undefined, signal),
    refetchInterval: 5_000,
  })
  const deliveries = useQuery<EventPage<EventDeliveryStatus>>({
    queryKey: [
      'event-center',
      'deliveries',
      deliveryPage,
      deliveryState,
      deliverySubscriber.trim(),
    ],
    queryFn: ({ signal }) => {
      const subscriber = deliverySubscriber.trim()
      return api.get(
        `/api/event-center/deliveries/page?page=${deliveryPage}&limit=${EVENT_AUDIT_PAGE_SIZE}${deliveryState === 'all' ? '' : `&state=${deliveryState}`}${subscriber === '' ? '' : `&subscriberRef=${encodeURIComponent(subscriber)}`}`,
        undefined,
        signal,
      )
    },
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
  })
  const committedDeliveries = useQuery<EventPage<CommittedEventDeliveryStatus>>({
    queryKey: [
      'event-center',
      'committed-deliveries',
      committedDeliveryPage,
      committedDeliveryState,
      committedDeliveryStage,
      committedDeliveryFamily,
      committedDeliveryAggregate.trim(),
      committedDeliveryConsumer.trim(),
    ],
    queryFn: ({ signal }) => {
      const parameters = new URLSearchParams({
        page: String(committedDeliveryPage),
        limit: String(EVENT_AUDIT_PAGE_SIZE),
      })
      if (committedDeliveryState !== 'all') {
        parameters.set('state', committedDeliveryState)
      }
      if (committedDeliveryStage !== 'all') {
        parameters.set('stage', committedDeliveryStage)
      }
      if (committedDeliveryFamily !== 'all') {
        parameters.set('family', committedDeliveryFamily)
      }
      const aggregateId = committedDeliveryAggregate.trim()
      if (aggregateId !== '') parameters.set('aggregateId', aggregateId)
      const consumerId = committedDeliveryConsumer.trim()
      if (consumerId !== '') parameters.set('consumerId', consumerId)
      return api.get(
        `/api/event-center/committed-deliveries/page?${parameters.toString()}`,
        undefined,
        signal,
      )
    },
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
  })
  const sourceEvents = useQuery<EventPage<EventRecordAudit>>({
    queryKey: ['event-center', 'events', sourceAuditPage, sourceAuditSource],
    queryFn: ({ signal }) =>
      api.get(
        `/api/event-center/events/page?page=${sourceAuditPage}&limit=${EVENT_AUDIT_PAGE_SIZE}${sourceAuditSource === '' ? '' : `&sourceId=${encodeURIComponent(sourceAuditSource)}`}`,
        undefined,
        signal,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
  })
  const retire = useMutation({
    mutationFn: (id: string) => api.post(`/api/event-center/sources/${id}/retire`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['event-center'] })
    },
  })
  const retryCommittedDelivery = useMutation({
    mutationFn: (delivery: CommittedEventDeliveryStatus) =>
      api.post(
        `/api/event-center/committed-deliveries/${encodeURIComponent(delivery.eventId)}/${encodeURIComponent(delivery.consumerId)}/retry`,
        {
          observedLeaseEpoch: delivery.leaseEpoch,
          observedUpdatedAt: Date.parse(delivery.updatedAt),
        },
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['event-center', 'committed-deliveries'] })
    },
  })

  useEffect(() => {
    if (subscriptions.data !== undefined && subscriptionPage > subscriptions.data.pageCount) {
      setSubscriptionPage(subscriptions.data.pageCount)
    }
  }, [subscriptionPage, subscriptions.data])
  useEffect(() => {
    if (deliveries.data !== undefined && deliveryPage > deliveries.data.pageCount) {
      setDeliveryPage(deliveries.data.pageCount)
    }
  }, [deliveries.data, deliveryPage])
  useEffect(() => {
    if (
      committedDeliveries.data !== undefined &&
      committedDeliveryPage > committedDeliveries.data.pageCount
    ) {
      setCommittedDeliveryPage(committedDeliveries.data.pageCount)
    }
  }, [committedDeliveries.data, committedDeliveryPage])
  useEffect(() => {
    if (sourceEvents.data !== undefined && sourceAuditPage > sourceEvents.data.pageCount) {
      setSourceAuditPage(sourceEvents.data.pageCount)
    }
  }, [sourceAuditPage, sourceEvents.data])

  if (
    catalog.isPending ||
    customSources.isPending ||
    subscriptions.isPending ||
    observers.isPending ||
    deliveries.isPending ||
    committedDeliveries.isPending ||
    sourceEvents.isPending ||
    actor.isLoading
  ) {
    return <LoadingState />
  }
  const error =
    catalog.error ??
    customSources.error ??
    subscriptions.error ??
    observers.error ??
    deliveries.error ??
    committedDeliveries.error ??
    sourceEvents.error
  if (error !== null) return <ErrorBanner error={error} />
  if (
    catalog.data === undefined ||
    customSources.data === undefined ||
    subscriptions.data === undefined ||
    observers.data === undefined ||
    deliveries.data === undefined ||
    committedDeliveries.data === undefined ||
    sourceEvents.data === undefined
  ) {
    return <LoadingState />
  }

  const activeSubscriptionCount = catalog.data.sources.reduce(
    (total, source) => total + source.subscriptionCount,
    0,
  )
  const eventName = (ref: ExactRef): string => {
    const event = catalog.data.eventTypes.find((candidate) => sameRef(candidate.eventTypeRef, ref))
    return event === undefined ? ref.id : localized(event.displayName, language)
  }
  const sourceName = (ref: ExactRef): string => {
    const source = catalog.data.sources.find((candidate) => sameRef(candidate.sourceRef, ref))
    return source === undefined ? ref.id : localized(source.displayName, language)
  }
  const subscriptionState = (subscription: EventSubscription): string => {
    if (subscription.state === 'active') return zh ? '有效' : 'Active'
    if (subscription.state === 'paused') return zh ? '已暂停' : 'Paused'
    if (subscription.state === 'invalid') return zh ? '配置失效' : 'Invalid'
    return zh ? '已取消' : 'Cancelled'
  }
  const deliveryViewOptions = [
    {
      value: 'consumer',
      label: zh ? '订阅投递' : 'Subscriber deliveries',
      description: zh
        ? '一条标准事件面向每个订阅者的处理状态。'
        : 'Per-subscriber processing state for standard events.',
    },
    {
      value: 'committed',
      label: zh ? '平台投递' : 'Platform deliveries',
      description: zh
        ? '平台内部已提交事实的发布、重试与死信。'
        : 'Publication, retries, and dead letters for committed platform facts.',
    },
    {
      value: 'source',
      label: zh ? '来源事件' : 'Source events',
      description: zh
        ? '所有来源已经写入事件中心的标准事实。'
        : 'Standard facts recorded by every Event Center source.',
    },
    {
      value: 'webhook',
      label: zh ? 'Webhook 接入' : 'Webhook ingress',
      description: zh
        ? 'Webhook 适配器的验签、归一化与重放证据。'
        : 'Webhook verification, normalization, and replay evidence.',
    },
  ] as const
  const deliveryStateOptions = [
    { value: 'all', label: zh ? '全部' : 'All' },
    { value: 'pending', label: zh ? '待处理' : 'Pending' },
    { value: 'claimed', label: zh ? '处理中' : 'Processing' },
    { value: 'accepted', label: zh ? '已确认' : 'Accepted' },
    { value: 'dead-letter', label: zh ? '处理失败' : 'Failed' },
  ] as const
  const committedDeliveryStateOptions = [
    ...deliveryStateOptions.slice(0, -1),
    { value: 'dead-letter', label: zh ? '死信' : 'Dead letter' },
  ] as const
  const auditTotalLabel =
    deliveryView === 'consumer'
      ? zh
        ? `共 ${deliveries.data.total} 条投递`
        : `${deliveries.data.total} deliveries`
      : deliveryView === 'committed'
        ? zh
          ? `共 ${committedDeliveries.data.total} 条平台投递`
          : `${committedDeliveries.data.total} platform deliveries`
        : deliveryView === 'source'
          ? zh
            ? `共 ${sourceEvents.data.total} 条事件`
            : `${sourceEvents.data.total} source events`
          : null
  const auditTableLabel =
    deliveryView === 'consumer'
      ? zh
        ? '订阅投递记录'
        : 'Subscriber delivery records'
      : deliveryView === 'committed'
        ? zh
          ? '平台投递记录'
          : 'Platform delivery records'
        : zh
          ? '来源事件记录'
          : 'Source event records'
  const auditTableTestId =
    deliveryView === 'consumer'
      ? 'event-delivery-list'
      : deliveryView === 'committed'
        ? 'committed-delivery-list'
        : 'event-source-audit-list'
  const selectDeliveryView = (value: DeliveryView): void => {
    setDeliveryView(value)
    setExpandedAuditRow(null)
  }

  return (
    <div className="page page--operations event-center-page" data-testid="event-center-page">
      <div className="operations-surface">
        <PageHeader className="operations-surface__header" title={zh ? '事件中心' : 'Event Center'}>
          <p className="operations-surface__subtitle">
            {zh
              ? '平台统一管理事件来源、事件目录、订阅与按需轮询；数字员工、工作流和集成都可以复用。'
              : 'Manage sources, event types, subscriptions, and on-demand polling for employees, workflows, and integrations.'}
          </p>
        </PageHeader>

        <TabBar<EventCenterTab>
          active={tab}
          onSelect={(next) => void navigate({ search: (previous) => ({ ...previous, tab: next }) })}
          ariaLabel={zh ? '事件中心功能' : 'Event Center sections'}
          idPrefix="event-center"
          rootTestid="event-center-tab"
          className="repo-kind-tabs"
          tabs={[
            {
              key: 'overview',
              testid: 'event-center-tab-overview',
              label: <span className="repo-kind-tabs__label">{zh ? '事件总览' : 'Overview'}</span>,
            },
            {
              key: 'sources',
              testid: 'event-center-tab-sources',
              label: <span className="repo-kind-tabs__label">{zh ? '事件来源' : 'Sources'}</span>,
            },
            {
              key: 'subscriptions',
              testid: 'event-center-tab-subscriptions',
              label: (
                <span className="repo-kind-tabs__label">{zh ? '实时订阅' : 'Subscriptions'}</span>
              ),
            },
            {
              key: 'deliveries',
              testid: 'event-center-tab-deliveries',
              label: (
                <span className="repo-kind-tabs__label">{zh ? '事件流水' : 'Event activity'}</span>
              ),
            },
          ]}
        />

        <div
          className="digital-employee-surface__body event-center-page__body"
          role="tabpanel"
          id={panelIds.panelId}
          aria-labelledby={panelIds.tabId}
        >
          {tab === 'sources' ? (
            <NoticeBanner
              tone="info"
              title={zh ? '推送和轮询共用一条事件通道' : 'Push and polling share one event channel'}
            >
              {zh
                ? 'Webhook 负责接收和验签，自定义脚本负责按需观察；两者都只发布标准事件。主动来源有订阅才轮询，没人关注就停止。'
                : 'Webhooks receive and verify pushes; custom programs observe on demand. Both publish the same standard events, and active sources poll only while subscribed.'}
            </NoticeBanner>
          ) : null}

          {tab === 'subscriptions' ? (
            <NoticeBanner
              tone="info"
              title={zh ? '一条事件可以同时交给多个消费者' : 'One event may reach many consumers'}
            >
              {zh
                ? '每个订阅都会生成自己的投递。任一数字员工或编排确认后，只完成自己的投递，不会删除事件，也不会影响其他订阅者。'
                : 'Every subscription gets its own delivery. Acknowledging one delivery never deletes the event or changes another subscriber’s state.'}
            </NoticeBanner>
          ) : null}

          {tab === 'overview' ? (
            <div className="event-center-summary">
              <Card title={zh ? '已登记事件' : 'Registered events'}>
                <strong>{catalog.data.eventTypes.length}</strong>
              </Card>
              <Card title={zh ? '有效订阅' : 'Active subscriptions'}>
                <strong>{activeSubscriptionCount}</strong>
              </Card>
              <Card title={zh ? '待处理投递' : 'Pending deliveries'}>
                <strong>
                  {
                    deliveries.data.items.filter(
                      (item) => item.state === 'pending' || item.state === 'claimed',
                    ).length
                  }
                </strong>
              </Card>
              <Card title={zh ? '运行中的观察器' : 'Running observers'}>
                <strong>
                  {observers.data.items.filter((item) => item.state === 'active').length}
                </strong>
              </Card>
            </div>
          ) : null}

          {tab === 'overview' ? (
            <section className="employee-node-panel">
              <header>
                <div>
                  <span className="employee-node-panel__eyebrow">
                    {zh ? '事件总目录' : 'Event directory'}
                  </span>
                  <h2>
                    {zh ? '事件从哪里来，会发生什么' : 'Where events come from and what they emit'}
                  </h2>
                  <p>
                    {zh
                      ? '按来源展开全部事件；来源显示真实有效订阅数，子项显示可注入任务的参数合同。'
                      : 'Every source is fully expanded. Sources show active subscriptions and child events show injectable task contracts.'}
                  </p>
                </div>
              </header>
              <ul
                className="event-source-tree"
                role="tree"
                aria-label={zh ? '事件来源与事件目录' : 'Event sources and event types'}
                data-testid="event-source-tree"
              >
                {catalog.data.sources.map((source) => {
                  const health = observers.data.items.find((item) =>
                    sameRef(item.sourceRef, source.sourceRef),
                  )
                  const events = catalog.data.eventTypes
                    .filter((event) => sameRef(event.sourceRef, source.sourceRef))
                    .sort((left, right) =>
                      left.eventTypeRef.id.localeCompare(right.eventTypeRef.id),
                    )
                  const mode =
                    source.observationMode === 'passive'
                      ? zh
                        ? '实时推送'
                        : 'Push'
                      : source.observationMode === 'active'
                        ? zh
                          ? '按需轮询'
                          : 'On-demand polling'
                        : zh
                          ? '推送 + 轮询'
                          : 'Push + polling'
                  return (
                    <li
                      key={`${source.sourceRef.id}@${source.sourceRef.revision}`}
                      className="event-source-tree__source"
                      role="treeitem"
                      aria-expanded="true"
                    >
                      <div className="event-source-tree__source-row">
                        <div>
                          <strong>{localized(source.displayName, language)}</strong>
                          <span>{localized(source.description, language)}</span>
                          <small>
                            {mode} · {source.subscriptionCount}{' '}
                            {zh ? '个有效订阅' : 'active subscriptions'}
                          </small>
                        </div>
                        <StatusChip
                          kind={
                            health?.state === 'blocked'
                              ? 'danger'
                              : health?.state === 'active'
                                ? 'success'
                                : 'neutral'
                          }
                        >
                          {health?.state === 'blocked'
                            ? zh
                              ? '观察异常'
                              : 'Observer blocked'
                            : health?.state === 'active'
                              ? zh
                                ? '正在轮询'
                                : 'Polling'
                              : source.observationMode === 'passive'
                                ? zh
                                  ? '等待推送'
                                  : 'Awaiting push'
                                : zh
                                  ? '按需停止'
                                  : 'Stopped on demand'}
                        </StatusChip>
                      </div>
                      <ul className="event-source-tree__events" role="group">
                        {events.map((event) => (
                          <li
                            key={`${event.eventTypeRef.id}@${event.eventTypeRef.revision}`}
                            className="event-source-tree__event"
                            role="treeitem"
                          >
                            <strong>{localized(event.displayName, language)}</strong>
                            <span>{localized(event.description, language)}</span>
                            <small>
                              {event.triggerParameters === null
                                ? zh
                                  ? '仅唤醒已有关注，不注入任务参数'
                                  : 'Wakes existing attention without task parameters'
                                : `trigger.${event.triggerParameters.namespace}.* · ${event.triggerParameters.fields.length} ${zh ? '个任务参数' : 'task parameters'}`}
                            </small>
                          </li>
                        ))}
                      </ul>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}

          {tab === 'sources' ? (
            <>
              <section className="employee-node-panel event-source-section">
                <header>
                  <div>
                    <span className="employee-node-panel__eyebrow">
                      {zh ? '推送接入' : 'Push ingress'}
                    </span>
                    <h2>{zh ? 'Webhook 推送来源' : 'Webhook push sources'}</h2>
                    <p>
                      {zh
                        ? '端点只负责接收、验签和原始入站审计，标准事件随后进入同一事件中心。'
                        : 'Endpoints only receive, verify, and audit ingress before publishing standard events.'}
                    </p>
                  </div>
                </header>
                <WebhookEndpointCard canManage={canManageEndpoints} />
              </section>

              <section className="employee-node-panel event-source-section">
                <header>
                  <div>
                    <span className="employee-node-panel__eyebrow">
                      {zh ? '主动观察' : 'Active observation'}
                    </span>
                    <h2>{zh ? '自定义轮询来源' : 'Custom polling sources'}</h2>
                    <p>
                      {zh
                        ? '定义“去哪里看、多久看一次、会产生什么事件”；发布前平台会执行真实样例。'
                        : 'Define where to observe, how often, and which events are produced. A real fixture runs before publish.'}
                    </p>
                  </div>
                  {canCreate ? (
                    <button
                      type="button"
                      className="btn btn--primary event-source-create-action"
                      onClick={() => setEditor('new')}
                      data-testid="event-source-new"
                    >
                      {zh ? '新建自定义事件' : 'New custom event'}
                    </button>
                  ) : null}
                </header>
                {retire.isError ? <ErrorBanner error={retire.error} /> : null}
                {customSources.data.items.length === 0 ? (
                  <EmptyState
                    title={zh ? '还没有自定义事件来源' : 'No custom event sources'}
                    description={
                      zh
                        ? '内建来源仍然可用；需要接入自建系统时新增一个轮询来源。'
                        : 'Built-in sources remain available. Add a polling source for an internal system.'
                    }
                  />
                ) : (
                  <div className="node-tool-list" data-testid="event-source-list">
                    {customSources.data.items.map((source) => (
                      <article key={source.id} className="node-tool-row event-source-row">
                        <div>
                          <strong>{localized(source.displayName, language)}</strong>
                          <span>{localized(source.description, language)}</span>
                          <small>
                            {zh
                              ? `每 ${Math.round(source.pollIntervalMs / 1_000)} 秒 · 批量 ${source.batchSize} · ${source.eventTypeCount} 种事件`
                              : `Every ${Math.round(source.pollIntervalMs / 1_000)}s · batch ${source.batchSize} · ${source.eventTypeCount} events`}
                          </small>
                        </div>
                        <div className="event-source-row__actions">
                          <StatusChip kind={sourceStateKind(source.state)}>
                            {sourceStateLabel(source.state, zh)}
                            {source.publishedRevision === null
                              ? ''
                              : ` · v${source.publishedRevision}`}
                          </StatusChip>
                          {canUpdate && source.state !== 'retired' ? (
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => setEditor(source.id)}
                            >
                              {zh ? '编辑' : 'Edit'}
                            </button>
                          ) : null}
                          {canArchive && source.state !== 'retired' ? (
                            <ConfirmButton
                              size="sm"
                              variant="danger"
                              label={zh ? '退役' : 'Retire'}
                              confirmLabel={zh ? '确认退役' : 'Confirm retire'}
                              confirmationKey={source.id}
                              onConfirm={() => retire.mutateAsync(source.id)}
                            />
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : null}

          {tab === 'subscriptions' ? (
            <>
              <div className="event-center-view-switcher">
                <div>
                  <strong>{zh ? '订阅管理' : 'Subscription management'}</strong>
                  <span>
                    {zh
                      ? '配置自动化规则与查看运行订阅分开呈现，万级清单不会把编辑入口推到页面底部。'
                      : 'Rule authoring and runtime audit are separate views, so large lists never bury authoring.'}
                  </span>
                </div>
                <Segmented<SubscriptionView>
                  value={subscriptionView}
                  onChange={setSubscriptionView}
                  ariaLabel={zh ? '订阅页面视图' : 'Subscription page view'}
                  testidPrefix="event-subscription-view"
                  options={[
                    { value: 'rules', label: zh ? '自动化规则' : 'Automation rules' },
                    { value: 'audit', label: zh ? '订阅审计' : 'Subscription audit' },
                  ]}
                />
              </div>

              {subscriptionView === 'rules' ? (
                <div className="event-response-rule-sections">
                  <section className="employee-node-panel">
                    <header>
                      <div>
                        <span className="employee-node-panel__eyebrow">
                          {zh ? '自动化规则' : 'Automation rules'}
                        </span>
                        <h2>
                          {zh ? '事件发生后启动哪项工作' : 'Choose work to start for an event'}
                        </h2>
                        <p>
                          {zh
                            ? '目录中任何带任务输入契约的公开事件都可以选择，来源是 Webhook、轮询还是平台内部发布都不影响配置。'
                            : 'Any public catalog event with a task-input contract is selectable, regardless of whether it arrived by webhook, polling, or an internal publisher.'}
                        </p>
                      </div>
                    </header>
                    <EventResponseRulesPanel catalog={catalog.data} language={language} />
                  </section>

                  <section className="employee-node-panel event-response-webhook">
                    <header>
                      <div>
                        <span className="employee-node-panel__eyebrow">
                          {zh ? 'Webhook 订阅' : 'Webhook subscriptions'}
                        </span>
                        <h2>{zh ? 'Webhook 触发订阅' : 'Webhook trigger subscriptions'}</h2>
                        <p>
                          {zh
                            ? '配置仓库、分支和评论命令等 Webhook 专用条件；命中后同样通过事件中心启动编排或数字员工。'
                            : 'Configure Webhook-specific repository, branch, and comment-command conditions. Matches start workflows or digital employees through Event Center.'}
                        </p>
                      </div>
                    </header>
                    <TriggersPanel />
                  </section>
                </div>
              ) : (
                <section className="employee-node-panel">
                  <header>
                    <div>
                      <span className="employee-node-panel__eyebrow">
                        {zh ? '统一订阅' : 'Unified subscriptions'}
                      </span>
                      <h2>{zh ? '谁在等待什么' : 'Who is waiting for what'}</h2>
                      <p>
                        {zh
                          ? '数字员工的精确关注和编排的条件响应统一分页，每个订阅独立获得投递。'
                          : 'Exact employee attention and filtered automation responses are paged together and receive independent deliveries.'}
                      </p>
                    </div>
                  </header>
                  <FilterBar ariaLabel={zh ? '订阅审计筛选' : 'Subscription audit filters'}>
                    <FilterField label={zh ? '消费者标识' : 'Subscriber ID'}>
                      <TextInput
                        type="search"
                        value={subscriptionSubscriber}
                        onChange={(value) => {
                          setSubscriptionSubscriber(value)
                          setSubscriptionPage(1)
                        }}
                        placeholder={zh ? '精确输入消费者标识' : 'Exact subscriber ID'}
                        aria-label={
                          zh ? '按消费者标识筛选订阅' : 'Filter subscriptions by subscriber ID'
                        }
                        data-testid="event-subscription-subscriber-filter"
                      />
                    </FilterField>
                  </FilterBar>
                  <p className="event-center-audit__total">
                    {zh
                      ? `共 ${subscriptions.data.total} 条订阅`
                      : `${subscriptions.data.total} subscriptions`}
                  </p>
                  <div className="node-tool-list" data-testid="event-subscription-list">
                    {subscriptions.data.items.length === 0 ? (
                      <p className="node-tool-list__empty">
                        {zh ? '当前筛选下没有订阅。' : 'No subscriptions match this filter.'}
                      </p>
                    ) : (
                      subscriptions.data.items.map((subscription) => {
                        const exact = subscription.mode === 'exact'
                        const title = exact
                          ? eventName(subscription.eventTypeRef)
                          : localized(subscription.displayName, language)
                        const detail = exact
                          ? `${subscription.subject.typeId} · ${subscription.subject.subjectRef}`
                          : `${subscription.subjectTypeId} · ${subscription.eventTypeRefs.map(eventName).join('、')}`
                        return (
                          <article
                            key={`${subscription.mode}:${subscription.id}`}
                            className="node-tool-row"
                          >
                            <div>
                              <strong>{title}</strong>
                              <span>{detail}</span>
                              <small>
                                {sourceName(subscription.sourceRef)} ·{' '}
                                {exact
                                  ? zh
                                    ? '精确关注'
                                    : 'Exact attention'
                                  : zh
                                    ? '条件响应'
                                    : 'Filtered response'}{' '}
                                · {subscription.subscriber.kind}/
                                {subscription.subscriber.subscriberRef}
                              </small>
                            </div>
                            <div className="event-source-row__actions">
                              <StatusChip
                                kind={
                                  subscription.state === 'active'
                                    ? 'success'
                                    : subscription.state === 'invalid'
                                      ? 'danger'
                                      : 'neutral'
                                }
                              >
                                {subscriptionState(subscription)}
                              </StatusChip>
                              {exact && subscription.subscriber.kind === 'employee-case' ? (
                                <Link
                                  to="/tasks/employee-cases/$caseId"
                                  params={{ caseId: subscription.subscriber.subscriberRef }}
                                  className="btn btn--sm"
                                >
                                  {zh ? '查看任务' : 'View task'}
                                </Link>
                              ) : null}
                            </div>
                          </article>
                        )
                      })
                    )}
                  </div>
                  {subscriptions.data.total > 0 ? (
                    <Pagination
                      page={subscriptionPage}
                      pageCount={subscriptions.data.pageCount}
                      onPageChange={setSubscriptionPage}
                      data-testid="event-subscription-pagination"
                    />
                  ) : null}
                </section>
              )}
            </>
          ) : null}

          {tab === 'deliveries' ? (
            <section className="event-center-audit" data-testid="event-center-audit">
              <FilterBar
                density="compact"
                ariaLabel={zh ? '事件与投递流水筛选' : 'Event activity filters'}
                trailing={
                  auditTotalLabel === null ? undefined : (
                    <span className="event-center-audit__total">{auditTotalLabel}</span>
                  )
                }
              >
                <FilterField label={zh ? '记录范围' : 'Record scope'}>
                  <Select<DeliveryView>
                    value={deliveryView}
                    onChange={selectDeliveryView}
                    options={deliveryViewOptions}
                    ariaLabel={zh ? '选择事件流水范围' : 'Choose event activity scope'}
                    data-testid="event-delivery-kind-filter"
                  />
                </FilterField>

                {deliveryView === 'consumer' ? (
                  <>
                    <FilterField label={zh ? '处理状态' : 'Status'}>
                      <Select<DeliveryStateFilter>
                        value={deliveryState}
                        onChange={(value) => {
                          setDeliveryState(value)
                          setDeliveryPage(1)
                          setExpandedAuditRow(null)
                        }}
                        options={deliveryStateOptions}
                        ariaLabel={zh ? '按处理状态筛选' : 'Filter by processing state'}
                        data-testid="event-delivery-state-filter"
                      />
                    </FilterField>
                    <FilterField label={zh ? '消费者标识' : 'Subscriber ID'}>
                      <TextInput
                        type="search"
                        value={deliverySubscriber}
                        onChange={(value) => {
                          setDeliverySubscriber(value)
                          setDeliveryPage(1)
                          setExpandedAuditRow(null)
                        }}
                        placeholder={zh ? '精确输入消费者标识' : 'Exact subscriber ID'}
                        aria-label={
                          zh ? '按消费者标识筛选投递' : 'Filter deliveries by subscriber ID'
                        }
                        data-testid="event-delivery-subscriber-filter"
                      />
                    </FilterField>
                  </>
                ) : deliveryView === 'committed' ? (
                  <>
                    <FilterField label={zh ? '处理状态' : 'Status'}>
                      <Select<DeliveryStateFilter>
                        value={committedDeliveryState}
                        onChange={(value) => {
                          setCommittedDeliveryState(value)
                          setCommittedDeliveryPage(1)
                          setExpandedAuditRow(null)
                        }}
                        options={committedDeliveryStateOptions}
                        ariaLabel={zh ? '按处理状态筛选' : 'Filter by delivery state'}
                        data-testid="committed-delivery-state-filter"
                      />
                    </FilterField>
                    <FilterField label={zh ? '阶段' : 'Stage'}>
                      <Select
                        value={committedDeliveryStage}
                        onChange={(value) => {
                          setCommittedDeliveryStage(value)
                          setCommittedDeliveryPage(1)
                          setExpandedAuditRow(null)
                        }}
                        options={[
                          { value: 'all', label: zh ? '全部阶段' : 'All stages' },
                          {
                            value: 'producer-publication',
                            label: zh ? '生产者发布' : 'Producer publication',
                          },
                          {
                            value: 'consumer-delivery',
                            label: zh ? '消费者投递' : 'Consumer delivery',
                          },
                        ]}
                        ariaLabel={zh ? '按阶段筛选' : 'Filter by stage'}
                        data-testid="committed-delivery-stage-filter"
                      />
                    </FilterField>
                    <FilterField label={zh ? '事件族' : 'Family'}>
                      <Select
                        value={committedDeliveryFamily}
                        onChange={(value) => {
                          setCommittedDeliveryFamily(value)
                          setCommittedDeliveryPage(1)
                          setExpandedAuditRow(null)
                        }}
                        options={[
                          { value: 'all', label: zh ? '全部事件族' : 'All families' },
                          { value: 'task-lifecycle', label: 'task-lifecycle' },
                          { value: 'review', label: 'review' },
                          { value: 'clarify', label: 'clarify' },
                          { value: 'questions', label: 'questions' },
                        ]}
                        ariaLabel={zh ? '按事件族筛选' : 'Filter by event family'}
                        data-testid="committed-delivery-family-filter"
                      />
                    </FilterField>
                    <FilterField label={zh ? '聚合标识' : 'Aggregate ID'}>
                      <TextInput
                        type="search"
                        value={committedDeliveryAggregate}
                        onChange={(value) => {
                          setCommittedDeliveryAggregate(value)
                          setCommittedDeliveryPage(1)
                          setExpandedAuditRow(null)
                        }}
                        placeholder={zh ? '精确输入聚合标识' : 'Exact aggregate ID'}
                        aria-label={zh ? '按聚合标识筛选' : 'Filter by aggregate ID'}
                        data-testid="committed-delivery-aggregate-filter"
                      />
                    </FilterField>
                    <FilterField label={zh ? '消费者标识' : 'Consumer ID'}>
                      <TextInput
                        type="search"
                        value={committedDeliveryConsumer}
                        onChange={(value) => {
                          setCommittedDeliveryConsumer(value)
                          setCommittedDeliveryPage(1)
                          setExpandedAuditRow(null)
                        }}
                        placeholder={zh ? '精确输入消费者标识' : 'Exact consumer ID'}
                        aria-label={zh ? '按消费者标识筛选' : 'Filter by consumer ID'}
                        data-testid="committed-delivery-consumer-filter"
                      />
                    </FilterField>
                  </>
                ) : deliveryView === 'source' ? (
                  <FilterField label={zh ? '事件来源' : 'Event source'}>
                    <Select
                      value={sourceAuditSource}
                      onChange={(value) => {
                        setSourceAuditSource(value)
                        setSourceAuditPage(1)
                        setExpandedAuditRow(null)
                      }}
                      options={[
                        { value: '', label: zh ? '全部来源' : 'All sources' },
                        ...catalog.data.sources.map((source) => ({
                          value: source.sourceRef.id,
                          label: localized(source.displayName, language),
                        })),
                      ]}
                      ariaLabel={zh ? '按事件来源筛选' : 'Filter by event source'}
                      data-testid="event-source-audit-filter"
                    />
                  </FilterField>
                ) : null}
              </FilterBar>

              {retryCommittedDelivery.error === null ? null : (
                <ErrorBanner error={retryCommittedDelivery.error} />
              )}

              {deliveryView === 'webhook' ? (
                <DeliveriesPanel canReplay={canManageEndpoints} compact />
              ) : (
                <>
                  <TableViewport label={auditTableLabel} minWidth="lg">
                    <table
                      className="data-table data-table--compact event-center-audit-table"
                      data-testid={auditTableTestId}
                    >
                      <colgroup>
                        <col className="event-center-audit-table__expand-column" />
                        <col className="event-center-audit-table__record-column" />
                        <col className="event-center-audit-table__subject-column" />
                        <col className="event-center-audit-table__path-column" />
                        <col className="event-center-audit-table__status-column" />
                        <col className="event-center-audit-table__time-column" />
                        <col className="event-center-audit-table__action-column" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th aria-label={zh ? '展开详情' : 'Expand details'} />
                          <th>{zh ? '记录' : 'Record'}</th>
                          <th>{zh ? '对象' : 'Subject'}</th>
                          <th>{zh ? '路径' : 'Path'}</th>
                          <th>{zh ? '状态' : 'Status'}</th>
                          <th>{zh ? '时间' : 'Time'}</th>
                          <th aria-label={zh ? '操作' : 'Actions'} />
                        </tr>
                      </thead>
                      <tbody>
                        {deliveryView === 'consumer' ? (
                          deliveries.data.items.length === 0 ? (
                            <tr>
                              <td className="event-center-audit__empty" colSpan={7}>
                                {zh ? '还没有事件投递。' : 'No event deliveries yet.'}
                              </td>
                            </tr>
                          ) : (
                            deliveries.data.items.map((delivery) => {
                              const rowKey = `consumer:${delivery.deliveryId}`
                              const detailsId = `event-audit-details-${encodeURIComponent(rowKey)}`
                              const expanded = expandedAuditRow === rowKey
                              const subject = `${delivery.subject.typeId}/${delivery.subject.subjectRef}`
                              const subscriber = `${delivery.subscriber.kind}/${delivery.subscriber.subscriberRef}`
                              return (
                                <Fragment key={rowKey}>
                                  <tr
                                    className="data-table__row"
                                    data-testid={`event-delivery-row-${delivery.deliveryId}`}
                                  >
                                    <td className="data-table__expand">
                                      <OperationsExpandButton
                                        expanded={expanded}
                                        controls={detailsId}
                                        label={
                                          expanded
                                            ? zh
                                              ? '收起投递详情'
                                              : 'Collapse delivery details'
                                            : zh
                                              ? '展开投递详情'
                                              : 'Expand delivery details'
                                        }
                                        testid={`event-delivery-expand-${delivery.deliveryId}`}
                                        onToggle={() =>
                                          setExpandedAuditRow(expanded ? null : rowKey)
                                        }
                                      />
                                    </td>
                                    <td>
                                      <span
                                        className="event-center-audit-table__clip"
                                        title={eventName(delivery.eventTypeRef)}
                                      >
                                        <strong>{eventName(delivery.eventTypeRef)}</strong>
                                      </span>
                                    </td>
                                    <td>
                                      <span
                                        className="event-center-audit-table__clip"
                                        title={subject}
                                      >
                                        {subject}
                                      </span>
                                    </td>
                                    <td>
                                      <span
                                        className="event-center-audit-table__clip event-center-audit-table__path"
                                        title={subscriber}
                                      >
                                        {subscriber}
                                      </span>
                                    </td>
                                    <td>
                                      <StatusChip
                                        kind={eventAuditStateKind(delivery.state)}
                                        size="sm"
                                      >
                                        {eventAuditStateLabel(delivery.state, zh, 'failed')}
                                      </StatusChip>
                                    </td>
                                    <td className="data-table__nowrap">
                                      <RelativeTime ts={delivery.createdAt} />
                                    </td>
                                    <td />
                                  </tr>
                                  {expanded ? (
                                    <tr id={detailsId} className="data-table__expanded-row">
                                      <td colSpan={7}>
                                        <dl className="event-center-audit-details">
                                          <div>
                                            <dt>{zh ? '事件 ID' : 'Event ID'}</dt>
                                            <dd>
                                              <code>{delivery.eventId}</code>
                                            </dd>
                                          </div>
                                          <div>
                                            <dt>{zh ? '投递 ID' : 'Delivery ID'}</dt>
                                            <dd>
                                              <code>{delivery.deliveryId}</code>
                                            </dd>
                                          </div>
                                          <div>
                                            <dt>{zh ? '订阅 ID' : 'Subscription ID'}</dt>
                                            <dd>
                                              <code>{delivery.subscriptionId}</code>
                                            </dd>
                                          </div>
                                          <div>
                                            <dt>{zh ? '尝试次数' : 'Attempts'}</dt>
                                            <dd>{delivery.attemptCount}</dd>
                                          </div>
                                          {delivery.state === 'pending' ||
                                          delivery.state === 'claimed' ? (
                                            <div>
                                              <dt>{zh ? '下次尝试' : 'Next attempt'}</dt>
                                              <dd>
                                                {new Date(delivery.nextAttemptAt).toLocaleString()}
                                              </dd>
                                            </div>
                                          ) : null}
                                          {delivery.lastError === null ? null : (
                                            <div className="event-center-audit-details__wide">
                                              <dt>{zh ? '最近错误' : 'Latest error'}</dt>
                                              <dd className="event-center-committed-error">
                                                {delivery.lastError}
                                              </dd>
                                            </div>
                                          )}
                                        </dl>
                                      </td>
                                    </tr>
                                  ) : null}
                                </Fragment>
                              )
                            })
                          )
                        ) : deliveryView === 'committed' ? (
                          committedDeliveries.data.items.length === 0 ? (
                            <tr>
                              <td className="event-center-audit__empty" colSpan={7}>
                                {zh
                                  ? '当前筛选下还没有平台投递。'
                                  : 'No platform deliveries match these filters.'}
                              </td>
                            </tr>
                          ) : (
                            committedDeliveries.data.items.map((delivery) => {
                              const rowKey = `committed:${delivery.eventId}:${delivery.consumerId}`
                              const detailsId = `event-audit-details-${encodeURIComponent(rowKey)}`
                              const expanded = expandedAuditRow === rowKey
                              const aggregate = `${delivery.aggregateKind}/${delivery.aggregateId} #${delivery.aggregateSeq}`
                              const stage =
                                delivery.stage === 'producer-publication'
                                  ? zh
                                    ? '生产者发布'
                                    : 'Producer publication'
                                  : zh
                                    ? '消费者投递'
                                    : 'Consumer delivery'
                              return (
                                <Fragment key={rowKey}>
                                  <tr
                                    className="data-table__row"
                                    data-testid={`committed-delivery-row-${delivery.eventId}-${delivery.consumerId}`}
                                  >
                                    <td className="data-table__expand">
                                      <OperationsExpandButton
                                        expanded={expanded}
                                        controls={detailsId}
                                        label={
                                          expanded
                                            ? zh
                                              ? '收起平台投递详情'
                                              : 'Collapse platform delivery details'
                                            : zh
                                              ? '展开平台投递详情'
                                              : 'Expand platform delivery details'
                                        }
                                        testid={`committed-delivery-expand-${delivery.eventId}-${delivery.consumerId}`}
                                        onToggle={() =>
                                          setExpandedAuditRow(expanded ? null : rowKey)
                                        }
                                      />
                                    </td>
                                    <td>
                                      <span
                                        className="event-center-audit-table__clip"
                                        title={delivery.eventType}
                                      >
                                        <strong>{delivery.eventType}</strong>
                                      </span>
                                    </td>
                                    <td>
                                      <span
                                        className="event-center-audit-table__clip"
                                        title={aggregate}
                                      >
                                        {aggregate}
                                      </span>
                                    </td>
                                    <td>
                                      <span
                                        className="event-center-audit-table__clip event-center-audit-table__path"
                                        title={`${stage} · ${delivery.consumerId}`}
                                      >
                                        {stage} · {delivery.consumerId}
                                      </span>
                                    </td>
                                    <td>
                                      <span className="event-center-audit-table__chips">
                                        {delivery.mode === 'shadow' ? (
                                          <StatusChip kind="info" size="sm">
                                            {zh ? '影子' : 'Shadow'}
                                          </StatusChip>
                                        ) : null}
                                        <StatusChip
                                          kind={eventAuditStateKind(delivery.state)}
                                          size="sm"
                                        >
                                          {eventAuditStateLabel(delivery.state, zh, 'dead-letter')}
                                        </StatusChip>
                                      </span>
                                    </td>
                                    <td className="data-table__nowrap">
                                      <RelativeTime ts={delivery.updatedAt} />
                                    </td>
                                    <td className="data-table__actions">
                                      {delivery.canRetry ? (
                                        <button
                                          type="button"
                                          className="btn btn--xs"
                                          disabled={
                                            !canUpdateSource ||
                                            (retryCommittedDelivery.isPending &&
                                              retryCommittedDelivery.variables?.eventId ===
                                                delivery.eventId &&
                                              retryCommittedDelivery.variables.consumerId ===
                                                delivery.consumerId)
                                          }
                                          title={
                                            canUpdateSource
                                              ? undefined
                                              : zh
                                                ? '需要事件来源更新权限'
                                                : 'Event-source update permission required'
                                          }
                                          onClick={() => retryCommittedDelivery.mutate(delivery)}
                                          data-testid={`committed-delivery-retry-${delivery.eventId}-${delivery.consumerId}`}
                                        >
                                          {retryCommittedDelivery.isPending &&
                                          retryCommittedDelivery.variables?.eventId ===
                                            delivery.eventId &&
                                          retryCommittedDelivery.variables.consumerId ===
                                            delivery.consumerId
                                            ? zh
                                              ? '重试中…'
                                              : 'Retrying…'
                                            : zh
                                              ? '重新投递'
                                              : 'Retry'}
                                        </button>
                                      ) : null}
                                    </td>
                                  </tr>
                                  {expanded ? (
                                    <tr id={detailsId} className="data-table__expanded-row">
                                      <td colSpan={7}>
                                        <dl className="event-center-audit-details">
                                          <div>
                                            <dt>{zh ? '事件 ID' : 'Event ID'}</dt>
                                            <dd>
                                              <code>{delivery.eventId}</code>
                                            </dd>
                                          </div>
                                          <div>
                                            <dt>{zh ? '生产者 / 事件族' : 'Producer / family'}</dt>
                                            <dd>
                                              {delivery.producer} / {delivery.family}
                                            </dd>
                                          </div>
                                          <div>
                                            <dt>{zh ? '模式' : 'Mode'}</dt>
                                            <dd>{delivery.mode}</dd>
                                          </div>
                                          <div>
                                            <dt>{zh ? '尝试次数' : 'Attempts'}</dt>
                                            <dd>{delivery.attemptCount}</dd>
                                          </div>
                                          {delivery.nextAttemptAt === null ? null : (
                                            <div>
                                              <dt>{zh ? '下次重试' : 'Next retry'}</dt>
                                              <dd>
                                                {new Date(delivery.nextAttemptAt).toLocaleString()}
                                              </dd>
                                            </div>
                                          )}
                                          {delivery.lastErrorSummary === null ? null : (
                                            <div className="event-center-audit-details__wide">
                                              <dt>{zh ? '最近错误' : 'Latest error'}</dt>
                                              <dd className="event-center-committed-error">
                                                {delivery.lastErrorSummary}
                                              </dd>
                                            </div>
                                          )}
                                        </dl>
                                      </td>
                                    </tr>
                                  ) : null}
                                </Fragment>
                              )
                            })
                          )
                        ) : sourceEvents.data.items.length === 0 ? (
                          <tr>
                            <td className="event-center-audit__empty" colSpan={7}>
                              {zh
                                ? '当前筛选下还没有来源事件。'
                                : 'No source events match this filter.'}
                            </td>
                          </tr>
                        ) : (
                          sourceEvents.data.items.map((event) => {
                            const rowKey = `source:${event.eventId}`
                            const detailsId = `event-audit-details-${encodeURIComponent(rowKey)}`
                            const expanded = expandedAuditRow === rowKey
                            const subject = `${event.subject.typeId}/${event.subject.subjectRef}`
                            const name = eventName(event.eventTypeRef)
                            return (
                              <Fragment key={rowKey}>
                                <tr
                                  className="data-table__row"
                                  data-testid={`event-source-row-${event.eventId}`}
                                >
                                  <td className="data-table__expand">
                                    <OperationsExpandButton
                                      expanded={expanded}
                                      controls={detailsId}
                                      label={
                                        expanded
                                          ? zh
                                            ? '收起来源事件详情'
                                            : 'Collapse source event details'
                                          : zh
                                            ? '展开来源事件详情'
                                            : 'Expand source event details'
                                      }
                                      testid={`event-source-expand-${event.eventId}`}
                                      onToggle={() => setExpandedAuditRow(expanded ? null : rowKey)}
                                    />
                                  </td>
                                  <td>
                                    <span
                                      className="event-center-audit-table__clip"
                                      title={`${name} · ${event.summary}`}
                                    >
                                      <strong>{name}</strong>
                                      <span className="event-center-audit-table__summary">
                                        {' '}
                                        · {event.summary}
                                      </span>
                                    </span>
                                  </td>
                                  <td>
                                    <span
                                      className="event-center-audit-table__clip"
                                      title={subject}
                                    >
                                      {subject}
                                    </span>
                                  </td>
                                  <td>
                                    <span
                                      className="event-center-audit-table__clip event-center-audit-table__path"
                                      title={sourceName(event.sourceRef)}
                                    >
                                      {sourceName(event.sourceRef)}
                                    </span>
                                  </td>
                                  <td>
                                    <StatusChip kind="neutral" size="sm">
                                      {zh ? '已记录' : 'Recorded'}
                                    </StatusChip>
                                  </td>
                                  <td className="data-table__nowrap">
                                    <RelativeTime ts={event.observedAt} />
                                  </td>
                                  <td />
                                </tr>
                                {expanded ? (
                                  <tr id={detailsId} className="data-table__expanded-row">
                                    <td colSpan={7}>
                                      <dl className="event-center-audit-details">
                                        <div>
                                          <dt>{zh ? '事件 ID' : 'Event ID'}</dt>
                                          <dd>
                                            <code>{event.eventId}</code>
                                          </dd>
                                        </div>
                                        <div>
                                          <dt>{zh ? '发生时间' : 'Occurred at'}</dt>
                                          <dd>{new Date(event.occurredAt).toLocaleString()}</dd>
                                        </div>
                                        <div>
                                          <dt>{zh ? '入库时间' : 'Recorded at'}</dt>
                                          <dd>{new Date(event.observedAt).toLocaleString()}</dd>
                                        </div>
                                        <div>
                                          <dt>{zh ? '产物引用' : 'Artifact ref'}</dt>
                                          <dd>
                                            {event.payloadArtifactRef ?? (zh ? '无' : 'None')}
                                          </dd>
                                        </div>
                                        <div className="event-center-audit-details__wide">
                                          <dt>{zh ? '摘要' : 'Summary'}</dt>
                                          <dd>{event.summary}</dd>
                                        </div>
                                      </dl>
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            )
                          })
                        )}
                      </tbody>
                    </table>
                  </TableViewport>

                  {deliveryView === 'consumer' && deliveries.data.total > 0 ? (
                    <Pagination
                      page={deliveryPage}
                      pageCount={deliveries.data.pageCount}
                      onPageChange={(page) => {
                        setDeliveryPage(page)
                        setExpandedAuditRow(null)
                      }}
                      data-testid="event-delivery-pagination"
                    />
                  ) : deliveryView === 'committed' && committedDeliveries.data.total > 0 ? (
                    <Pagination
                      page={committedDeliveryPage}
                      pageCount={committedDeliveries.data.pageCount}
                      onPageChange={(page) => {
                        setCommittedDeliveryPage(page)
                        setExpandedAuditRow(null)
                      }}
                      data-testid="committed-delivery-pagination"
                    />
                  ) : deliveryView === 'source' && sourceEvents.data.total > 0 ? (
                    <Pagination
                      page={sourceAuditPage}
                      pageCount={sourceEvents.data.pageCount}
                      onPageChange={(page) => {
                        setSourceAuditPage(page)
                        setExpandedAuditRow(null)
                      }}
                      data-testid="event-source-audit-pagination"
                    />
                  ) : null}
                </>
              )}
            </section>
          ) : null}
        </div>
      </div>

      {editor !== null ? (
        <EventSourceEditor
          sourceId={editor === 'new' ? null : editor}
          language={language}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            await qc.invalidateQueries({ queryKey: ['event-center'] })
          }}
        />
      ) : null}
    </div>
  )
}

function EventSourceEditor(props: {
  sourceId: string | null
  language: string
  onClose: () => void
  onSaved: () => Promise<void>
}): ReactElement {
  const zh = props.language.startsWith('zh')
  const [form, setForm] = useState(initialDraft)
  const [workingId, setWorkingId] = useState(props.sourceId)
  const [action, setAction] = useState<'save' | 'validate' | 'publish' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [validation, setValidation] = useState<string | null>(null)
  const [validationSetupOpen, setValidationSetupOpen] = useState(false)
  const authoring = useQuery<CustomSourceAuthoring>({
    queryKey: ['event-center', 'custom-source', props.sourceId],
    queryFn: ({ signal }) =>
      api.get(`/api/event-center/sources/${props.sourceId ?? ''}`, undefined, signal),
    enabled: props.sourceId !== null,
  })
  const authoringLoading = props.sourceId !== null && authoring.isPending

  useEffect(() => {
    if (authoring.data === undefined) return
    const draft = authoring.data.draft
    setForm({
      displayName: draft.displayName,
      description: draft.description,
      pollIntervalSeconds: draft.pollIntervalMs / 1_000,
      batchSize: draft.batchSize,
      ingestionMode: draft.ingestionMode,
      language: draft.program.language,
      source: draft.program.source,
      sourceTemplateManaged: draft.program.templateManaged === true,
      timeoutSeconds: draft.program.timeoutMs / 1_000,
      cursorJson: draft.fixture.cursorJson ?? '',
      eventTypes: draft.eventTypes.map((event) => ({
        ...event,
        triggerParameters:
          event.triggerParameters === null
            ? null
            : {
                ...event.triggerParameters,
                fields: event.triggerParameters.fields.map((field) => ({
                  ...field,
                  editorKey: `trigger-field-${nextTriggerFieldEditorKey++}`,
                })),
              },
        fixtureSubjectRef:
          draft.fixture.subjects.find((subject) => subject.typeId === event.subjectTypeId)
            ?.subjectRef ?? '',
      })),
    })
    setWorkingId(authoring.data.id)
  }, [authoring.data])

  const body = useMemo<CustomSourceDraft>(() => {
    const subjects = new Map<string, string>()
    for (const event of form.eventTypes) {
      if (!subjects.has(event.subjectTypeId) && event.fixtureSubjectRef.trim() !== '') {
        subjects.set(event.subjectTypeId, event.fixtureSubjectRef.trim())
      }
    }
    return {
      schemaVersion: 1,
      displayName: form.displayName,
      description: form.description,
      pollIntervalMs: Math.round(form.pollIntervalSeconds * 1_000),
      batchSize: Math.round(form.batchSize),
      ingestionMode: form.ingestionMode,
      program: {
        language: form.language,
        source: form.source,
        templateManaged: form.sourceTemplateManaged,
        timeoutMs: Math.round(form.timeoutSeconds * 1_000),
      },
      eventTypes: form.eventTypes.map(
        ({ fixtureSubjectRef: _fixtureSubjectRef, triggerParameters, ...event }) => ({
          ...event,
          triggerParameters:
            triggerParameters === null
              ? null
              : {
                  namespace: triggerParameters.namespace,
                  fields: triggerParameters.fields.map(
                    ({ editorKey: _editorKey, ...field }) => field,
                  ),
                },
        }),
      ),
      fixture: {
        subjects: [...subjects].map(([typeId, subjectRef]) => ({ typeId, subjectRef })),
        cursorJson: form.cursorJson.trim() === '' ? null : form.cursorJson,
      },
    }
  }, [form])

  const draftValid =
    form.displayName['zh-CN'].trim() !== '' &&
    form.displayName['en-US'].trim() !== '' &&
    form.description['zh-CN'].trim() !== '' &&
    form.description['en-US'].trim() !== '' &&
    form.pollIntervalSeconds >= 1 &&
    form.batchSize >= 1 &&
    form.timeoutSeconds >= 1 &&
    form.source.trim() !== '' &&
    form.eventTypes.length > 0 &&
    form.eventTypes.every(
      (event) =>
        event.eventKey.trim() !== '' &&
        event.subjectTypeId.trim() !== '' &&
        event.payloadSchemaId.trim() !== '' &&
        event.deliveryClass.trim() !== '' &&
        event.displayName['zh-CN'].trim() !== '' &&
        event.displayName['en-US'].trim() !== '' &&
        event.description['zh-CN'].trim() !== '' &&
        event.description['en-US'].trim() !== '' &&
        (event.triggerParameters === null ||
          (event.triggerParameters.namespace.trim() !== '' &&
            event.triggerParameters.fields.length > 0 &&
            event.triggerParameters.fields.every(
              (field) =>
                field.fieldId.trim() !== '' &&
                field.displayName['zh-CN'].trim() !== '' &&
                field.displayName['en-US'].trim() !== '' &&
                field.description['zh-CN'].trim() !== '' &&
                field.description['en-US'].trim() !== '',
            ))),
    )

  const fixtureValid = form.eventTypes.every((event) => event.fixtureSubjectRef.trim() !== '')

  async function saveDraft(): Promise<string> {
    const id = workingId
    const saved =
      id === null
        ? await api.post<CustomSourceAuthoring>('/api/event-center/sources', body)
        : await api.put<CustomSourceAuthoring>(`/api/event-center/sources/${id}`, body)
    setWorkingId(saved.id)
    await props.onSaved()
    return saved.id
  }

  async function run(next: 'save' | 'validate' | 'publish'): Promise<void> {
    if (next !== 'save' && !fixtureValid) {
      setValidationSetupOpen(true)
      setValidation(null)
      setError(
        new Error(
          zh
            ? '运行验证或发布前，请在“发布前验证”中填写一个真实测试对象。保存草稿不需要填写。'
            : 'Before validation or publish, add one real test object under “Pre-publish validation”. Saving a draft does not require it.',
        ),
      )
      return
    }
    setAction(next)
    setError(null)
    setValidation(null)
    try {
      const id = await saveDraft()
      if (next === 'validate') {
        const receipt = await api.post<{ observationCount: number }>(
          `/api/event-center/sources/${id}/validate`,
        )
        setValidation(
          zh
            ? `真实样例通过，脚本输出 ${receipt.observationCount} 条事件。`
            : `Fixture passed with ${receipt.observationCount} observations.`,
        )
      } else if (next === 'publish') {
        await api.post(`/api/event-center/sources/${id}/publish`)
        await props.onSaved()
        props.onClose()
      } else {
        setValidation(zh ? '草稿已保存。' : 'Draft saved.')
      }
    } catch (caught) {
      setError(caught)
    } finally {
      setAction(null)
    }
  }

  function updateEvent(index: number, patch: Partial<CustomEventTypeDraft>): void {
    setForm((current) =>
      withSynchronizedEventTypes(
        current,
        current.eventTypes.map((event, eventIndex) =>
          eventIndex === index ? { ...event, ...patch } : event,
        ),
      ),
    )
  }

  function updateTriggerField(
    eventIndex: number,
    fieldIndex: number,
    patch: Partial<NonNullable<CustomEventTypeDraft['triggerParameters']>['fields'][number]>,
  ): void {
    setForm((current) =>
      withSynchronizedEventTypes(
        current,
        current.eventTypes.map((event, index) => {
          if (index !== eventIndex || event.triggerParameters === null) return event
          return {
            ...event,
            triggerParameters: {
              ...event.triggerParameters,
              fields: event.triggerParameters.fields.map((field, index) =>
                index === fieldIndex ? { ...field, ...patch } : field,
              ),
            },
          }
        }),
      ),
    )
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={
        props.sourceId === null
          ? zh
            ? '新建自定义事件'
            : 'New custom event'
          : zh
            ? '编辑事件来源'
            : 'Edit event source'
      }
      size="lg"
      dismissDisabled={action !== null}
      panelClassName="event-source-editor"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose} disabled={action !== null}>
            {zh ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!draftValid || action !== null || authoringLoading}
            onClick={() => void run('save')}
          >
            {action === 'save' ? (zh ? '保存中…' : 'Saving…') : zh ? '保存草稿' : 'Save draft'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!draftValid || action !== null || authoringLoading}
            onClick={() => void run('validate')}
            data-testid="event-source-validate"
          >
            {action === 'validate'
              ? zh
                ? '验证中…'
                : 'Validating…'
              : zh
                ? '运行样例'
                : 'Run fixture'}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!draftValid || action !== null || authoringLoading}
            onClick={() => void run('publish')}
            data-testid="event-source-publish"
          >
            {action === 'publish'
              ? zh
                ? '验证并发布中…'
                : 'Validating and publishing…'
              : zh
                ? '验证并发布'
                : 'Validate & publish'}
          </button>
        </>
      }
    >
      {authoringLoading ? <LoadingState /> : null}
      {authoring.isError ? <ErrorBanner error={authoring.error} /> : null}
      {error !== null ? <ErrorBanner error={error} /> : null}
      {validation !== null ? (
        <NoticeBanner tone="success" title={zh ? '契约成立' : 'Contract verified'} size="compact">
          {validation}
        </NoticeBanner>
      ) : null}

      <div className="employee-dialog-form event-source-editor__form">
        <section className="event-source-editor__section">
          <div>
            <span className="employee-node-panel__eyebrow">
              {zh ? '基本信息' : 'Source profile'}
            </span>
            <h3>{zh ? '这个来源是什么' : 'Describe the source'}</h3>
            <p>
              {zh
                ? '名称与说明会显示给所有订阅者。'
                : 'Names and descriptions are visible to every subscriber.'}
            </p>
          </div>
          <div className="event-source-editor__grid">
            <Field label={zh ? '名称' : 'Name'} required>
              <TextInput
                value={localized(form.displayName, props.language)}
                placeholder={zh ? '例如：内部问题状态' : 'For example: Internal issue status'}
                onChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    displayName: { 'zh-CN': value, 'en-US': value },
                  }))
                }
              />
            </Field>
            <Field label={zh ? '轮询周期（秒）' : 'Poll interval (seconds)'} required>
              <NumberInput
                value={form.pollIntervalSeconds}
                min={1}
                max={86_400}
                onChange={(value) =>
                  setForm((current) => ({ ...current, pollIntervalSeconds: value ?? 1 }))
                }
              />
            </Field>
            <div className="event-source-editor__wide">
              <Field label={zh ? '描述' : 'Description'} required>
                <TextArea
                  rows={2}
                  value={localized(form.description, props.language)}
                  placeholder={
                    zh
                      ? '说明这个来源观察哪个系统、用于发现什么变化'
                      : 'Describe the system observed and the changes this source detects'
                  }
                  onChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      description: { 'zh-CN': value, 'en-US': value },
                    }))
                  }
                />
              </Field>
            </div>
            <Field
              label={zh ? '什么情况算一条新事件' : 'What counts as a new event'}
              hint={
                zh
                  ? '两种规则都由平台生成去重键，脚本不能直接写事件库。'
                  : 'The platform generates dedupe identities in both modes; scripts never write the event store.'
              }
              group
            >
              <Select
                value={form.ingestionMode}
                onChange={(value) => setForm((current) => ({ ...current, ingestionMode: value }))}
                options={[
                  {
                    value: 'state-change',
                    label: zh ? '按状态版本去重' : 'Deduplicate state revisions',
                    description: zh
                      ? '同一个业务对象的同一版本只入库一次。'
                      : 'Store one event for each stable source revision.',
                  },
                  {
                    value: 'occurrence',
                    label: zh ? '按发生实例去重' : 'Deduplicate occurrences',
                    description: zh
                      ? '每次发生都需要来源侧稳定 occurrence ID。'
                      : 'Each occurrence needs a stable source-side occurrence ID.',
                  },
                ]}
              />
            </Field>
          </div>
        </section>

        <section className="event-source-editor__section">
          <div className="event-source-editor__section-heading">
            <div>
              <span className="employee-node-panel__eyebrow">
                {zh ? '事件合同' : 'Event contracts'}
              </span>
              <h3>{zh ? '这个来源会产生什么事件' : 'Define emitted events'}</h3>
              <p>
                {zh
                  ? '每种事件都有确定的 subject 和业务文案。'
                  : 'Every event has an exact subject type and business description.'}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() =>
                setForm((current) =>
                  withSynchronizedEventTypes(current, [
                    ...current.eventTypes,
                    initialEvent(nextEventKey(current.eventTypes)),
                  ]),
                )
              }
            >
              {zh ? '增加事件种类' : 'Add event type'}
            </button>
          </div>
          <div className="event-source-editor__events">
            {form.eventTypes.map((event, index) => (
              <div className="event-source-editor__event" key={`${index}:${event.eventKey}`}>
                <div className="event-source-editor__event-title">
                  <strong>{zh ? `事件 ${index + 1}` : `Event ${index + 1}`}</strong>
                  {form.eventTypes.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() =>
                        setForm((current) =>
                          withSynchronizedEventTypes(
                            current,
                            current.eventTypes.filter((_, itemIndex) => itemIndex !== index),
                          ),
                        )
                      }
                    >
                      {zh ? '移除' : 'Remove'}
                    </button>
                  ) : null}
                </div>
                <div className="event-source-editor__grid">
                  <Field label={zh ? '事件名称' : 'Event name'} required>
                    <TextInput
                      value={localized(event.displayName, props.language)}
                      placeholder={
                        zh ? '例如：问题状态发生变化' : 'For example: Issue status changed'
                      }
                      onChange={(value) =>
                        updateEvent(index, {
                          displayName: { 'zh-CN': value, 'en-US': value },
                        })
                      }
                    />
                  </Field>
                  <div className="event-source-editor__wide">
                    <Field label={zh ? '事件描述' : 'Event description'} required>
                      <TextArea
                        rows={2}
                        value={localized(event.description, props.language)}
                        placeholder={
                          zh
                            ? '说明什么变化发生时应生成这类事件'
                            : 'Describe the change that produces this event'
                        }
                        onChange={(value) =>
                          updateEvent(index, {
                            description: { 'zh-CN': value, 'en-US': value },
                          })
                        }
                      />
                    </Field>
                  </div>
                </div>
                <details className="event-source-editor__technical-details">
                  <summary>
                    {zh ? '平台生成的技术标识' : 'Platform-generated technical identifiers'}
                  </summary>
                  <dl>
                    <div>
                      <dt>eventKey</dt>
                      <dd>
                        <code>{event.eventKey}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>subjectType</dt>
                      <dd>
                        <code>{event.subjectTypeId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>payloadSchema</dt>
                      <dd>
                        <code>{event.payloadSchemaId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>deliveryClass</dt>
                      <dd>
                        <code>{event.deliveryClass}</code>
                      </dd>
                    </div>
                  </dl>
                </details>
                <div className="event-source-editor__parameter-contract">
                  <div className="event-source-editor__section-heading">
                    <div>
                      <strong>{zh ? '任务触发参数' : 'Work-start parameters'}</strong>
                      <p>
                        {zh
                          ? '只填写任务真正需要的值；每个参数的完整注入路径会实时显示。'
                          : 'Declare only values a task needs. Every full injection path is shown live.'}
                      </p>
                    </div>
                    {event.triggerParameters === null ? (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() =>
                          updateEvent(index, {
                            triggerParameters: {
                              namespace: '',
                              fields: [initialTriggerField()],
                            },
                          })
                        }
                      >
                        {zh ? '声明任务参数' : 'Declare parameters'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => updateEvent(index, { triggerParameters: null })}
                      >
                        {zh ? '不注入任务参数' : 'Remove parameter contract'}
                      </button>
                    )}
                  </div>
                  {event.triggerParameters !== null ? (
                    <>
                      <div className="event-source-editor__grid">
                        <Field label={zh ? '参数命名空间' : 'Parameter namespace'} required>
                          <TextInput
                            value={event.triggerParameters.namespace}
                            placeholder={
                              zh
                                ? `例如：${triggerNamespaceFromEventKey(event.eventKey)}`
                                : `For example: ${triggerNamespaceFromEventKey(event.eventKey)}`
                            }
                            onChange={(value) =>
                              updateEvent(index, {
                                triggerParameters: {
                                  ...event.triggerParameters!,
                                  namespace: value,
                                },
                              })
                            }
                          />
                        </Field>
                        <div className="event-source-editor__wide">
                          <small>
                            {zh
                              ? `同一事件的参数共用此前缀：trigger.${event.triggerParameters.namespace || '<命名空间>'}.*`
                              : `Parameters of this event share this prefix: trigger.${event.triggerParameters.namespace || '<namespace>'}.*`}
                          </small>
                        </div>
                      </div>
                      <div className="event-source-editor__parameter-list">
                        {event.triggerParameters.fields.map((field, fieldIndex) => (
                          <div className="event-source-editor__parameter" key={field.editorKey}>
                            <div className="event-source-editor__event-title">
                              <strong>
                                {zh ? `参数 ${fieldIndex + 1}` : `Parameter ${fieldIndex + 1}`}
                              </strong>
                              {event.triggerParameters!.fields.length > 1 ? (
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  onClick={() =>
                                    updateEvent(index, {
                                      triggerParameters: {
                                        ...event.triggerParameters!,
                                        fields: event.triggerParameters!.fields.filter(
                                          (_, index) => index !== fieldIndex,
                                        ),
                                      },
                                    })
                                  }
                                >
                                  {zh ? '移除' : 'Remove'}
                                </button>
                              ) : null}
                            </div>
                            <code className="event-source-editor__parameter-path">
                              {`trigger.${event.triggerParameters!.namespace || (zh ? '<命名空间>' : '<namespace>')}.${field.fieldId || (zh ? '<参数键>' : '<parameter-key>')}`}
                            </code>
                            <div className="event-source-editor__grid">
                              <Field label={zh ? '参数键' : 'Parameter key'} required>
                                <TextInput
                                  value={field.fieldId}
                                  placeholder={
                                    zh
                                      ? '例如：issue_id；脚本按这个键输出'
                                      : 'For example: issue_id; the program emits this key'
                                  }
                                  onChange={(value) =>
                                    updateTriggerField(index, fieldIndex, { fieldId: value })
                                  }
                                />
                              </Field>
                              <Field
                                label={zh ? '显示名称（界面用）' : 'Display name (UI only)'}
                                required
                              >
                                <TextInput
                                  value={localized(field.displayName, props.language)}
                                  placeholder={zh ? '例如：问题单 ID' : 'For example: Issue ID'}
                                  onChange={(value) =>
                                    updateTriggerField(index, fieldIndex, {
                                      displayName: { 'zh-CN': value, 'en-US': value },
                                    })
                                  }
                                />
                              </Field>
                              <div className="event-source-editor__wide">
                                <Field label={zh ? '参数说明' : 'Parameter description'} required>
                                  <TextInput
                                    value={localized(field.description, props.language)}
                                    placeholder={
                                      zh
                                        ? '说明任务拿到这个值后可以做什么'
                                        : 'Explain how a task can use this value'
                                    }
                                    onChange={(value) =>
                                      updateTriggerField(index, fieldIndex, {
                                        description: { 'zh-CN': value, 'en-US': value },
                                      })
                                    }
                                  />
                                </Field>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() =>
                          updateEvent(index, {
                            triggerParameters: {
                              ...event.triggerParameters!,
                              fields: [...event.triggerParameters!.fields, initialTriggerField()],
                            },
                          })
                        }
                      >
                        {zh ? '增加任务参数' : 'Add parameter'}
                      </button>
                    </>
                  ) : (
                    <small>
                      {zh
                        ? '这个事件只能唤醒已存在的关注者，不向新任务注入全局参数。'
                        : 'This event may wake existing subscribers but injects no global parameters into new work.'}
                    </small>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="event-source-editor__section">
          <div>
            <span className="employee-node-panel__eyebrow">
              {zh ? '执行程序' : 'Observer program'}
            </span>
            <h3>{zh ? '轮询脚本' : 'Polling program'}</h3>
            <p>
              {zh
                ? '平台把输入写入 AW_EVENT_INPUT_FILE；stdout 只能输出一个 aw-event-observer@1 JSON envelope。'
                : 'The platform writes input to AW_EVENT_INPUT_FILE. Stdout must contain one aw-event-observer@1 JSON envelope.'}
            </p>
          </div>
          <NoticeBanner
            tone="info"
            title={zh ? '固定执行边界' : 'Fixed execution boundary'}
            size="compact"
          >
            <code>
              {zh
                ? '输入：sourceRef + subjects + cursor + deadlineAt；输出：eventKey + subjectRef + occurredAt + sourceEventKey + sourceEventRevision + summary + 已声明的 triggerParameters。'
                : 'Input: sourceRef + subjects + cursor + deadlineAt. Output: eventKey + subjectRef + occurredAt + sourceEventKey + sourceEventRevision + summary + declared triggerParameters.'}
            </code>
          </NoticeBanner>
          <div className="event-source-editor__grid">
            <Field label={zh ? '脚本语言' : 'Program language'} group required>
              <Select
                value={form.language}
                onChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    language: value,
                    source: syncManagedObserverSource({
                      language: value,
                      source: current.source,
                      templateManaged: current.sourceTemplateManaged,
                      events: current.eventTypes,
                    }),
                  }))
                }
                options={[
                  { value: 'node', label: 'Node.js' },
                  { value: 'python', label: 'Python' },
                  { value: 'bash', label: 'Bash' },
                ]}
              />
            </Field>
            <Field label={zh ? '单次超时（秒）' : 'Run timeout (seconds)'} required>
              <NumberInput
                value={form.timeoutSeconds}
                min={1}
                max={1_800}
                onChange={(value) =>
                  setForm((current) => ({ ...current, timeoutSeconds: value ?? 1 }))
                }
              />
            </Field>
          </div>
          <details className="event-source-editor__technical-details">
            <summary>{zh ? '执行技术参数' : 'Execution technical settings'}</summary>
            <p>
              {zh
                ? `平台当前每批最多传入 ${form.batchSize} 个关注对象，事件去重模式为 ${form.ingestionMode}。`
                : `The platform currently passes at most ${form.batchSize} subjects per batch with ${form.ingestionMode} deduplication.`}
            </p>
          </details>
          <Field label={zh ? '脚本正文' : 'Program source'} required>
            <TextArea
              rows={18}
              monospace
              value={form.source}
              onChange={(value) =>
                setForm((current) => ({
                  ...current,
                  source: value,
                  sourceTemplateManaged: false,
                }))
              }
              data-testid="event-source-program"
            />
          </Field>
          <details
            className="event-source-editor__technical-details"
            open={validationSetupOpen}
            onToggle={(event) => setValidationSetupOpen(event.currentTarget.open)}
          >
            <summary>
              {zh ? '发布前验证（按需填写）' : 'Pre-publish validation (on demand)'}
            </summary>
            <p>
              {zh
                ? '测试对象只用于在验证或发布时真实运行一次脚本，不属于事件参数，也不会注入任务；保存草稿无需填写。'
                : 'The test object only runs the program during validation or publish. It is not an event parameter and is never injected into tasks. Drafts can be saved without it.'}
            </p>
            <div className="event-source-editor__grid">
              {[...new Set(form.eventTypes.map((event) => event.subjectTypeId))].map(
                (subjectTypeId) => (
                  <Field
                    key={subjectTypeId}
                    label={zh ? `测试对象（${subjectTypeId}）` : `Test object (${subjectTypeId})`}
                    hint={
                      zh
                        ? '填写来源系统中真实存在、可由脚本读取的对象 ID。'
                        : 'Enter a real object ID that the program can read from the source system.'
                    }
                  >
                    <TextInput
                      value={
                        form.eventTypes.find((event) => event.subjectTypeId === subjectTypeId)
                          ?.fixtureSubjectRef ?? ''
                      }
                      placeholder={zh ? '例如：ISSUE-1234' : 'For example: ISSUE-1234'}
                      onChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          eventTypes: current.eventTypes.map((event) =>
                            event.subjectTypeId === subjectTypeId
                              ? { ...event, fixtureSubjectRef: value }
                              : event,
                          ),
                        }))
                      }
                    />
                  </Field>
                ),
              )}
              <Field
                label={zh ? '起始游标（可选 JSON）' : 'Initial cursor (optional JSON)'}
                hint={
                  zh
                    ? '只影响本次验证；生产游标由平台独立持久化。'
                    : 'Only affects this validation run. Production cursors are persisted separately.'
                }
              >
                <TextArea
                  rows={3}
                  monospace
                  value={form.cursorJson}
                  onChange={(value) => setForm((current) => ({ ...current, cursorJson: value }))}
                />
              </Field>
            </div>
          </details>
        </section>
      </div>
    </Dialog>
  )
}
