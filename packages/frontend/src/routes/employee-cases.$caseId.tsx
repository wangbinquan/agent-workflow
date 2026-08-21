import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Card } from '@/components/Card'
import type {
  DigitalEmployeeDefinition,
  EmployeeTypePackage,
  LocalizedText,
} from '@/components/digital-employees/types'
import { localized, typeRefKey } from '@/components/digital-employees/types'
import { ResponsibilityGraph } from '@/components/digital-employees/ResponsibilityGraph'
import { ErrorBanner } from '@/components/ErrorBanner'
import { usePermission } from '@/hooks/useActor'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { Route as RootRoute } from './__root'

interface EmployeeCaseProjection {
  case: {
    id: string
    employeeRef: { id: string; revision: number }
    typeRef: { typeId: string; revision: number }
    state: 'active' | 'waiting' | 'blocked' | 'terminal'
    terminalKind: string | null
    blockReason: string | null
    currentWorkItemRef: string | null
    executionPolicyRevision: number
    revision: number
    createdAt: number
    updatedAt: number
  }
  employeeType: { displayName: LocalizedText; description: LocalizedText }
  contexts: Array<{
    id: string
    typeId: string
    schemaVersion: number
    revision: number
    lifecycleState: 'active' | 'waiting' | 'terminal'
    state: unknown
    artifactRefs: string[]
    updatedAt: number
  }>
  attention: Array<{
    id: string
    eventTypeRef: { id: string; revision: number }
    subject: { typeId: string; subjectRef: string }
    state: string
    displayName: LocalizedText | null
    description: LocalizedText | null
  }>
  inbox: Array<{
    id: string
    eventTypeRef: { id: string; revision: number }
    priority: number
    occurredAt: number
    summary: string
    state: string
    displayName: LocalizedText | null
    description: LocalizedText | null
  }>
  activeRound: ReactionRound | null
  rounds: ReactionRound[]
  channels: Array<{
    id: string
    state: string
    targetEmployeeRef: { id: string; revision: number }
    childCaseId: string | null
    invocationContractId: string
    results: Array<{ id: string; milestoneType: string; createdAt: number }>
  }>
  nextAction: null | {
    owner: 'current-user' | 'platform' | 'digital-employee'
    action: 'resolve-blocker' | 'schedule-next-reaction' | 'continue-automatically'
  }
}

interface ReactionRound {
  id: string
  workItemRef: string
  state: string
  executionRef: string | null
  attemptOrdinal: number
  createdAt: number
  updatedAt: number
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/employee-cases/$caseId',
  component: EmployeeCaseDetailPage,
})

function caseStatus(
  state: EmployeeCaseProjection['case']['state'],
  terminalKind: string | null,
  zh: boolean,
): { label: string; kind: StatusChipKind } {
  if (state === 'terminal') {
    const merged = terminalKind === 'merged'
    return {
      label: merged ? (zh ? '已合入' : 'Merged') : zh ? '已结束' : 'Finished',
      kind: merged ? 'success' : 'neutral',
    }
  }
  if (state === 'blocked') return { label: zh ? '需要处理' : 'Needs attention', kind: 'danger' }
  if (state === 'waiting') return { label: zh ? '等待事件' : 'Waiting for event', kind: 'info' }
  return { label: zh ? '正在工作' : 'Working', kind: 'success' }
}

