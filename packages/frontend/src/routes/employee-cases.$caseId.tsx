import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { CachedRepo, CaseMembers, TaskLaunchOrigin } from '@agent-workflow/shared'
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
import {
  CASE_MEMBERS_PAGE_QUERY_KEY,
  CaseMembersDialogButton,
} from '@/components/digital-employees/CaseMembersDialogButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { usePermission, useAuthSessionRevision } from '@/hooks/useActor'
import { useTasksSync } from '@/hooks/useTasksSync'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { PageSectionLink, PageSectionNav, type PageSectionGroup } from '@/components/PageSectionNav'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import {
  validateEmployeeCaseDetailSearch,
  withEmployeeCaseDetailTab,
  type EmployeeCaseDetailTab,
} from '@/lib/employee-case-detail-tabs'
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
    launchOrigin: TaskLaunchOrigin
    revision: number
    createdAt: number
    updatedAt: number
    maxDurationMs: number | null
    consumedDurationMs: number
    maxTotalTokens: number | null
    consumedTotalTokens: number
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
  detail: {
    schemaVersion: 1
    input: {
      source: TaskLaunchOrigin
      ingressRef: string | null
      kind: 'body' | 'files' | 'body-and-files' | 'external-id' | 'event' | 'unknown'
      subjectRef: string | null
      repositoryRef: string | null
      body: string | null
      externalId: string | null
      uploads: Array<{
        artifactRef: string
        originalName: string
        placement: 'repository' | 'temporary'
        targetPath: string | null
      }>
      executionOptions: Record<string, boolean>
      advancedOptions: Record<string, string>
    }
    workspace: null | {
      repositoryRef: string
      cachedRepositoryRef: string
      baselineSha: string
      targetBranch: string
      sourceBranch: string
      remoteHeadSha: string | null
      state: 'active' | 'published' | 'released'
    }
    changeCandidate: null | {
      status: 'prepared' | 'committed' | 'published' | 'obsolete'
      candidateRef: string
      baselineSha: string
      treeOid: string
      summary: string
      changedPaths: string[]
      commitSha: string | null
    }
    delivery: null | {
      kind: 'merge-request'
      status: 'active' | 'merged' | 'closed'
      ref: string
      providerRef: string | null
      webUrl: string | null
      repositoryRef: string | null
      sourceBranch: string | null
      targetBranch: string | null
      headSha: string
      targetSha: string | null
      mergedCommitSha: string | null
      draft: boolean
      mergeableState: 'mergeable' | 'conflict' | 'unknown'
      readyToMerge: boolean
      approvalHold: boolean | null
      unresolvedReviewCount: number
      relatedRegionRefs: string[]
      relatedWorkItemRefs: string[]
    }
    artifacts: Array<{
      ref: string
      sources: Array<
        | { kind: 'input' }
        | { kind: 'context'; contextId: string }
        | { kind: 'round'; roundId: string; executionRef: string | null }
      >
    }>
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
  validateSearch: validateEmployeeCaseDetailSearch,
  remountDeps: ({ params }) => params,
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
    merged: ['已合入', 'Merged'],
    closed: ['已关闭', 'Closed'],
    published: ['已发布', 'Published'],
    released: ['已释放', 'Released'],
    prepared: ['已准备', 'Prepared'],
    committed: ['已提交', 'Committed'],
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

function inputKindLabel(
  kind: EmployeeCaseProjection['detail']['input']['kind'],
  zh: boolean,
): string {
  const labels: Record<
    EmployeeCaseProjection['detail']['input']['kind'],
    readonly [string, string]
  > = {
    body: ['需求描述', 'Description'],
    files: ['上传文件', 'Uploaded files'],
    'body-and-files': ['描述与文件', 'Description and files'],
    'external-id': ['外部编号', 'External ID'],
    event: ['事件触发', 'Event trigger'],
    unknown: ['历史输入', 'Historical input'],
  }
  return labels[kind][zh ? 0 : 1]
}

function launchOriginLabel(origin: TaskLaunchOrigin, zh: boolean): string {
  const labels: Record<TaskLaunchOrigin, readonly [string, string]> = {
    manual: ['手动创建', 'Manual'],
    scheduled: ['定时任务', 'Scheduled'],
    event: ['事件中心', 'Event Center'],
    webhook: ['Webhook', 'Webhook'],
    api: ['API', 'API'],
  }
  return labels[origin][zh ? 0 : 1]
}

function inputSummary(input: EmployeeCaseProjection['detail']['input'], zh: boolean): string {
  if (input.kind === 'external-id' && input.externalId !== null) return input.externalId
  if (input.body !== null) {
    const normalized = input.body.replace(/\s+/g, ' ').trim()
    return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized
  }
  if (input.uploads.length > 0) {
    return zh ? `${input.uploads.length} 个已接收文件` : `${input.uploads.length} received files`
  }
  if (input.subjectRef !== null) return input.subjectRef
  return zh ? '此历史任务没有结构化输入' : 'No structured input is available for this task'
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
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const zh = language.startsWith('zh')
  const queryClient = useQueryClient()
  const authRevision = useAuthSessionRevision()
  // RFC-330 —— 订阅统一列表频道：`employee-case.members.changed` 帧让本页投影与成员
  // 查询失效（owner 转移 / 成员变更后 canOperate 与恢复按钮随之收敛，不必刷新）。
  useTasksSync()
  const canResumePoint = usePermission('development-missions:retry')
  // RFC-330 D19 —— 恢复按钮 = 权限点 ∧ 成员面的 canOperate（observer 只能看）。
  // 成员面尚未取到 / 取失败时**不**渲染按钮：这是一个会发起写的控件，不能靠乐观值。
  const members = useQuery<CaseMembers>({
    queryKey: CASE_MEMBERS_PAGE_QUERY_KEY(caseId, authRevision),
    queryFn: ({ signal }) =>
      api.get(`/api/employee-cases/${encodeURIComponent(caseId)}/members`, undefined, signal),
  })
  const canResume = canResumePoint && members.data?.canOperate === true
  const tab: EmployeeCaseDetailTab = search.tab ?? 'overview'
  const [selectedWorkItemRef, setSelectedWorkItemRef] = useState<string | null>(null)
  const [selectedReviewOptionRef, setSelectedReviewOptionRef] = useState<string | null>(null)
  const [selectedDispatchNodeKey, setSelectedDispatchNodeKey] = useState<string | null>(null)
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null)
  const [inputInspectorOpen, setInputInspectorOpen] = useState(false)
  const inputInspectorTitleRef = useRef<HTMLHeadingElement | null>(null)
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
  const cachedRepositoryRef =
    projection.data?.detail.workspace?.cachedRepositoryRef ??
    projection.data?.detail.input.repositoryRef ??
    null
  const repositories = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos', 'employee-case-detail'],
    enabled: cachedRepositoryRef !== null,
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
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
    if (search.tab !== undefined) return
    void navigate({
      replace: true,
      search: (previous) => withEmployeeCaseDetailTab(previous, 'overview'),
    })
  }, [navigate, search.tab])

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
  const detail = data.detail
  const delivery = detail.delivery
  const repository = repositories.data?.items.find(
    (candidate) =>
      candidate.id === detail.workspace?.cachedRepositoryRef ||
      candidate.id === detail.input.repositoryRef,
  )
  const repositoryLabel =
    repository?.urlRedacted ??
    detail.workspace?.repositoryRef ??
    detail.input.repositoryRef ??
    (zh ? '工作区准备后确定' : 'Determined when the workspace is prepared')
  const targetBranch = detail.workspace?.targetBranch ?? repository?.defaultBranch ?? null
  const sourceBranch =
    detail.workspace?.sourceBranch ?? detail.input.advancedOptions['working-branch'] ?? null
  const targetBranchPlanned = detail.workspace === null
  const detailSectionGroups: PageSectionGroup<EmployeeCaseDetailTab>[] = [
    {
      key: 'case',
      label: zh ? '任务' : 'Task',
      items: [
        {
          key: 'overview',
          label: zh ? '概览' : 'Overview',
          description: zh ? '输入、目标与职责进度' : 'Input, target, and responsibility progress',
        },
        {
          key: 'details',
          label: zh ? '详细信息' : 'Details',
          description: zh ? '全部参数与上下文' : 'All parameters and contexts',
        },
      ],
    },
    {
      key: 'delivery',
      label: zh ? '交付' : 'Delivery',
      items: [
        {
          key: 'artifacts',
          label: zh ? '产物' : 'Artifacts',
          description: zh ? '修改候选、MR 与材料' : 'Change candidate, MR, and artifacts',
        },
      ],
    },
    {
      key: 'runtime',
      label: zh ? '运行' : 'Runtime',
      items: [
        {
          key: 'execution',
          label: zh ? '执行' : 'Execution',
          description: zh ? '节点时间轴与 Session' : 'Node timeline and sessions',
        },
        {
          key: 'activity',
          label: zh ? '动态' : 'Activity',
          description: zh ? '关注、事件与员工协作' : 'Attention, events, and collaboration',
        },
      ],
    },
  ]
  const mrExternalAction =
    delivery?.webUrl === null || delivery?.webUrl === undefined
      ? undefined
      : {
          href: delivery.webUrl,
          label: zh ? '当前 MR' : 'Current MR',
          title: zh ? `打开 ${delivery.ref}` : `Open ${delivery.ref}`,
        }
  const selectRuntimeInput = () => {
    setSelectedWorkItemRef(null)
    setSelectedReviewOptionRef(null)
    setSelectedDispatchNodeKey(null)
    setInputInspectorOpen(true)
    requestAnimationFrame(() => inputInspectorTitleRef.current?.focus())
  }

  return (
    <div className="page page--operations employee-case-detail-page">
      <div className="operations-surface">
        <PageHeader
          className="operations-surface__header"
          title={data.case.name}
          meta={<StatusChip kind={status.kind}>{status.label}</StatusChip>}
          actions={
            <>
              {delivery?.webUrl === null || delivery?.webUrl === undefined ? null : (
                <a
                  className="btn btn--primary"
                  href={delivery.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="employee-case-header-mr-link"
                >
                  {zh ? '查看 MR' : 'View MR'}
                </a>
              )}
              <CaseMembersDialogButton caseId={caseId} />
              {typeRef === null ? null : (
                <Link
                  to="/digital-employees/$typeRef"
                  params={{ typeRef }}
                  search={{
                    view: 'jobs',
                    jobTemplateId: data.capabilityActivation.jobTemplateRef.id,
                  }}
                  // 与旁边的「任务成员」入口（MembersDialogButton，标准 `btn`）同尺寸。
                  className="btn"
                >
                  {zh ? '查看岗位模板' : 'View job template'}
                </Link>
              )}
            </>
          }
        >
          <p className="operations-surface__subtitle">
            {localized(data.employeeType.displayName, language)} ·{' '}
            {data.capabilityActivation.displayName}
          </p>
        </PageHeader>

        <div className="digital-employee-surface__body">
          <PageSectionNav<EmployeeCaseDetailTab>
            groups={detailSectionGroups}
            active={tab}
            presentation="inline"
            inlineLayout="single-row"
            ariaLabel={zh ? '数字员工任务详情页签' : 'Digital employee task detail sections'}
            idPrefix="employee-case-detail"
            renderDestination={(key, destination) => (
              <PageSectionLink
                to="/tasks/employee-cases/$caseId"
                params={{ caseId }}
                search={(previous) => withEmployeeCaseDetailTab(previous, key)}
                className={destination.className}
                pageSectionCurrent={destination.ariaCurrent}
                data-employee-case-section-link={key}
              >
                {destination.children}
              </PageSectionLink>
            )}
            onSelectCompact={(nextTab) =>
              void navigate({
                search: (previous) => withEmployeeCaseDetailTab(previous, nextTab),
              })
            }
          />

          {tab === 'overview' ? (
            <>
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

              <section
                className="employee-case-fact-grid"
                aria-label={zh ? '任务关键事实' : 'Task key facts'}
              >
                <Card
                  title={zh ? '确定性输入' : 'Frozen input'}
                  actions={<StatusChip kind="success">{zh ? '已接收' : 'Received'}</StatusChip>}
                  data-testid="employee-case-overview-input"
                >
                  <strong>{inputKindLabel(detail.input.kind, zh)}</strong>
                  <p>{inputSummary(detail.input, zh)}</p>
                  <small>
                    {launchOriginLabel(detail.input.source, zh)}
                    {detail.input.ingressRef === null ? '' : ` · ${detail.input.ingressRef}`}
                  </small>
                </Card>
                <Card
                  title={zh ? '代码仓' : 'Repository'}
                  data-testid="employee-case-overview-repo"
                >
                  <strong>{repositoryLabel}</strong>
                  <p>
                    {detail.workspace === null
                      ? zh
                        ? '工作区尚未准备，当前显示任务目标。'
                        : 'The workspace is not prepared; this is the task target.'
                      : detail.workspace.repositoryRef}
                  </p>
                </Card>
                <Card
                  title={zh ? '目标分支' : 'Target branch'}
                  actions={
                    targetBranchPlanned ? (
                      <StatusChip kind="neutral">{zh ? '计划值' : 'Planned'}</StatusChip>
                    ) : (
                      <StatusChip kind="success">{zh ? '已冻结' : 'Frozen'}</StatusChip>
                    )
                  }
                  data-testid="employee-case-overview-target-branch"
                >
                  <strong>
                    {targetBranch ?? (zh ? '工作区准备后确定' : 'Determined with workspace')}
                  </strong>
                  <p>
                    {detail.workspace === null
                      ? zh
                        ? '仓库默认分支，仅作为工作区创建前的计划值。'
                        : 'Repository default branch; a planned value until workspace creation.'
                      : `${zh ? '来源分支' : 'Source branch'}：${sourceBranch}`}
                  </p>
                </Card>
                <Card
                  title={zh ? '当前 MR' : 'Current MR'}
                  actions={
                    delivery === null ? (
                      <StatusChip kind="neutral">{zh ? '尚未创建' : 'Not created'}</StatusChip>
                    ) : (
                      <StatusChip kind={delivery.status === 'active' ? 'info' : 'success'}>
                        {businessStateLabel(delivery.status, zh)}
                      </StatusChip>
                    )
                  }
                  data-testid="employee-case-overview-mr"
                >
                  {delivery === null ? (
                    <p>
                      {zh ? '完成发布职责后会在这里显示 MR。' : 'The MR appears after publishing.'}
                    </p>
                  ) : (
                    <>
                      <strong>{delivery.ref}</strong>
                      <p>
                        {delivery.sourceBranch ?? '-'} → {delivery.targetBranch ?? '-'}
                      </p>
                      {delivery.webUrl === null ? (
                        <small>{zh ? 'MR 链接尚不可用' : 'MR link is not available yet'}</small>
                      ) : (
                        <a
                          className="btn btn--sm btn--primary"
                          href={delivery.webUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {zh ? '查看 MR' : 'View MR'}
                        </a>
                      )}
                    </>
                  )}
                </Card>
              </section>

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
                        {zh ? '数字员工实际能力图' : 'Active digital employee capability map'}
                      </h2>
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
                      setInputInspectorOpen(false)
                      setSelectedDispatchNodeKey(null)
                      setSelectedReviewOptionRef(null)
                      setSelectedWorkItemRef(workItemRef)
                    }}
                    onSelectReviewGate={(gate) => {
                      setInputInspectorOpen(false)
                      setSelectedDispatchNodeKey(null)
                      setSelectedWorkItemRef(gate.parentWorkItemRef)
                      setSelectedReviewOptionRef(gate.optionRef)
                    }}
                    runtimeIngress={{
                      ingressRef: detail.input.ingressRef,
                      presentation: {
                        kindLabel: zh ? '输入' : 'Input',
                        label: inputKindLabel(detail.input.kind, zh),
                        description: inputSummary(detail.input, zh),
                        actionLabel: zh ? '查看实际输入' : 'View actual input',
                        detail: zh ? '已接收' : 'Received',
                        state: 'completed',
                        selected: inputInspectorOpen,
                      },
                    }}
                    onSelectIngress={selectRuntimeInput}
                    externalResourceAction={(target) => {
                      if (mrExternalAction === undefined || delivery === null) return undefined
                      const related =
                        target.kind === 'region'
                          ? delivery.relatedRegionRefs.includes(target.ref)
                          : delivery.relatedWorkItemRefs.includes(target.ref)
                      return related ? mrExternalAction : undefined
                    }}
                    dispatchNodes={runtimeDispatchNodes}
                    selectedDispatchNodeKey={selectedDispatchNodeKey}
                    onSelectDispatchNode={(node) => {
                      const latest = routeRound(node.destinationWorkItemRef, node.routeRef)
                      const target = runningRoundTaskTarget(latest)
                      if (target !== null) {
                        void navigate(target)
                        return
                      }
                      setInputInspectorOpen(false)
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
                  {inputInspectorOpen ? (
                    <div
                      className="employee-case-input-inspector"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setInputInspectorOpen(false)
                      }}
                    >
                      <Card
                        title={zh ? '任务实际输入' : 'Actual task input'}
                        titleRef={inputInspectorTitleRef}
                        actions={
                          <StatusChip kind="success">{zh ? '已接收' : 'Received'}</StatusChip>
                        }
                        className="employee-case-selected-contract"
                        data-testid="employee-case-input-inspector"
                      >
                        <dl className="employee-case-context-facts">
                          <div>
                            <dt>{zh ? '输入类型' : 'Input kind'}</dt>
                            <dd>{inputKindLabel(detail.input.kind, zh)}</dd>
                          </div>
                          <div>
                            <dt>{zh ? '发起来源' : 'Launch origin'}</dt>
                            <dd>{launchOriginLabel(detail.input.source, zh)}</dd>
                          </div>
                          <div>
                            <dt>{zh ? '工作对象' : 'Subject'}</dt>
                            <dd>{detail.input.subjectRef ?? '-'}</dd>
                          </div>
                          <div>
                            <dt>{zh ? '代码仓' : 'Repository'}</dt>
                            <dd>{repositoryLabel}</dd>
                          </div>
                        </dl>
                        {detail.input.externalId === null ? null : (
                          <div className="employee-case-input-block">
                            <strong>{zh ? '外部编号' : 'External ID'}</strong>
                            <code>{detail.input.externalId}</code>
                          </div>
                        )}
                        {detail.input.body === null ? null : (
                          <div className="employee-case-input-block">
                            <strong>{zh ? '输入正文' : 'Input body'}</strong>
                            <pre>{detail.input.body}</pre>
                          </div>
                        )}
                        {detail.input.uploads.length === 0 ? null : (
                          <div className="employee-case-input-block">
                            <strong>{zh ? '输入文件' : 'Input files'}</strong>
                            <ul className="employee-case-path-list">
                              {detail.input.uploads.map((upload) => (
                                <li key={upload.artifactRef}>
                                  <code>{upload.originalName}</code>
                                  <small>
                                    {upload.placement}
                                    {upload.targetPath === null ? '' : ` · ${upload.targetPath}`}
                                  </small>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </Card>
                    </div>
                  ) : selectedItem !== undefined ? (
                    <div className="work-item-contract-card employee-case-selected-contract">
                      <div>
                        <span>{zh ? '这个工作项收到什么' : 'What this work item receives'}</span>
                        <p>{localized(selectedItem.materialSummary, language)}</p>
                      </div>
                      {delivery?.webUrl !== null &&
                      delivery?.webUrl !== undefined &&
                      delivery.relatedWorkItemRefs.includes(selectedItem.workItemRef) ? (
                        <a
                          className="btn btn--sm btn--primary"
                          href={delivery.webUrl}
                          target="_blank"
                          rel="noreferrer"
                          data-testid="employee-case-selected-work-item-mr-link"
                        >
                          {zh ? '查看当前 MR' : 'View current MR'}
                        </a>
                      ) : null}
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
            </>
          ) : null}

          {tab === 'details' ? (
            <>
              {detail.workspace !== null &&
              delivery?.targetBranch !== null &&
              delivery?.targetBranch !== undefined &&
              detail.workspace.targetBranch !== delivery.targetBranch ? (
                <NoticeBanner
                  tone="warning"
                  title={zh ? '目标分支不一致' : 'Target branches differ'}
                >
                  {zh
                    ? `工作区目标为 ${detail.workspace.targetBranch}，MR 目标为 ${delivery.targetBranch}。`
                    : `Workspace target is ${detail.workspace.targetBranch}; MR target is ${delivery.targetBranch}.`}
                </NoticeBanner>
              ) : null}

              <div className="employee-case-detail-grid">
                <Card
                  title={zh ? '完整输入参数' : 'Complete input parameters'}
                  actions={<StatusChip kind="success">{zh ? '已冻结' : 'Frozen'}</StatusChip>}
                >
                  <dl className="employee-case-context-facts">
                    <div>
                      <dt>{zh ? '来源' : 'Source'}</dt>
                      <dd>{launchOriginLabel(detail.input.source, zh)}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '入口' : 'Ingress'}</dt>
                      <dd>{detail.input.ingressRef ?? '-'}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '类型' : 'Kind'}</dt>
                      <dd>{inputKindLabel(detail.input.kind, zh)}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '工作对象' : 'Subject'}</dt>
                      <dd>{detail.input.subjectRef ?? '-'}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '外部编号' : 'External ID'}</dt>
                      <dd>{detail.input.externalId ?? '-'}</dd>
                    </div>
                  </dl>
                  {detail.input.body === null ? null : (
                    <div className="employee-case-input-block">
                      <strong>{zh ? '正文' : 'Body'}</strong>
                      <pre>{detail.input.body}</pre>
                    </div>
                  )}
                  <div className="employee-case-input-block">
                    <strong>{zh ? '文件' : 'Files'}</strong>
                    {detail.input.uploads.length === 0 ? (
                      <p>{zh ? '没有输入文件。' : 'No input files.'}</p>
                    ) : (
                      <ul className="employee-case-path-list">
                        {detail.input.uploads.map((upload) => (
                          <li key={upload.artifactRef}>
                            <code>{upload.originalName}</code>
                            <small>
                              {upload.placement} · {upload.targetPath ?? upload.artifactRef}
                            </small>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <details className="employee-case-technical-details">
                    <summary>{zh ? '执行选项' : 'Execution options'}</summary>
                    <pre className="employee-case-json">
                      {JSON.stringify(
                        {
                          executionOptions: detail.input.executionOptions,
                          advancedOptions: detail.input.advancedOptions,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </Card>

                <Card
                  title={zh ? '代码仓与工作区' : 'Repository and workspace'}
                  actions={
                    detail.workspace === null ? (
                      <StatusChip kind="neutral">{zh ? '待准备' : 'Pending'}</StatusChip>
                    ) : (
                      <StatusChip kind="success">
                        {businessStateLabel(detail.workspace.state, zh)}
                      </StatusChip>
                    )
                  }
                >
                  <dl className="employee-case-context-facts">
                    <div>
                      <dt>{zh ? '代码仓' : 'Repository'}</dt>
                      <dd>{repositoryLabel}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '目标分支' : 'Target branch'}</dt>
                      <dd>
                        {targetBranch ?? '-'}
                        {targetBranchPlanned ? (zh ? '（计划值）' : ' (planned)') : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>{zh ? '来源分支' : 'Source branch'}</dt>
                      <dd>
                        {sourceBranch ?? '-'}
                        {detail.workspace === null && sourceBranch !== null
                          ? zh
                            ? '（计划值）'
                            : ' (planned)'
                          : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>{zh ? '基线提交' : 'Baseline SHA'}</dt>
                      <dd>
                        <code>{detail.workspace?.baselineSha ?? '-'}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{zh ? '远端提交' : 'Remote head'}</dt>
                      <dd>
                        <code>{detail.workspace?.remoteHeadSha ?? '-'}</code>
                      </dd>
                    </div>
                  </dl>
                  {repositories.isError ? (
                    <small>
                      {zh
                        ? '仓库目录加载失败，以上仍为任务冻结引用。'
                        : 'Repository catalog failed to load; frozen refs remain authoritative.'}
                    </small>
                  ) : null}
                </Card>

                <Card title={zh ? '任务与岗位参数' : 'Case and job parameters'}>
                  <dl className="employee-case-context-facts">
                    <div>
                      <dt>Case</dt>
                      <dd>
                        <code>{data.case.id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{zh ? '状态' : 'State'}</dt>
                      <dd>{data.case.state}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '修订' : 'Revision'}</dt>
                      <dd>{data.case.revision}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '数字员工' : 'Employee'}</dt>
                      <dd>
                        <code>
                          {data.case.employeeRef.id}@{data.case.employeeRef.revision}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>{zh ? '类型' : 'Type'}</dt>
                      <dd>
                        <code>
                          {data.case.typeRef.typeId}@{data.case.typeRef.revision}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>{zh ? '岗位模板' : 'Job template'}</dt>
                      <dd>
                        <code>
                          {data.capabilityActivation.jobTemplateRef.id}@
                          {data.capabilityActivation.jobTemplateRef.revision}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>{zh ? '执行策略' : 'Execution policy'}</dt>
                      <dd>v{data.case.executionPolicyRevision}</dd>
                    </div>
                    <div data-testid="employee-case-max-duration">
                      <dt>{zh ? '最长耗时' : 'Max duration'}</dt>
                      <dd>
                        {data.case.maxDurationMs === null
                          ? zh
                            ? '不限制'
                            : 'Unlimited'
                          : `${data.case.consumedDurationMs} / ${data.case.maxDurationMs} ms`}
                      </dd>
                    </div>
                    <div data-testid="employee-case-max-tokens">
                      <dt>{zh ? '总 Token 上限' : 'Total token limit'}</dt>
                      <dd>
                        {data.case.maxTotalTokens === null
                          ? zh
                            ? '不限制'
                            : 'Unlimited'
                          : `${data.case.consumedTotalTokens} / ${data.case.maxTotalTokens}`}
                      </dd>
                    </div>
                    <div data-testid="employee-case-collaborators">
                      <dt>{zh ? '协作者' : 'Collaborators'}</dt>
                      <dd>{members.data?.members.length ?? 0}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '创建时间' : 'Created'}</dt>
                      <dd>{new Date(data.case.createdAt).toLocaleString(language)}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '更新时间' : 'Updated'}</dt>
                      <dd>{new Date(data.case.updatedAt).toLocaleString(language)}</dd>
                    </div>
                  </dl>
                  <details className="employee-case-technical-details">
                    <summary>
                      {zh ? '精确 Adapter 与分发参数' : 'Exact adapters and dispatch parameters'}
                    </summary>
                    <pre className="employee-case-json">
                      {JSON.stringify(
                        {
                          executionOptions: data.capabilityActivation.executionOptions,
                          exactAdapterBindings: data.capabilityActivation.exactAdapterBindings,
                          exactOrderedDispatchConfigurations:
                            data.capabilityActivation.exactOrderedDispatchConfigurations,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </Card>
              </div>

              <section
                className="employee-node-panel"
                aria-label={zh ? '工作上下文' : 'Work context'}
              >
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
                <div className="employee-card-list employee-card-list--detail-contexts">
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
                        {facts.length === 0 ? null : (
                          <dl className="employee-case-context-facts">
                            {facts.map((fact) => (
                              <div key={fact.label}>
                                <dt>{fact.label}</dt>
                                <dd>{fact.value}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
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
            </>
          ) : null}

          {tab === 'artifacts' ? (
            <>
              <div className="employee-case-detail-grid">
                <Card
                  title={zh ? '修改候选' : 'Change candidate'}
                  actions={
                    detail.changeCandidate === null ? (
                      <StatusChip kind="neutral">{zh ? '尚未生成' : 'Not generated'}</StatusChip>
                    ) : (
                      <StatusChip
                        kind={detail.changeCandidate.status === 'obsolete' ? 'neutral' : 'success'}
                      >
                        {detail.changeCandidate.status}
                      </StatusChip>
                    )
                  }
                  data-testid="employee-case-change-candidate"
                >
                  {detail.changeCandidate === null ? (
                    <p>
                      {zh
                        ? '当前任务尚未生成修改候选。'
                        : 'No change candidate has been generated.'}
                    </p>
                  ) : (
                    <>
                      <p>{detail.changeCandidate.summary}</p>
                      <dl className="employee-case-context-facts">
                        <div>
                          <dt>{zh ? '候选引用' : 'Candidate ref'}</dt>
                          <dd>
                            <code>{detail.changeCandidate.candidateRef}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>{zh ? '基线' : 'Baseline'}</dt>
                          <dd>
                            <code>{detail.changeCandidate.baselineSha}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Tree</dt>
                          <dd>
                            <code>{detail.changeCandidate.treeOid}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Commit</dt>
                          <dd>
                            <code>{detail.changeCandidate.commitSha ?? '-'}</code>
                          </dd>
                        </div>
                      </dl>
                      <div className="employee-case-input-block">
                        <strong>{zh ? '修改路径' : 'Changed paths'}</strong>
                        <ul className="employee-case-path-list employee-case-path-list--bounded">
                          {detail.changeCandidate.changedPaths.map((path) => (
                            <li key={path}>
                              <code>{path}</code>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </>
                  )}
                </Card>

                <Card
                  title={zh ? 'MR 交付' : 'Merge-request delivery'}
                  actions={
                    delivery === null ? (
                      <StatusChip kind="neutral">{zh ? '尚未创建' : 'Not created'}</StatusChip>
                    ) : (
                      <StatusChip kind={delivery.status === 'active' ? 'info' : 'success'}>
                        {delivery.status}
                      </StatusChip>
                    )
                  }
                  data-testid="employee-case-artifact-mr"
                >
                  {delivery === null ? (
                    <p>{zh ? '当前任务尚未创建 MR。' : 'No merge request has been created.'}</p>
                  ) : (
                    <>
                      <dl className="employee-case-context-facts">
                        <div>
                          <dt>MR</dt>
                          <dd>
                            <code>{delivery.ref}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>{zh ? '平台引用' : 'Provider ref'}</dt>
                          <dd>{delivery.providerRef ?? '-'}</dd>
                        </div>
                        <div>
                          <dt>{zh ? '代码仓' : 'Repository'}</dt>
                          <dd>{delivery.repositoryRef ?? repositoryLabel}</dd>
                        </div>
                        <div>
                          <dt>{zh ? '分支' : 'Branches'}</dt>
                          <dd>
                            {delivery.sourceBranch ?? '-'} → {delivery.targetBranch ?? '-'}
                          </dd>
                        </div>
                        <div>
                          <dt>Head</dt>
                          <dd>
                            <code>{delivery.headSha}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Target</dt>
                          <dd>
                            <code>{delivery.targetSha ?? '-'}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>{zh ? '合入提交' : 'Merged commit'}</dt>
                          <dd>
                            <code>{delivery.mergedCommitSha ?? '-'}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>{zh ? '草稿' : 'Draft'}</dt>
                          <dd>{delivery.draft ? (zh ? '是' : 'Yes') : zh ? '否' : 'No'}</dd>
                        </div>
                        <div>
                          <dt>{zh ? '可合入状态' : 'Mergeability'}</dt>
                          <dd>{delivery.mergeableState}</dd>
                        </div>
                        <div>
                          <dt>{zh ? '随时可合入' : 'Ready to merge'}</dt>
                          <dd>{delivery.readyToMerge ? (zh ? '是' : 'Yes') : zh ? '否' : 'No'}</dd>
                        </div>
                        <div>
                          <dt>{zh ? '未解决检视' : 'Unresolved reviews'}</dt>
                          <dd>{delivery.unresolvedReviewCount}</dd>
                        </div>
                        <div>
                          <dt>{zh ? '审批暂停' : 'Approval hold'}</dt>
                          <dd>
                            {delivery.approvalHold === null
                              ? '-'
                              : delivery.approvalHold
                                ? zh
                                  ? '是'
                                  : 'Yes'
                                : zh
                                  ? '否'
                                  : 'No'}
                          </dd>
                        </div>
                      </dl>
                      {delivery.webUrl === null ? (
                        <p>{zh ? 'MR 链接尚不可用。' : 'The MR link is not available yet.'}</p>
                      ) : (
                        <a
                          className="btn btn--primary"
                          href={delivery.webUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {zh ? '查看当前 MR' : 'View current MR'}
                        </a>
                      )}
                    </>
                  )}
                </Card>
              </div>

              <section
                className="employee-node-panel"
                aria-label={zh ? '产物引用' : 'Artifact references'}
              >
                <header>
                  <div>
                    <span className="employee-node-panel__eyebrow">
                      {zh ? '产物来源' : 'Artifact provenance'}
                    </span>
                    <h2>
                      {zh
                        ? '任务产生和使用过的全部材料'
                        : 'Every artifact used or produced by this task'}
                    </h2>
                    <p>
                      {zh
                        ? '相同引用已合并，保留输入、Context、轮次与 Session 来源。'
                        : 'Duplicate refs are merged while input, context, round, and session provenance is retained.'}
                    </p>
                  </div>
                </header>
                <div
                  className="employee-card-list employee-card-list--detail-contexts"
                  data-testid="employee-case-artifact-list"
                >
                  {detail.artifacts.length === 0 ? (
                    <p className="node-tool-list__empty">
                      {zh ? '当前没有产物引用。' : 'No artifact references.'}
                    </p>
                  ) : (
                    detail.artifacts.map((artifact) => (
                      <Card key={artifact.ref} title={<code>{artifact.ref}</code>}>
                        <ul className="employee-case-artifact-sources">
                          {artifact.sources.map((source, index) => {
                            if (source.kind === 'input')
                              return (
                                <li key={`input:${index}`}>{zh ? '任务输入' : 'Task input'}</li>
                              )
                            if (source.kind === 'context') {
                              const context = data.contexts.find(
                                (candidate) => candidate.id === source.contextId,
                              )
                              return (
                                <li key={`context:${source.contextId}`}>
                                  {zh ? '上下文' : 'Context'}：{context?.typeId ?? source.contextId}
                                </li>
                              )
                            }
                            return (
                              <li key={`round:${source.roundId}`}>
                                {zh ? '执行轮次' : 'Round'}：<code>{source.roundId}</code>
                                {source.executionRef === null ? null : (
                                  <Link
                                    to="/tasks/$id"
                                    params={{ id: source.executionRef }}
                                    className="btn btn--sm"
                                  >
                                    {zh ? '查看 Session' : 'View session'}
                                  </Link>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </Card>
                    ))
                  )}
                </div>
              </section>
            </>
          ) : null}

          {tab === 'activity' ? (
            <>
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
                            {new Date(event.occurredAt).toLocaleString()} ·{' '}
                            {zh ? '优先级' : 'Priority'} {event.priority}
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
            </>
          ) : null}

          {tab === 'execution' ? (
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
          ) : null}

          {tab === 'activity' ? (
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
          ) : null}
        </div>
      </div>
    </div>
  )
}
