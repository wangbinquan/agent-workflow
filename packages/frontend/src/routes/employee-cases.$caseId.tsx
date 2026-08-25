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
import {
  EmployeeCapabilityPanorama,
  type ResponsibilityDispatchNode,
  type ResponsibilityReviewGate,
} from '@/components/digital-employees/EmployeeCapabilityPanorama'
import { ErrorBanner } from '@/components/ErrorBanner'
import { usePermission } from '@/hooks/useActor'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { Route as RootRoute } from './__root'

export interface EmployeeCaseProjection {
  case: {
    id: string
    name: string
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
  capabilityActivation: {
    displayName: string
    jobTemplateRef: { id: string; revision: number }
    activeWorkItemRefs: string[]
    executionOptions: Record<string, boolean>
    exactAdapterBindings: DigitalEmployeeDefinition['definition']['exactAdapterBindings']
    exactOrderedDispatchConfigurations: DigitalEmployeeDefinition['definition']['exactOrderedDispatchConfigurations']
  }
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
  reviewGates?: Array<{
    parentWorkItemRef: string
    optionRef: string
    state: 'not-reached' | 'skipped' | 'planning' | 'waiting' | 'approved' | 'failed'
    executionRef: string | null
  }>
  channels: Array<{
    id: string
    state: string
    targetEmployeeRef: { id: string; revision: number }
    childCaseId: string | null
    invocationContractId: string
    results: Array<{ id: string; milestoneType: string; createdAt: number }>
  }>
  nextAction:
    | null
    | { owner: 'current-user'; action: 'resolve-blocker' }
    | {
        owner: 'current-user'
        action: 'complete-human-review'
        executionRef: string
      }
    | { owner: 'platform'; action: 'schedule-next-reaction' }
    | { owner: 'digital-employee'; action: 'continue-automatically' }
}

interface ReactionRound {
  id: string
  workItemRef: string
  state: string
  executionRef: string | null
  toolRef: { id: string; revision: number } | null
  workContractRef: { contractId: string; version: number }
  inputContextRefsJson: string
  planJson: string
  outputJson: string | null
  attemptOrdinal: number
  createdAt: number
  updatedAt: number
  settledAt: number | null
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

export function nextActionCopy(
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
  if (projection.nextAction?.action === 'complete-human-review') {
    return {
      tone: 'warning',
      title: zh ? '下一步：完成人工评审' : 'Next: complete the human review',
      body: zh
        ? '打开待评审的执行 Session，提交评审决定后数字员工会自动继续。'
        : 'Open the pending execution session and submit a review decision; the employee then continues automatically.',
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

function parseJsonValue(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function roundVisualState(
  state: string | undefined,
): 'running' | 'failed' | 'completed' | 'waiting' | 'neutral' {
  if (state === 'planned' || state === 'running' || state === 'settling') return 'running'
  if (state === 'failed') return 'failed'
  if (state === 'completed') return 'completed'
  if (state === 'obsolete') return 'neutral'
  return 'waiting'
}

export function runningRoundTaskTarget(
  round: { state: string; executionRef: string | null } | undefined,
): { to: '/tasks/$id'; params: { id: string } } | null {
  if (
    round === undefined ||
    round.executionRef === null ||
    roundVisualState(round.state) !== 'running'
  ) {
    return null
  }
  return { to: '/tasks/$id', params: { id: round.executionRef } }
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
  const navigate = Route.useNavigate()
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const zh = language.startsWith('zh')
  const queryClient = useQueryClient()
  const canResume = usePermission('development-missions:retry')
  const [selectedWorkItemRef, setSelectedWorkItemRef] = useState<string | null>(null)
  const [selectedReviewOptionRef, setSelectedReviewOptionRef] = useState<string | null>(null)
  const [selectedDispatchNodeKey, setSelectedDispatchNodeKey] = useState<string | null>(null)
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null)
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
  const employeeDirectory = useQuery<{ items: DigitalEmployeeDefinition[] }>({
    queryKey: ['digital-employees', 'case-collaboration-directory'],
    enabled: (projection.data?.channels.length ?? 0) > 0,
    queryFn: ({ signal }) => api.get('/api/digital-employees/launchable', undefined, signal),
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

  useEffect(() => {
    const rounds = projection.data?.rounds ?? []
    if (selectedRoundId === null && rounds.length > 0) {
      setSelectedRoundId(rounds.at(-1)?.id ?? null)
    }
  }, [projection.data?.rounds, selectedRoundId])

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
  const chronologicalRounds = [...data.rounds].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  )
  const latestRoundByWorkItem = new Map<string, ReactionRound>()
  for (const round of chronologicalRounds) latestRoundByWorkItem.set(round.workItemRef, round)
  const activeWorkItemRefs = new Set(data.capabilityActivation.activeWorkItemRefs)
  const runtimeAdapterSlotState = (target: { laneId: string; slotRef: string }) => {
    const binding = data.capabilityActivation.exactAdapterBindings.find(
      (candidate) => candidate.laneId === target.laneId && candidate.slotRef === target.slotRef,
    )
    if (binding === undefined) {
      return {
        state: 'missing' as const,
        detail: zh ? '此任务未冻结企业连接' : 'No enterprise connection was frozen for this task',
        compactDetail: zh ? '未冻结' : 'Not frozen',
      }
    }
    const exactRef = `${binding.adapterRef.id}@${binding.adapterRef.revision}`
    return {
      state: 'configured' as const,
      detail: zh ? `任务冻结版本：${exactRef}` : `Task-frozen revision: ${exactRef}`,
      compactDetail: `v${binding.adapterRef.revision}`,
    }
  }
  const runtimeToolState = (
    item: EmployeeTypePackage['authoringManifest']['workItems'][number],
  ) => {
    const round = latestRoundByWorkItem.get(item.workItemRef)
    const state = roundVisualState(round?.state)
    const active = activeWorkItemRefs.has(item.workItemRef)
    const detail =
      round === undefined
        ? zh
          ? '尚未进入'
          : 'Not reached yet'
        : businessStateLabel(round.state, zh)
    return {
      active,
      state,
      detail,
      compactDetail: detail,
    }
  }
  const runtimeReviewToolState = (gate: ResponsibilityReviewGate) => {
    const projection = (data.reviewGates ?? []).find(
      (candidate) =>
        candidate.parentWorkItemRef === gate.parentWorkItemRef &&
        candidate.optionRef === gate.optionRef,
    )
    const active = data.capabilityActivation.executionOptions[gate.optionRef] === true
    if (projection?.state === 'waiting') {
      return {
        active,
        state: 'waiting' as const,
        detail: zh ? '等待人工审核' : 'Awaiting human review',
        compactDetail: zh ? '等待审核' : 'Awaiting review',
      }
    }
    if (projection?.state === 'approved') {
      return {
        active,
        state: 'completed' as const,
        detail: zh ? '已批准并继续实现' : 'Approved; implementation continued',
        compactDetail: zh ? '已批准' : 'Approved',
      }
    }
    if (projection?.state === 'failed') {
      return {
        active,
        state: 'failed' as const,
        detail: zh ? '评审分支执行失败' : 'Review branch failed',
        compactDetail: zh ? '失败' : 'Failed',
      }
    }
    if (projection?.state === 'skipped') {
      return {
        active,
        state: 'neutral' as const,
        detail: zh ? '本任务未启用，已跳过' : 'Not enabled for this task; skipped',
        compactDetail: zh ? '已跳过' : 'Skipped',
      }
    }
    return {
      active,
      state: 'neutral' as const,
      detail:
        projection?.state === 'planning'
          ? zh
            ? '正在形成待审核计划'
            : 'Preparing the plan for review'
          : zh
            ? '尚未到达'
            : 'Not reached yet',
      compactDetail:
        projection?.state === 'planning'
          ? zh
            ? '形成计划中'
            : 'Planning'
          : zh
            ? '尚未到达'
            : 'Not reached',
    }
  }
  const routeRound = (
    destinationWorkItemRef: string,
    routeRef: string,
  ): ReactionRound | undefined =>
    [...chronologicalRounds].reverse().find((round) => {
      if (round.workItemRef !== destinationWorkItemRef) return false
      const plan = parseJsonValue(round.planJson)
      return (
        plan !== null &&
        typeof plan === 'object' &&
        !Array.isArray(plan) &&
        (plan as Record<string, unknown>).toolSlotRef === routeRef
      )
    })
  const runtimeDispatchNodes: ResponsibilityDispatchNode[] =
    data.capabilityActivation.exactOrderedDispatchConfigurations.flatMap((configuration) =>
      configuration.routes.map((route, index) => {
        const latest = routeRound(route.destinationWorkItemRef, route.routeRef)
        const visualState = roundVisualState(latest?.state)
        return {
          key: `${configuration.classifierWorkItemRef}/${route.routeRef}`,
          classifierWorkItemRef: configuration.classifierWorkItemRef,
          destinationWorkItemRef: route.destinationWorkItemRef,
          routeRef: route.routeRef,
          displayName: route.displayName,
          priority: index + 1,
          configured: route.registrationRef !== null,
          state: visualState,
          detail:
            latest === undefined
              ? zh
                ? '等待归类产出'
                : 'Waiting for classifier output'
              : businessStateLabel(latest.state, zh),
        }
      }),
    ) ?? []
  const selectedRound = chronologicalRounds.find((round) => round.id === selectedRoundId) ?? null
  const selectedRoundItem = descriptor.data?.authoringManifest.workItems.find(
    (item) => item.workItemRef === selectedRound?.workItemRef,
  )
  const selectedRoundPlan = selectedRound === null ? null : parseJsonValue(selectedRound.planJson)
  const selectedRoundOutput =
    selectedRound === null ? null : parseJsonValue(selectedRound.outputJson)

  return (
    <div className="page page--operations employee-case-detail-page">
      <div className="operations-surface">
        <PageHeader
          className="operations-surface__header"
          title={data.case.name}
          meta={<StatusChip kind={status.kind}>{status.label}</StatusChip>}
          actions={
            typeRef === null ? null : (
              <Link
                to="/digital-employees/$typeRef"
                params={{ typeRef }}
                search={{
                  view: 'jobs',
                  jobTemplateId: data.capabilityActivation.jobTemplateRef.id,
                }}
                className="btn btn--sm"
              >
                {zh ? '查看岗位模板' : 'View job template'}
              </Link>
            )
          }
        >
          <p className="operations-surface__subtitle">
            {localized(data.employeeType.displayName, language)} ·{' '}
            {data.capabilityActivation.displayName}
          </p>
        </PageHeader>

        <div className="digital-employee-surface__body">
          <NoticeBanner
            tone={next.tone}
            title={next.title}
            action={
              data.nextAction?.action === 'complete-human-review' ? (
                <Link
                  to="/tasks/$id"
                  params={{ id: data.nextAction.executionRef }}
                  className="btn btn--sm btn--primary"
                >
                  {zh ? '继续人工评审' : 'Continue human review'}
                </Link>
              ) : data.case.state === 'blocked' && canResume ? (
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
                  <h2>{zh ? '数字员工实际能力图' : 'Active digital employee capability map'}</h2>
                  <p>
                    {zh
                      ? '按任务冻结的员工能力与执行选项裁剪；已完成节点显示为绿色，正在执行的节点持续闪烁。'
                      : 'The map is cropped to this task’s frozen active capabilities and options. Completed nodes are green and the running node pulses.'}
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
              <EmployeeCapabilityPanorama
                type={descriptor.data}
                language={language}
                selectedWorkItemRef={selectedWorkItemRef}
                selectedReviewOptionRef={selectedReviewOptionRef}
                onSelect={(workItemRef) => {
                  const target = runningRoundTaskTarget(latestRoundByWorkItem.get(workItemRef))
                  if (target !== null) {
                    void navigate(target)
                    return
                  }
                  setSelectedDispatchNodeKey(null)
                  setSelectedReviewOptionRef(null)
                  setSelectedWorkItemRef(workItemRef)
                }}
                onSelectReviewGate={(gate) => {
                  setSelectedDispatchNodeKey(null)
                  setSelectedWorkItemRef(gate.parentWorkItemRef)
                  setSelectedReviewOptionRef(gate.optionRef)
                }}
                onConfigureIngress={(ingress) =>
                  ingress.configurationSurface === 'task-creation'
                    ? void navigate({ to: '/tasks/new', search: { kind: 'digital-employee' } })
                    : void navigate({ to: '/events', search: { tab: 'subscriptions' } })
                }
                dispatchNodes={runtimeDispatchNodes}
                selectedDispatchNodeKey={selectedDispatchNodeKey}
                onSelectDispatchNode={(node) => {
                  const latest = routeRound(node.destinationWorkItemRef, node.routeRef)
                  const target = runningRoundTaskTarget(latest)
                  if (target !== null) {
                    void navigate(target)
                    return
                  }
                  setSelectedReviewOptionRef(null)
                  setSelectedDispatchNodeKey(node.key)
                  setSelectedWorkItemRef(node.destinationWorkItemRef)
                  if (latest !== undefined) setSelectedRoundId(latest.id)
                }}
                toolState={runtimeToolState}
                reviewToolState={runtimeReviewToolState}
                adapterSlotState={runtimeAdapterSlotState}
                title={zh ? '实际能力与运行状态' : 'Active capabilities and runtime state'}
                description={
                  zh
                    ? '同一张岗位职责图展示未开始、等待、执行中、完成和失败；点击节点查看契约，点击任务流水查看每次真实执行。'
                    : 'The same job map shows not started, waiting, running, completed, and failed duties. Select a node for its contract and a timeline entry for each actual execution.'
                }
                legend={
                  zh
                    ? '蓝色闪烁执行中 · 绿色已完成 · 红色失败'
                    : 'Pulsing blue running · green completed · red failed'
                }
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
                  {selectedItem.humanReview?.optionRef === selectedReviewOptionRef ? (
                    <div
                      className="work-item-contract-card__review"
                      data-testid="employee-case-review-gate-detail"
                      tabIndex={-1}
                    >
                      <span>{localized(selectedItem.humanReview.label, language)}</span>
                      <p>{localized(selectedItem.humanReview.description, language)}</p>
                      <code>
                        {selectedItem.humanReview.artifactPort} ·{' '}
                        {
                          runtimeReviewToolState({
                            parentWorkItemRef: selectedItem.workItemRef,
                            optionRef: selectedItem.humanReview.optionRef,
                            label: selectedItem.humanReview.label,
                            description: selectedItem.humanReview.description,
                          }).detail
                        }
                      </code>
                    </div>
                  ) : null}
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

          <>
            <section
              className="employee-node-panel employee-execution-history"
              data-testid="employee-work-timeline"
            >
              <header>
                <div>
                  <span className="employee-node-panel__eyebrow">
                    {zh ? '任务流水 · 时间轴' : 'Task execution timeline'}
                  </span>
                  <h2>{zh ? '历史执行过的所有节点' : 'Every historically executed node'}</h2>
                  <p>
                    {zh
                      ? '按实际发生顺序保留 Agent、Workflow、脚本和平台节点。点击阶段查看冻结输入、确定性输出及执行 session。'
                      : 'Agent, workflow, program, and platform nodes are kept in actual order. Select a stage for its frozen input, deterministic output, and execution session.'}
                  </p>
                </div>
              </header>
              <div className="employee-execution-timeline-layout">
                <ol className="employee-execution-timeline">
                  {chronologicalRounds.length === 0 ? (
                    <li className="employee-execution-timeline__empty">
                      {zh ? '尚未产生执行阶段。' : 'No execution stage yet.'}
                    </li>
                  ) : (
                    chronologicalRounds.map((round, index) => {
                      const item = descriptor.data?.authoringManifest.workItems.find(
                        (candidate) => candidate.workItemRef === round.workItemRef,
                      )
                      const active = round.id === selectedRoundId
                      return (
                        <li key={round.id}>
                          <button
                            type="button"
                            className={`employee-execution-timeline__step${active ? ' employee-execution-timeline__step--active' : ''}`}
                            aria-pressed={active}
                            onClick={() => {
                              setSelectedRoundId(round.id)
                              setSelectedDispatchNodeKey(null)
                              setSelectedWorkItemRef(round.workItemRef)
                            }}
                          >
                            <b>{index + 1}</b>
                            <span>
                              <strong>
                                {item === undefined
                                  ? zh
                                    ? '员工工作项'
                                    : 'Employee work item'
                                  : localized(item.label, language)}
                              </strong>
                              <small>
                                {new Date(round.createdAt).toLocaleString(language)} ·{' '}
                                {zh
                                  ? `第 ${round.attemptOrdinal + 1} 次尝试`
                                  : `Attempt ${round.attemptOrdinal + 1}`}
                              </small>
                            </span>
                            <StatusChip
                              kind={
                                round.state === 'failed'
                                  ? 'danger'
                                  : round.state === 'completed'
                                    ? 'success'
                                    : roundVisualState(round.state) === 'running'
                                      ? 'info'
                                      : 'neutral'
                              }
                            >
                              {businessStateLabel(round.state, zh)}
                            </StatusChip>
                          </button>
                        </li>
                      )
                    })
                  )}
                </ol>
                <div className="employee-execution-stage-detail">
                  {selectedRound === null ? (
                    <p className="node-tool-list__empty">
                      {zh
                        ? '选择一个阶段查看执行现场。'
                        : 'Select a stage to inspect its execution.'}
                    </p>
                  ) : (
                    <>
                      <header>
                        <div>
                          <span>{zh ? '当前选择的阶段' : 'Selected stage'}</span>
                          <h3>
                            {selectedRoundItem === undefined
                              ? selectedRound.workItemRef
                              : localized(selectedRoundItem.label, language)}
                          </h3>
                          <p>
                            {selectedRound.workContractRef.contractId}@
                            {selectedRound.workContractRef.version} ·{' '}
                            {selectedRound.toolRef === null
                              ? zh
                                ? '平台节点'
                                : 'Platform node'
                              : `${selectedRound.toolRef.id}@${selectedRound.toolRef.revision}`}
                          </p>
                        </div>
                        {selectedRound.executionRef === null ? null : (
                          <Link
                            to="/tasks/$id"
                            params={{ id: selectedRound.executionRef }}
                            className="btn btn--sm btn--primary"
                          >
                            {zh ? '查看执行 Session' : 'View execution session'}
                          </Link>
                        )}
                      </header>
                      <div className="employee-execution-io-grid">
                        <section>
                          <span>{zh ? '冻结输入 / 脚本输入' : 'Frozen input / program input'}</span>
                          <pre>{JSON.stringify(selectedRoundPlan, null, 2)}</pre>
                        </section>
                        <section>
                          <span>
                            {zh ? '确定性输出 / 脚本输出' : 'Deterministic output / program output'}
                          </span>
                          <pre>
                            {selectedRoundOutput === null
                              ? zh
                                ? '当前阶段尚未产生输出。'
                                : 'This stage has not produced output yet.'
                              : JSON.stringify(selectedRoundOutput, null, 2)}
                          </pre>
                        </section>
                      </div>
                      <details className="employee-case-technical-details">
                        <summary>
                          {zh ? '查看输入 Context 精确版本' : 'View exact input context revisions'}
                        </summary>
                        <pre className="employee-case-json">
                          {JSON.stringify(
                            parseJsonValue(selectedRound.inputContextRefsJson),
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    </>
                  )}
                </div>
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
          </>
        </div>
      </div>
    </div>
  )
}