function nextActionCopy(
  projection: EmployeeCaseProjection,
  zh: boolean,
): { tone: 'info' | 'warning' | 'success'; title: string; body: string } {
  if (projection.case.state === 'terminal') {
    return {
      tone: 'success',
      title:
        projection.case.terminalKind === 'merged'
          ? zh
            ? 'MR 已合入'
            : 'MR merged'
          : zh
            ? '工作已结束'
            : 'Work finished',
      body: zh
        ? '数字员工已停止关注这个工作对象，完整历史仍保留在本页。'
        : 'The employee stopped watching this work; the full history remains here.',
    }
  }
  if (projection.case.state === 'blocked') {
    return {
      tone: 'warning',
      title: zh ? '下一步：处理阻塞原因' : 'Next: resolve the blocker',
      body:
        projection.case.blockReason ??
        (zh ? '查看最近一轮的错误现场。' : 'Inspect the latest failed round.'),
    }
  }
  if (projection.nextAction?.owner === 'platform') {
    return {
      tone: 'info',
      title: zh
        ? '下一步：平台调度最高优先级事件'
        : 'Next: platform schedules the highest-priority event',
      body: zh
        ? '较低优先级事件会留在队列中，下一轮继续处理。'
        : 'Lower-priority events remain queued for the next reaction.',
    }
  }
  if (projection.case.state === 'waiting') {
    const watched = projection.attention
      .filter((binding) => binding.state === 'active' && binding.displayName !== null)
      .slice(0, 3)
      .map((binding) => localized(binding.displayName!, zh ? 'zh-CN' : 'en-US'))
    return {
      tone: 'info',
      title: zh ? '下一步：等待关注对象发生变化' : 'Next: wait for a watched change',
      body:
        watched.length === 0
          ? zh
            ? '当前不需要人工操作；收到新的权威事件后，数字员工会自动继续。'
            : 'No action is needed; the employee resumes after a new authoritative event.'
          : zh
            ? `平台正在关注：${watched.join('、')}。事件到达后会自动继续。`
            : `The platform is watching: ${watched.join(', ')}. Work resumes automatically when one arrives.`,
    }
  }
  return {
    tone: 'info',
    title: zh ? '下一步：数字员工自动继续' : 'Next: the employee continues automatically',
    body: zh
      ? '当前不需要人工操作；平台会在执行完成或收到新事件后继续。'
      : 'No human action is needed; execution resumes after the current work or a new event.',
  }
}

function businessStateLabel(state: string, zh: boolean): string {
  const labels: Record<string, readonly [string, string]> = {
    desired: ['准备关注', 'Preparing to watch'],
    active: ['进行中', 'Active'],
    'cancel-requested': ['正在停止关注', 'Stopping watch'],
    cancelled: ['已停止关注', 'Watch stopped'],
    pending: ['待处理', 'Pending'],
    claimed: ['处理中', 'Processing'],
    settled: ['已处理', 'Processed'],
    coalesced: ['已合并处理', 'Combined'],
    obsolete: ['已失效', 'Obsolete'],
    planned: ['准备执行', 'Preparing'],
    running: ['执行中', 'Running'],
    settling: ['正在确认结果', 'Confirming result'],
    completed: ['已完成', 'Completed'],
    failed: ['失败', 'Failed'],
    open: ['等待返回', 'Waiting'],
    satisfied: ['已返回', 'Returned'],
    detached: ['已结束等待', 'No longer waiting'],
  }
  const label = labels[state]
  return label === undefined ? (zh ? '状态已更新' : 'Status updated') : label[zh ? 0 : 1]
}

function contextFacts(
  registration: EmployeeTypePackage['contextTypes'][number] | undefined,
  state: unknown,
  language: string,
): Array<{ label: string; value: string }> {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return []
  const zh = language.startsWith('zh')
  const root = state as Record<string, unknown>
  const atPath = (path: string): unknown => {
    let current: unknown = root
    for (const segment of path.split('.')) {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return null
      current = (current as Record<string, unknown>)[segment]
    }
    return current
  }
  const fallbackFields = Object.entries(root)
    .filter(
      ([, value]) =>
        value === null ||
        ['string', 'number', 'boolean'].includes(typeof value) ||
        Array.isArray(value),
    )
    .slice(0, 4)
    .map(([path, value]) => ({
      path,
      label: {
        'zh-CN': path.replaceAll('_', ' '),
        'en-US': path.replaceAll('_', ' '),
      },
      format: Array.isArray(value) ? ('count' as const) : ('text' as const),
    }))
  const fields = registration?.projectionFields.length
    ? registration.projectionFields
    : fallbackFields
  const render = (
    value: unknown,
    format: EmployeeTypePackage['contextTypes'][number]['projectionFields'][number]['format'],
  ): string => {
    if (value === null || value === undefined || value === '') return '-'
    if (format === 'count') {
      if (Array.isArray(value)) return String(value.length)
      if (typeof value === 'object') return String(Object.keys(value).length)
      return typeof value === 'number' ? String(value) : '-'
    }
    if (format === 'short-hash') return typeof value === 'string' ? value.slice(0, 12) : '-'
    if (format === 'boolean') {
      return value === true ? (zh ? '是' : 'Yes') : value === false ? (zh ? '否' : 'No') : '-'
    }
    if (format === 'list') {
      return Array.isArray(value)
        ? value
            .filter(
              (item): item is string | number =>
                typeof item === 'string' || typeof item === 'number',
            )
            .join(zh ? '、' : ', ') || '-'
        : '-'
    }
    if (format === 'timestamp') {
      const date = new Date(typeof value === 'number' ? value : String(value))
      return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString(language)
    }
    if (typeof value === 'string') return value.slice(0, 240)
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return '-'
  }
  return fields.map((field) => ({
    label: localized(field.label, language),
    value: render(atPath(field.path), field.format),
  }))
}

function EmployeeCaseDetailPage(): ReactElement {
  const { caseId } = Route.useParams()
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const zh = language.startsWith('zh')
  const queryClient = useQueryClient()
  const canResume = usePermission('development-missions:retry')
  const [selectedWorkItemRef, setSelectedWorkItemRef] = useState<string | null>(null)
  const projection = useQuery<EmployeeCaseProjection>({
    queryKey: ['employee-case', caseId],
    queryFn: ({ signal }) =>
      api.get(`/api/employee-cases/${encodeURIComponent(caseId)}`, undefined, signal),
    refetchInterval: (query) => (query.state.data?.case.state === 'terminal' ? false : 3_000),
  })
  const typeRef = projection.data === undefined ? null : typeRefKey(projection.data.case.typeRef)
  const descriptor = useQuery<EmployeeTypePackage>({
    queryKey: ['digital-employee-type', typeRef, 'case'],
    enabled: typeRef !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/api/digital-employee-types/${encodeURIComponent(typeRef ?? '')}`,
        undefined,
        signal,
      ),
  })
  const employeeId = projection.data?.case.employeeRef.id ?? null
  const employee = useQuery<DigitalEmployeeDefinition>({
    queryKey: ['digital-employee', employeeId, 'case'],
    enabled: employeeId !== null,
    queryFn: ({ signal }) =>
      api.get(`/api/digital-employees/${encodeURIComponent(employeeId ?? '')}`, undefined, signal),
  })
  const employeeDirectory = useQuery<{ items: DigitalEmployeeDefinition[] }>({
    queryKey: ['digital-employees', 'case-collaboration-directory'],
    enabled: (projection.data?.channels.length ?? 0) > 0,
    queryFn: ({ signal }) => api.get('/api/digital-employees', undefined, signal),
  })
  const resume = useMutation({
    mutationFn: (): Promise<EmployeeCaseProjection> =>
      api.post(`/api/employee-cases/${encodeURIComponent(caseId)}/resume`),
    onSuccess: (updated) => {
      queryClient.setQueryData(['employee-case', caseId], updated)
      void queryClient.invalidateQueries({ queryKey: ['employee-case', caseId] })
    },
  })

  useEffect(() => {
    const current = projection.data?.case.currentWorkItemRef
    if (selectedWorkItemRef === null && current !== null && current !== undefined) {
      setSelectedWorkItemRef(current)
    }
  }, [projection.data?.case.currentWorkItemRef, selectedWorkItemRef])

  const orderedInbox = useMemo(
    () =>
      [...(projection.data?.inbox ?? [])].sort((left, right) => {
        if (left.state === 'pending' && right.state !== 'pending') return -1
        if (right.state === 'pending' && left.state !== 'pending') return 1
        return right.priority - left.priority || right.occurredAt - left.occurredAt
      }),
    [projection.data?.inbox],
  )

  if (projection.isPending) return <LoadingState />
  if (projection.isError) return <ErrorBanner error={projection.error} />
  const data = projection.data
  const status = caseStatus(data.case.state, data.case.terminalKind, zh)
  const next = nextActionCopy(data, zh)
  const selectedItem = descriptor.data?.authoringManifest.workItems.find(
    (item) => item.workItemRef === selectedWorkItemRef,
  )

  return (
    <div className="page page--operations employee-case-detail-page">
      <div className="operations-surface">
        <PageHeader
          className="operations-surface__header"
          title={
            employee.data?.published?.displayName ??
            employee.data?.name ??
            (zh ? '数字员工任务' : 'Digital employee task')
          }
          meta={<StatusChip kind={status.kind}>{status.label}</StatusChip>}
          actions={
            typeRef === null ? null : (
              <Link
                to="/digital-employees/$typeRef"
                params={{ typeRef }}
                search={{ view: 'employees' }}
                className="btn btn--sm"
              >
                {zh ? '查看员工配置' : 'View employee configuration'}
              </Link>
            )
          }
        >
          <p className="operations-surface__subtitle">
            {localized(data.employeeType.displayName, language)} ·{' '}
            {zh ? '持续负责到外部合入或结束' : 'Responsible until external merge or finish'}
          </p>
        </PageHeader>

        <div className="digital-employee-surface__body">
          <NoticeBanner
            tone={next.tone}
            title={next.title}
            action={
              data.case.state === 'blocked' && canResume ? (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={resume.isPending}
                  onClick={() => resume.mutate()}
                >
                  {resume.isPending
                    ? zh
                      ? '正在恢复…'
                      : 'Resuming…'
                    : zh
                      ? '已处理，继续工作'
                      : 'Resolved, continue work'}
                </button>
              ) : undefined
            }
          >
            {next.body}
          </NoticeBanner>
          {resume.isError ? <ErrorBanner error={resume.error} /> : null}

          {descriptor.isPending ? <LoadingState /> : null}
          {descriptor.isError ? <ErrorBanner error={descriptor.error} /> : null}
          {descriptor.data !== undefined ? (
            <section
              className="employee-map-section"
              aria-label={zh ? '职责进度' : 'Responsibility progress'}
            >
              <div className="employee-map-section__heading">
                <div>
                  <h2>
                    {zh ? '当前职责与完整生命周期' : 'Current responsibility and full lifecycle'}
                  </h2>
                  <p>
                    {zh
                      ? '高亮节点是当前或手动选中的工作项；流程结构在运行中不会改变。'
                      : 'The highlighted node is current or selected; the graph never changes at runtime.'}
                  </p>
                </div>
                <span className="employee-map-section__legend">
                  {data.case.currentWorkItemRef === null
                    ? zh
                      ? '等待下一步'
                      : 'Waiting for next step'
                    : zh
                      ? '当前工作项已高亮'
                      : 'Current work item highlighted'}
                </span>
              </div>
              <ResponsibilityGraph
                type={descriptor.data}
                language={language}
                selectedWorkItemRef={selectedWorkItemRef}
                onSelect={setSelectedWorkItemRef}
                mode="runtime"
              />
              {selectedItem !== undefined ? (
                <div className="work-item-contract-card employee-case-selected-contract">
                  <div>
                    <span>{zh ? '这个工作项收到什么' : 'What this work item receives'}</span>
                    <p>{localized(selectedItem.materialSummary, language)}</p>
                  </div>
                  <div>
                    <span>{zh ? '怎样才算完成' : 'Definition of done'}</span>
                    <p>{localized(selectedItem.completionStandard, language)}</p>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          <div className="employee-case-detail-grid">
            <section className="employee-node-panel">
              <header>
                <div>
                  <span className="employee-node-panel__eyebrow">
                    {zh ? '工作上下文' : 'Work context'}
                  </span>
                  <h2>{zh ? '这个员工目前知道什么' : 'What this employee currently knows'}</h2>
                  <p>
                    {zh
                      ? '上下文由每轮确定性产出更新。'
                      : 'Each deterministic output updates these contexts.'}
                  </p>
                </div>
              </header>
              <div className="employee-card-list">
                {data.contexts.map((context) => {
                  const registration = descriptor.data?.contextTypes.find(
                    (candidate) => candidate.typeId === context.typeId,
                  )
                  const facts = contextFacts(registration, context.state, language)
                  return (
                    <Card
                      key={context.id}
                      title={
                        registration === undefined
                          ? zh
                            ? '工作记录'
                            : 'Work record'
                          : localized(registration.displayName, language)
                      }
                      actions={
                        <StatusChip
                          kind={context.lifecycleState === 'active' ? 'success' : 'neutral'}
                        >
                          {context.lifecycleState === 'active'
                            ? zh
                              ? '使用中'
                              : 'Active'
                            : context.lifecycleState === 'waiting'
                              ? zh
                                ? '等待中'
                                : 'Waiting'
                              : zh
                                ? '已结束'
                                : 'Terminal'}
                        </StatusChip>
                      }
                    >
                      {registration === undefined ? null : (
                        <p className="employee-case-context-description">
                          {localized(registration.description, language)}
                        </p>
                      )}
                      {facts.length > 0 ? (
                        <dl className="employee-case-context-facts">
                          {facts.map((fact) => (
                            <div key={fact.label}>
                              <dt>{fact.label}</dt>
                              <dd>{fact.value}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                      {context.artifactRefs.length > 0 ? (
                        <div className="employee-case-artifacts">
                          <strong>{zh ? '工作材料' : 'Work artifacts'}</strong>
                          {context.artifactRefs.map((artifact) => (
                            <code key={artifact}>{artifact}</code>
                          ))}
                        </div>
                      ) : null}
                      <details className="employee-case-technical-details">
                        <summary>
                          {zh ? '查看完整技术记录' : 'View complete technical record'}
                        </summary>
                        <pre className="employee-case-json">
                          {JSON.stringify(context.state, null, 2)}
                        </pre>
                      </details>
                    </Card>
                  )
                })}
              </div>
            </section>

            <section className="employee-node-panel">
              <header>
                <div>
                  <span className="employee-node-panel__eyebrow">
                    {zh ? '关注范围' : 'Attention'}
                  </span>
                  <h2>{zh ? '它正在等待哪些结果' : 'What it is watching for'}</h2>
                  <p>
                    {zh
                      ? '有订阅时观察器运行；无人订阅时自动停止。'
                      : 'Observers run only while a subscription exists.'}
                  </p>
                </div>
              </header>
              <div className="node-tool-list">
                {data.attention.length === 0 ? (
                  <p className="node-tool-list__empty">
                    {zh ? '当前没有关注对象。' : 'No watched subjects.'}
                  </p>
                ) : (
                  data.attention.map((binding) => (
                    <article key={binding.id} className="node-tool-row">
                      <div>
                        <strong>
                          {binding.displayName === null
                            ? zh
                              ? '工作结果有更新'
                              : 'Work result updated'
                            : localized(binding.displayName, language)}
                        </strong>
                        <span>{binding.subject.subjectRef}</span>
                        {binding.description === null ? null : (
                          <small>{localized(binding.description, language)}</small>
                        )}
                      </div>
                      <StatusChip kind={binding.state === 'active' ? 'success' : 'neutral'}>
                        {binding.state === 'active'
                          ? zh
                            ? '关注中'
                            : 'Watching'
                          : businessStateLabel(binding.state, zh)}
                      </StatusChip>
                    </article>
                  ))
                )}
              </div>
            </section>
          </div>

          <section className="employee-node-panel">
            <header>
              <div>
                <span className="employee-node-panel__eyebrow">
                  {zh ? '事件队列' : 'Event queue'}
                </span>
                <h2>{zh ? '下一轮会先处理什么' : 'What the next reaction will process'}</h2>
                <p>
                  {zh
                    ? '待处理事件按优先级排列；同一时刻只运行一轮。'
                    : 'Pending events are ordered by priority; only one reaction runs at a time.'}
                </p>
              </div>
            </header>
            <div className="node-tool-list">
              {orderedInbox.length === 0 ? (
                <p className="node-tool-list__empty">
                  {zh ? '事件队列为空。' : 'The event queue is empty.'}
                </p>
              ) : (
                orderedInbox.map((event) => (
                  <article key={event.id} className="node-tool-row">
                    <div>
                      <strong>
                        {event.displayName === null
                          ? zh
                            ? '工作事件'
                            : 'Work event'
                          : localized(event.displayName, language)}
                      </strong>
                      <span>{event.summary}</span>
                      <small>
                        {new Date(event.occurredAt).toLocaleString()} · {zh ? '优先级' : 'Priority'}{' '}
                        {event.priority}
                      </small>
                    </div>
                    <StatusChip kind={event.state === 'pending' ? 'info' : 'neutral'}>
                      {businessStateLabel(event.state, zh)}
                    </StatusChip>
                  </article>
                ))
              )}
            </div>
          </section>

          <div className="employee-case-detail-grid">
            <section className="employee-node-panel">
              <header>
                <div>
                  <span className="employee-node-panel__eyebrow">
                    {zh ? '执行记录' : 'Reactions'}
                  </span>
                  <h2>{zh ? '每一轮做了什么' : 'What each reaction did'}</h2>
                </div>
              </header>
              <div className="node-tool-list">
                {[...data.rounds].reverse().map((round) => {
                  const item = descriptor.data?.authoringManifest.workItems.find(
                    (candidate) => candidate.workItemRef === round.workItemRef,
                  )
                  return (
                    <article key={round.id} className="node-tool-row">
                      <div>
                        <strong>
                          {item === undefined
                            ? zh
                              ? '员工工作项'
                              : 'Employee work item'
                            : localized(item.label, language)}
                        </strong>
                        <span>
                          {zh
                            ? `第 ${round.attemptOrdinal + 1} 次尝试`
                            : `Attempt ${round.attemptOrdinal + 1}`}
                        </span>
                      </div>
                      {round.executionRef === null ? (
                        <StatusChip kind={round.state === 'failed' ? 'danger' : 'neutral'}>
                          {businessStateLabel(round.state, zh)}
                        </StatusChip>
                      ) : (
                        <Link
                          to="/tasks/$id"
                          params={{ id: round.executionRef }}
                          className="btn btn--sm"
                        >
                          {zh ? '查看执行' : 'View execution'}
                        </Link>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>

            <section className="employee-node-panel">
              <header>
                <div>
                  <span className="employee-node-panel__eyebrow">
                    {zh ? '员工协作' : 'Employee collaboration'}
                  </span>
                  <h2>{zh ? '委托出去的工作' : 'Delegated work'}</h2>
                </div>
              </header>
              <div className="node-tool-list">
                {data.channels.length === 0 ? (
                  <p className="node-tool-list__empty">
                    {zh ? '当前没有委托其他数字员工。' : 'No delegated employee work.'}
                  </p>
                ) : (
                  data.channels.map((channel) => (
                    <article key={channel.id} className="node-tool-row">
                      <div>
                        <strong>
                          {employeeDirectory.data?.items.find(
                            (candidate) => candidate.id === channel.targetEmployeeRef.id,
                          )?.name ?? (zh ? '协作数字员工' : 'Collaborating employee')}
                        </strong>
                        <span>
                          {channel.state === 'satisfied'
                            ? zh
                              ? '协作工作已返回'
                              : 'Delegated work returned'
                            : channel.state === 'failed'
                              ? zh
                                ? '协作工作失败'
                                : 'Delegated work failed'
                              : zh
                                ? '正在等待协作结果'
                                : 'Waiting for delegated result'}
                        </span>
                        <small>
                          {zh
                            ? `${channel.results.length} 个返回事件`
                            : `${channel.results.length} result events`}
                        </small>
                      </div>
                      {channel.childCaseId === null ? (
                        <StatusChip kind="info">{businessStateLabel(channel.state, zh)}</StatusChip>
                      ) : (
                        <Link
                          to="/tasks/employee-cases/$caseId"
                          params={{ caseId: channel.childCaseId }}
                          className="btn btn--sm"
                        >
                          {zh ? '查看被委托任务' : 'View delegated task'}
                        </Link>
                      )}
                    </article>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
