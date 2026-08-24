import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { Agent, WorkflowListItem } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import type {
  DigitalEmployeeDefinition,
  EmployeeWorkContract,
  EmployeeTypePackage,
  JobTemplate,
  ToolAuthoringView,
  ToolRegistration,
  WorkIngress,
  WorkItem,
} from '@/components/digital-employees/types'
import { localized } from '@/components/digital-employees/types'
import {
  EmployeeCapabilityPanorama,
  type ResponsibilityDispatchNode,
  type ResponsibilityToolSlotTarget,
} from '@/components/digital-employees/EmployeeCapabilityPanorama'
import {
  employeeTerminalOutcomeCounts,
  type EmployeeTerminalOutcomeGroup,
} from '@/components/digital-employees/outcomes'
import { ErrorBanner } from '@/components/ErrorBanner'
import {
  ExecutionContractGuidePanel,
  executionContractProgramStarter,
} from '@/components/execution-contracts/ExecutionContractGuidePanel'
import {
  contractRefKey,
  type ExecutionContractAgentCandidateReceipt,
  type ExecutionContractGuide,
} from '@/components/execution-contracts/types'
import { Field, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { GROUP_OPTION_PREFIX } from '@/components/launch/RepoSourceRow'
import { MultiSelect } from '@/components/MultiSelect'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { usePermission } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

type WorkspaceView = 'employees' | 'jobs' | 'toolbox'

interface WorkspaceSearch extends Record<string, unknown> {
  view: WorkspaceView
  jobTemplateId?: string
  workItem?: string
  reviewOption?: string
  toolRole?: string
  toolSlot?: string
}

export function validateDigitalEmployeeTypeSearch(raw: Record<string, unknown>): WorkspaceSearch {
  const view = raw.view === 'jobs' || raw.view === 'toolbox' ? raw.view : 'employees'
  const jobTemplateId = typeof raw.jobTemplateId === 'string' ? raw.jobTemplateId.trim() : ''
  const toolRole = typeof raw.toolRole === 'string' ? raw.toolRole.trim() : ''
  const toolSlot = typeof raw.toolSlot === 'string' ? raw.toolSlot.trim() : ''
  return {
    view,
    ...(view === 'jobs' && jobTemplateId !== '' ? { jobTemplateId } : {}),
    ...(typeof raw.workItem === 'string' && raw.workItem !== '' ? { workItem: raw.workItem } : {}),
    ...(typeof raw.reviewOption === 'string' && raw.reviewOption !== ''
      ? { reviewOption: raw.reviewOption }
      : {}),
    ...(toolRole !== '' && toolSlot !== '' ? { toolRole, toolSlot } : {}),
  }
}

function primaryToolRoleRefs(item: WorkItem): string[] {
  const planningRoleRef = item.humanReview?.planningRoleRef
  return item.toolRoleGroups
    .map((role) => role.roleRef)
    .filter((roleRef) => planningRoleRef === undefined || roleRef !== planningRoleRef)
}

function resolveToolSlotTarget(
  item: WorkItem | null,
  roleRef: string | undefined,
  slotRef: string | undefined,
): ResponsibilityToolSlotTarget | null {
  if (item === null || roleRef === undefined || slotRef === undefined) return null
  const role = item.toolRoleGroups.find((candidate) => candidate.roleRef === roleRef)
  if (role?.bindingSlots.some((candidate) => candidate.slotRef === slotRef) !== true) return null
  return { workItemRef: item.workItemRef, roleRef, slotRef }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/digital-employees/$typeRef',
  validateSearch: validateDigitalEmployeeTypeSearch,
  component: DigitalEmployeeTypePage,
})

function DigitalEmployeeTypePage(): ReactElement {
  const { typeRef } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const zh = language.startsWith('zh')
  const typeQuery = useQuery<EmployeeTypePackage>({
    queryKey: ['digital-employee-type', typeRef],
    queryFn: ({ signal }) =>
      api.get(`/api/digital-employee-types/${encodeURIComponent(typeRef)}`, undefined, signal),
  })
  const workItems = useMemo(
    () => typeQuery.data?.authoringManifest.workItems ?? [],
    [typeQuery.data],
  )
  const selectedRef = workItems.some((item) => item.workItemRef === search.workItem)
    ? (search.workItem ?? null)
    : null
  const toolQueries = useQueries({
    queries: workItems.map((item) => ({
      queryKey: ['digital-employee-tools', typeRef, item.workItemRef],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<{ items: ToolRegistration[] }>(
          `/api/digital-employee-types/${encodeURIComponent(typeRef)}/work-items/${encodeURIComponent(item.workItemRef)}/tools`,
          undefined,
          signal,
        ),
      staleTime: 10_000,
    })),
  })
  const toolsByWorkItem = useMemo(() => {
    const out: Record<string, ToolRegistration[]> = {}
    workItems.forEach((item, index) => {
      out[item.workItemRef] = toolQueries[index]?.data?.items ?? []
    })
    return out
  }, [toolQueries, workItems])
  const selectedItem = workItems.find((item) => item.workItemRef === selectedRef) ?? null
  const selectedToolSlotTarget = resolveToolSlotTarget(
    selectedItem,
    search.toolRole,
    search.toolSlot,
  )
  const selectedToolRole =
    selectedItem?.toolRoleGroups.find((role) => role.roleRef === selectedToolSlotTarget?.roleRef) ??
    null
  const selectedReview =
    selectedToolSlotTarget === null &&
    selectedItem !== null &&
    selectedItem.humanReview?.optionRef === search.reviewOption
      ? selectedItem.humanReview
      : null
  const panelIds = tabDomIds('digital-employee-type-sections', search.view)

  if (typeQuery.isPending) return <LoadingState />
  if (typeQuery.isError) return <ErrorBanner error={typeQuery.error} />
  const type = typeQuery.data
  const selectedContractRef = selectedToolRole?.workContractRef ?? selectedItem?.workContractRef
  const selectedContract =
    type.workContracts.find(
      (contract) =>
        contract.contractId === selectedContractRef?.contractId &&
        contract.version === selectedContractRef.version,
    ) ?? null
  const selectedToolRoleRefs =
    selectedItem === null
      ? []
      : selectedToolRole === null
        ? primaryToolRoleRefs(selectedItem)
        : [selectedToolRole.roleRef]
  const selectedTools =
    selectedRef === null
      ? []
      : (toolsByWorkItem[selectedRef] ?? []).filter((tool) =>
          selectedToolRoleRefs.includes(tool.content.roleRef),
        )
  return (
    <div className="page page--operations digital-employee-type-page">
      <div className="operations-surface">
        <PageHeader
          className="operations-surface__header"
          title={localized(type.displayName, language)}
        >
          <p className="operations-surface__subtitle">{localized(type.description, language)}</p>
        </PageHeader>

        <div className="digital-employee-surface__body">
          <TabBar
            active={search.view}
            onSelect={(view) =>
              void navigate({
                search:
                  view === 'toolbox' && search.workItem !== undefined
                    ? {
                        view,
                        workItem: search.workItem,
                        ...(search.toolRole === undefined || search.toolSlot === undefined
                          ? {}
                          : { toolRole: search.toolRole, toolSlot: search.toolSlot }),
                      }
                    : { view },
                replace: true,
              })
            }
            ariaLabel={zh ? '数字员工分类配置' : 'Employee type configuration'}
            idPrefix="digital-employee-type-sections"
            variant="segment"
            tabs={[
              { key: 'employees', label: zh ? '员工' : 'Employees' },
              { key: 'jobs', label: zh ? '岗位模板' : 'Job templates' },
              { key: 'toolbox', label: zh ? '工具箱' : 'Toolbox' },
            ]}
          />

          <div role="tabpanel" id={panelIds.panelId} aria-labelledby={panelIds.tabId} tabIndex={0}>
            {search.view === 'toolbox' ? (
              <div className="employee-toolbox-workspace">
                <EmployeeCapabilityPanorama
                  type={type}
                  selectedWorkItemRef={selectedRef}
                  selectedReviewOptionRef={selectedReview?.optionRef ?? null}
                  selectedToolSlotTarget={selectedToolSlotTarget}
                  toolsByWorkItem={toolsByWorkItem}
                  language={language}
                  onSelect={(workItem) =>
                    void navigate({
                      search: { view: 'toolbox', workItem },
                      replace: true,
                    })
                  }
                  onSelectToolSlot={(target) =>
                    void navigate({
                      search: {
                        view: 'toolbox',
                        workItem: target.workItemRef,
                        toolRole: target.roleRef,
                        toolSlot: target.slotRef,
                      },
                      replace: true,
                    })
                  }
                  onSelectReviewGate={(gate) =>
                    void navigate({
                      search: {
                        view: 'toolbox',
                        workItem: gate.parentWorkItemRef,
                        reviewOption: gate.optionRef,
                      },
                      replace: true,
                    })
                  }
                  onConfigureIngress={(ingress) =>
                    ingress.configurationSurface === 'task-creation'
                      ? void navigate({ to: '/tasks/new', search: { kind: 'digital-employee' } })
                      : void navigate({ to: '/events', search: { tab: 'subscriptions' } })
                  }
                />
                <Dialog
                  open={selectedItem !== null}
                  onClose={() =>
                    void navigate({
                      search: { view: 'toolbox' },
                      replace: true,
                    })
                  }
                  title={
                    selectedItem === null
                      ? zh
                        ? '配置职责'
                        : 'Configure duty'
                      : selectedReview !== null
                        ? localized(selectedReview.label, language)
                        : selectedToolRole !== null
                          ? zh
                            ? `配置工具：${localized(selectedToolRole.label, language)}`
                            : `Configure tools: ${localized(selectedToolRole.label, language)}`
                          : zh
                            ? `配置职责：${localized(selectedItem.label, language)}`
                            : `Configure duty: ${localized(selectedItem.label, language)}`
                  }
                  size="lg"
                  panelClassName="employee-duty-dialog"
                  data-testid="employee-toolbox-duty-dialog"
                >
                  <ToolboxPanel
                    typeRef={typeRef}
                    item={selectedItem}
                    contract={selectedContract}
                    contracts={type.workContracts}
                    tools={selectedTools}
                    toolRole={selectedToolRole}
                    toolRoleRefs={selectedToolRoleRefs}
                    toolSlotTarget={selectedToolSlotTarget}
                    toolsByWorkItem={toolsByWorkItem}
                    reviewOnly={selectedReview !== null}
                    dispatchSources={
                      selectedItem === null
                        ? []
                        : type.authoringManifest.workItems.filter((source) =>
                            source.orderedDispatchAuthoring?.destinationWorkItemRefs.includes(
                              selectedItem.workItemRef,
                            ),
                          )
                    }
                    language={language}
                  />
                </Dialog>
              </div>
            ) : search.view === 'jobs' ? (
              <JobTemplatesPanel
                typeRef={typeRef}
                type={type}
                toolsByWorkItem={toolsByWorkItem}
                language={language}
                requestedWorkItemRef={selectedRef}
                requestedToolSlotTarget={selectedToolSlotTarget}
                requestedJobTemplateId={search.jobTemplateId}
                onRequestedJobTemplateClose={() =>
                  void navigate({
                    search: (previous) => ({ ...previous, jobTemplateId: undefined }),
                    replace: true,
                  })
                }
                onConfigureIngress={(ingress) =>
                  ingress.configurationSurface === 'task-creation'
                    ? void navigate({ to: '/tasks/new', search: { kind: 'digital-employee' } })
                    : void navigate({ to: '/events', search: { tab: 'subscriptions' } })
                }
              />
            ) : (
              <EmployeesPanel typeRef={typeRef} type={type} language={language} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function WorkItemContractCard(props: {
  item: WorkItem
  contract?: EmployeeWorkContract | null
  language: string
  focusHumanReview?: boolean
  toolRole?: WorkItem['toolRoleGroups'][number] | null
}): ReactElement {
  const zh = props.language.startsWith('zh')
  const planningRoleSelected =
    props.toolRole !== null &&
    props.toolRole !== undefined &&
    props.item.humanReview?.planningRoleRef === props.toolRole.roleRef
  const materialSummary = planningRoleSelected
    ? zh
      ? '冻结的工作材料、执行现场和平台指定的方案文档路径'
      : 'Frozen work materials, execution context, and the platform-designated plan path'
    : localized(props.item.materialSummary, props.language)
  const completionStandard = planningRoleSelected
    ? zh
      ? `只写入指定 Markdown 方案，并从 ${props.item.humanReview?.artifactPort ?? 'artifact'} 输出同一路径；不输出父工作项的 agent-result envelope`
      : `Write only the designated Markdown plan and emit the same path from ${props.item.humanReview?.artifactPort ?? 'artifact'}; do not emit the parent work item's agent-result envelope`
    : localized(props.item.completionStandard, props.language)
  const reviewElement = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (props.focusHumanReview === true) reviewElement.current?.focus()
  }, [props.focusHumanReview])
  return (
    <div className="work-item-contract-card">
      <div>
        <span>{zh ? '输入材料' : 'Input material'}</span>
        <p>{materialSummary}</p>
        {props.contract === null || props.contract === undefined ? null : (
          <code>{props.contract.inputSchemaId}</code>
        )}
      </div>
      <div>
        <span>{zh ? '确定性产出与完成标准' : 'Deterministic output and completion'}</span>
        <p>{completionStandard}</p>
        {props.contract === null || props.contract === undefined ? null : (
          <code>{props.contract.outputSchemaId}</code>
        )}
      </div>
      {props.item.humanReview === null ? null : (
        <div
          ref={reviewElement}
          className="work-item-contract-card__review"
          data-testid="employee-human-review-contract"
          tabIndex={-1}
        >
          <span>{zh ? '可选方案评审子阶段' : 'Optional plan-review substage'}</span>
          <p>
            {zh
              ? '输入：平台注入方案文档精确落点。输出：岗位配置的方案分析 Agent 必须写入 Markdown，并从指定端口返回同一路径；随后由平台审核节点受理。'
              : 'Input: the platform injects the exact plan-document path. Output: the job-configured planning Agent writes Markdown there and returns the same path from the declared port; the platform review node then owns approval.'}
          </p>
          <code>
            platformPaths.implementationPlanPath → {props.item.humanReview.artifactPort} ·
            path&lt;md&gt;
          </code>
          <code>
            .agent-workflow/inputs/requirements/&lt;case&gt;/review/implementation-plan.md
          </code>
        </div>
      )}
    </div>
  )
}

function toolStatus(
  tool: ToolRegistration,
  zh: boolean,
): { kind: 'success' | 'danger' | 'neutral'; label: string } {
  if (tool.validationReceipt.status === 'invalid') {
    return {
      kind: 'danger',
      label:
        tool.publishedRevision === null
          ? zh
            ? '验证失败'
            : 'Invalid'
          : zh
            ? `待修正 · v${tool.publishedRevision} 仍可用`
            : `Needs correction · v${tool.publishedRevision} remains available`,
    }
  }
  if (tool.state === 'published') {
    return { kind: 'success', label: zh ? '可用' : 'Available' }
  }
  return { kind: 'neutral', label: zh ? '草稿' : 'Draft' }
}

function dispatchProblemOptions(
  sourceItem: WorkItem,
  toolsByWorkItem: Readonly<Record<string, ToolRegistration[]>>,
) {
  const options = new Map<string, { value: string; label: string; description?: string }>()
  for (const tool of toolsByWorkItem[sourceItem.workItemRef] ?? []) {
    if (tool.state !== 'published') continue
    for (const definition of tool.content.dispatchRouteDefinitions ?? []) {
      if (options.has(definition.routeRef)) continue
      options.set(definition.routeRef, {
        value: definition.routeRef,
        label: `${definition.displayName} · ${definition.routeRef}`,
        ...(definition.description === '' ? {} : { description: definition.description }),
      })
    }
  }
  return [...options.values()]
}

function dispatchProblemLabel(
  sourceItem: WorkItem,
  routeRef: string,
  toolsByWorkItem: Readonly<Record<string, ToolRegistration[]>>,
): string {
  return (
    dispatchProblemOptions(sourceItem, toolsByWorkItem).find((option) => option.value === routeRef)
      ?.label ?? routeRef
  )
}

function ToolboxPanel(props: {
  typeRef: string
  item: WorkItem | null
  contract: EmployeeWorkContract | null
  contracts: EmployeeWorkContract[]
  tools: ToolRegistration[]
  toolRole: WorkItem['toolRoleGroups'][number] | null
  toolRoleRefs: readonly string[]
  toolSlotTarget: ResponsibilityToolSlotTarget | null
  toolsByWorkItem: Readonly<Record<string, ToolRegistration[]>>
  dispatchSources: WorkItem[]
  language: string
  reviewOnly?: boolean
}): ReactElement {
  const qc = useQueryClient()
  const canUpdate = usePermission('digital-employees:update')
  const canArchive = usePermission('digital-employees:archive')
  const [open, setOpen] = useState(false)
  const [editingTool, setEditingTool] = useState<ToolRegistration | null>(null)
  const zh = props.language.startsWith('zh')
  const contractKey =
    props.contract === null
      ? null
      : contractRefKey({
          contractId: props.contract.contractId,
          version: props.contract.version,
        })
  const contractGuide = useQuery<ExecutionContractGuide>({
    queryKey: ['execution-contract', contractKey, 'toolbox-card'],
    enabled: contractKey !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/api/execution-contracts/${encodeURIComponent(contractKey ?? '')}`,
        undefined,
        signal,
      ),
    staleTime: 60_000,
  })
  const retire = useMutation({
    mutationFn: (toolId: string) =>
      api.post(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/work-items/${encodeURIComponent(props.item?.workItemRef ?? '')}/tools/${encodeURIComponent(toolId)}/retire`,
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({
        queryKey: ['digital-employee-tools', props.typeRef, props.item?.workItemRef],
      })
    },
  })
  if (props.item === null) return <div />
  const business = props.item.nodeKind === 'business-tool'
  const orderedDispatch = props.item.orderedDispatchAuthoring
  const adapterBackedSystem =
    props.item.nodeKind === 'system' &&
    (props.contract?.allowedEffectKinds ?? []).some((kind) => kind.startsWith('external-approval.'))
  if (props.reviewOnly === true && props.item.humanReview !== null) {
    return (
      <section className="employee-node-panel" data-testid="employee-review-gate-detail">
        <header>
          <div>
            <p>{localized(props.item.humanReview.description, props.language)}</p>
          </div>
          <StatusChip kind="neutral">{zh ? '只读人工门禁' : 'Read-only human gate'}</StatusChip>
        </header>
        <WorkItemContractCard
          item={props.item}
          contract={props.contract}
          language={props.language}
          focusHumanReview
        />
        <NoticeBanner
          tone="info"
          title={zh ? '任务发起时决定是否启用' : 'Enabled when work starts'}
        >
          {zh
            ? '这张卡只说明“形成计划 → 人工审核 → 实现”的条件路径，不创建工具槽，也不能在这里增加或选择工具。'
            : 'This card only explains the conditional plan → human review → implement path. It creates no tool slot and offers no tool editing.'}
        </NoticeBanner>
      </section>
    )
  }
  return (
    <section className="employee-node-panel" data-testid="employee-node-toolbox">
      <header>
        <div>
          <p>{localized(props.toolRole?.description ?? props.item.description, props.language)}</p>
        </div>
        {business && canUpdate ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setEditingTool(null)
              setOpen(true)
            }}
          >
            {zh ? '增加工具' : 'Add tool'}
          </button>
        ) : (
          <StatusChip kind="neutral">
            {adapterBackedSystem
              ? zh
                ? '平台协议 · 外部适配'
                : 'Platform protocol · adapter'
              : zh
                ? '平台内建步骤'
                : 'Platform-owned step'}
          </StatusChip>
        )}
      </header>
      <WorkItemContractCard
        item={props.item}
        contract={props.contract}
        language={props.language}
        toolRole={props.toolRole}
      />
      {contractGuide.isPending ? (
        <LoadingState
          size="compact"
          label={zh ? '正在加载输入输出契约…' : 'Loading I/O contract…'}
        />
      ) : contractGuide.isError ? (
        <ErrorBanner error={contractGuide.error} onRetry={() => void contractGuide.refetch()} />
      ) : contractGuide.data === undefined ? null : (
        <ExecutionContractGuidePanel
          guide={contractGuide.data}
          language={props.language}
          kind={props.contract?.allowedToolKinds[0] ?? 'agent'}
        />
      )}
      {business && orderedDispatch !== null ? (
        <section className="employee-dispatch-card" data-testid="employee-runtime-dispatch">
          <header>
            <div>
              <span>{zh ? '问题清单归工具所有' : 'Problem list belongs to the tool'}</span>
              <strong>
                {zh
                  ? '选择分类工具后自动生成修复节点'
                  : 'Selecting a classifier tool creates repair nodes'}
              </strong>
            </div>
          </header>
          <div
            className="employee-dispatch-flow"
            aria-label={zh ? '固定调度顺序' : 'Fixed dispatch flow'}
          >
            <span>{zh ? '按列表归类' : 'Classify by list'}</span>
            <i aria-hidden="true">→</i>
            <span>{zh ? '列表顺序即优先级' : 'List order is priority'}</span>
            <i aria-hidden="true">→</i>
            <span>{zh ? '调用绑定工具' : 'Bound tool'}</span>
            <i aria-hidden="true">→</i>
            <span>{zh ? '继续下一类型' : 'Next type'}</span>
          </div>
          <p>
            {zh
              ? `${localized(orderedDispatch.description, props.language)}。每个分类工具版本在下方维护自己的有序问题清单；岗位模板只为派生节点选择兼容处理工具。`
              : `${localized(orderedDispatch.description, props.language)}. Each classifier tool revision owns its ordered problem list below; a job template only selects compatible handlers for the derived nodes.`}
          </p>
        </section>
      ) : null}
      {business ? (
        <div className="node-tool-list">
          {props.tools.length === 0 ? (
            <p className="node-tool-list__empty">
              {zh
                ? '这个工作项还没有工具。增加后可在岗位模板中选择。'
                : 'No tools yet. Add one, then select it in a job template.'}
            </p>
          ) : (
            props.tools.map((tool) => {
              const status = toolStatus(tool, zh)
              return (
                <article key={tool.id} className="node-tool-row">
                  <div>
                    <div className="node-tool-row__title">
                      <strong>{tool.content.displayName}</strong>
                      {tool.origin === 'platform' ? (
                        <StatusChip kind="neutral" size="sm">
                          {zh ? '平台内置' : 'Built in'}
                        </StatusChip>
                      ) : (
                        <StatusChip kind="neutral" size="sm">
                          {zh ? '自定义工具' : 'Custom'}
                        </StatusChip>
                      )}
                      {tool.selection === 'automatic' ? (
                        <StatusChip kind="success" size="sm">
                          {zh ? '平台自动使用' : 'Used automatically'}
                        </StatusChip>
                      ) : null}
                    </div>
                    <span>{tool.content.description}</span>
                    <small>
                      {tool.content.implementation.kind === 'agent'
                        ? 'Agent'
                        : tool.content.implementation.kind === 'workflow'
                          ? 'Workflow'
                          : 'Program'}
                      {' · '}
                      {tool.content.roleRef}
                    </small>
                    {tool.content.dispatchRouteDefinitions === undefined ? null : (
                      <div className="node-tool-row__problem-list">
                        <small>{zh ? '本工具的问题清单' : 'Problem list in this tool'}</small>
                        <ol>
                          {tool.content.dispatchRouteDefinitions.map((definition, index) => (
                            <li key={definition.routeRef}>
                              <b>P{index + 1}</b>
                              <span>{definition.displayName}</span>
                              <code>{definition.routeRef}</code>
                              {definition.fallback ? (
                                <StatusChip kind="warn" size="sm">
                                  {zh ? '兜底' : 'Fallback'}
                                </StatusChip>
                              ) : null}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {props.dispatchSources.map((sourceItem) => {
                      const routeRefs = tool.content.acceptedDispatchRoutes?.find(
                        (accepted) => accepted.classifierWorkItemRef === sourceItem.workItemRef,
                      )?.routeRefs ?? ['*']
                      return (
                        <small key={`${tool.id}/${sourceItem.workItemRef}`}>
                          {sourceItem.workItemRef === 'classify-pipeline'
                            ? zh
                              ? '该工具解决的问题'
                              : 'Problems solved'
                            : localized(sourceItem.label, props.language)}
                          {'：'}
                          {routeRefs.includes('*')
                            ? zh
                              ? '全部问题'
                              : 'All problems'
                            : routeRefs
                                .map((routeRef) =>
                                  dispatchProblemLabel(sourceItem, routeRef, props.toolsByWorkItem),
                                )
                                .join(', ')}
                        </small>
                      )
                    })}
                  </div>
                  <div className="employee-summary-card__actions">
                    <StatusChip kind={status.kind}>{status.label}</StatusChip>
                    {canUpdate && tool.editable ? (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => {
                          setEditingTool(tool)
                          setOpen(true)
                        }}
                      >
                        {zh ? '编辑' : 'Edit'}
                      </button>
                    ) : null}
                    {canArchive && tool.editable ? (
                      <ConfirmButton
                        label={
                          tool.publishedRevision === null
                            ? zh
                              ? '删除草稿'
                              : 'Delete draft'
                            : zh
                              ? '停用'
                              : 'Retire'
                        }
                        confirmLabel={zh ? '确认' : 'Confirm'}
                        confirmationKey={tool.id}
                        onConfirm={() => retire.mutateAsync(tool.id)}
                        variant="danger"
                        size="sm"
                        disabled={retire.isPending}
                      />
                    ) : null}
                  </div>
                </article>
              )
            })
          )}
        </div>
      ) : (
        <NoticeBanner
          tone="info"
          title={
            adapterBackedSystem
              ? zh
                ? '平台只提供确定性协议，不理解外部审批业务'
                : 'The platform provides protocol, not approval semantics'
              : zh
                ? '平台固定规则'
                : 'Platform rule'
          }
        >
          {adapterBackedSystem
            ? zh
              ? '实际提交或状态查询由审批连接中注册的适配程序完成；平台只负责幂等、关联、订阅等待和恢复。'
              : 'The adapter registered by the approval connection submits or observes status; the platform only owns idempotency, correlation, waiting, and resumption.'
            : zh
              ? '这个节点由平台按固定规则执行，不需要也不允许选择 Agent 或脚本。'
              : 'The platform executes this node by fixed rules; no Agent or script can be attached.'}
        </NoticeBanner>
      )}
      {business &&
      props.tools.some((tool) => tool.state === 'published' && tool.selection === 'selectable') ? (
        <NoticeBanner
          tone="success"
          title={
            props.item.workItemRef === 'repair-pipeline'
              ? zh
                ? '修复范围已由工具声明'
                : 'Repair coverage is declared by each tool'
              : zh
                ? '这个工作项已有可用工具'
                : 'This work item has an available tool'
          }
        >
          {props.item.workItemRef === 'repair-pipeline' ? (
            <span>
              {zh
                ? '岗位模板选择分类工具后会自动生成同数量的问题节点；点击节点时，平台只显示声明解决该问题的修复工具。'
                : 'Selecting a classifier tool in a job automatically creates the same number of problem nodes. Each node only offers repair tools that declare support for that problem.'}
            </span>
          ) : (
            <>
              <span>
                {zh
                  ? '下一步可继续配置其他节点，或把这些工具组合成岗位模板。'
                  : 'Next, configure another node or combine these tools into a job template.'}
              </span>{' '}
              <Link
                to="/digital-employees/$typeRef"
                params={{ typeRef: props.typeRef }}
                search={{
                  view: 'jobs',
                  workItem: props.item.workItemRef,
                  ...(props.toolSlotTarget === null
                    ? {}
                    : {
                        toolRole: props.toolSlotTarget.roleRef,
                        toolSlot: props.toolSlotTarget.slotRef,
                      }),
                }}
                className="btn btn--sm"
              >
                {zh ? '配置岗位模板' : 'Configure job template'}
              </Link>
            </>
          )}
        </NoticeBanner>
      ) : null}
      {retire.isError ? <ErrorBanner error={retire.error} onRetry={() => retire.reset()} /> : null}
      <AddToolDialog
        open={open}
        onClose={() => {
          setOpen(false)
          setEditingTool(null)
        }}
        typeRef={props.typeRef}
        item={props.item}
        contracts={props.contracts}
        tool={editingTool}
        dispatchSources={props.dispatchSources}
        toolsByWorkItem={props.toolsByWorkItem}
        roleRefs={props.toolRoleRefs}
        language={props.language}
      />
    </section>
  )
}

interface AgentChoice extends Agent {
  updatedAt: number
}

function agentChoiceLabel(agent: AgentChoice, language: string): string {
  if (!agent.builtin) return agent.name
  const template = agent.frontmatterExtra.digitalEmployeeTemplate
  const zh = language.startsWith('zh')
  const labels: Record<string, readonly [string, string]> = {
    'code-writing': ['内置 · 代码编写', 'Built in · Code writing'],
    'problem-diagnosis': ['内置 · 问题定位', 'Built in · Problem diagnosis'],
    'pipeline-repair': ['内置 · 通用流水线修复', 'Built in · General pipeline repair'],
    'review-repair': ['内置 · 检视意见修复', 'Built in · Review feedback repair'],
    'conflict-repair': ['内置 · 代码冲突修复', 'Built in · Merge conflict repair'],
    'business-implementation': ['内置 · 业务需求实现', 'Built in · Business implementation'],
    'issue-repair': ['内置 · 代码问题修复', 'Built in · Issue repair'],
    'implementation-planning': ['内置 · 实现方案分析', 'Built in · Implementation planning'],
  }
  const label = typeof template === 'string' ? labels[template] : undefined
  return label === undefined
    ? `${agent.name}${zh ? '（系统内置）' : ' (built in)'}`
    : label[zh ? 0 : 1]
}

interface DevelopmentAdapterChoice {
  id: string
  name: string
  purpose: string
  publishedRevision: number | null
}

interface DispatchRouteDefinitionDraft {
  localRef: string
  routeRef: string
  displayName: string
  description: string
}

function AddToolDialog(props: {
  open: boolean
  onClose: () => void
  typeRef: string
  item: WorkItem
  contracts: EmployeeWorkContract[]
  tool: ToolRegistration | null
  dispatchSources: WorkItem[]
  toolsByWorkItem: Readonly<Record<string, ToolRegistration[]>>
  roleRefs: readonly string[]
  language: string
}): ReactElement {
  const zh = props.language.startsWith('zh')
  const qc = useQueryClient()
  const roleScopeKey = props.roleRefs.join('\u0000')
  const availableRoles = useMemo(() => {
    const roleRefs = new Set(roleScopeKey === '' ? [] : roleScopeKey.split('\u0000'))
    return props.item.toolRoleGroups.filter((role) => roleRefs.has(role.roleRef))
  }, [props.item.toolRoleGroups, roleScopeKey])
  const [kind, setKind] = useState<'agent' | 'workflow' | 'program'>('agent')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [resource, setResource] = useState('')
  const [source, setSource] = useState('')
  const [parameterValuesJson, setParameterValuesJson] = useState('{}')
  const [runtimeKind, setRuntimeKind] = useState<'bash' | 'node' | 'python'>('bash')
  const [connectionId, setConnectionId] = useState('')
  const [acceptedDispatchRoutes, setAcceptedDispatchRoutes] = useState<Record<string, string[]>>({})
  const [dispatchRouteDefinitions, setDispatchRouteDefinitions] = useState<
    DispatchRouteDefinitionDraft[]
  >([])
  const dispatchDefinitionOrdinal = useRef(0)
  const [roleRef, setRoleRef] = useState(availableRoles[0]?.roleRef ?? '')
  const workingToolId = useRef<string | null>(null)
  const editorSessionKey = useRef<string | null>(null)
  const hydratedToolId = useRef<string | null>(null)
  const [validationChecks, setValidationChecks] = useState<
    Array<{ code: string; ok: boolean; detail: string }>
  >([])
  const selectedRole = availableRoles.find((role) => role.roleRef === roleRef)
  const selectedContractRef = selectedRole?.workContractRef ?? props.item.workContractRef
  const contract =
    props.contracts.find(
      (candidate) =>
        candidate.contractId === selectedContractRef.contractId &&
        candidate.version === selectedContractRef.version,
    ) ?? null
  const allowedKinds = useMemo<ReadonlyArray<'agent' | 'workflow' | 'program'>>(
    () => contract?.allowedToolKinds ?? [],
    [contract],
  )
  const contractKey =
    contract === null
      ? null
      : contractRefKey({
          contractId: contract.contractId,
          version: contract.version,
        })
  const contractGuide = useQuery<ExecutionContractGuide>({
    queryKey: ['execution-contract', contractKey],
    enabled: props.open && contractKey !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/api/execution-contracts/${encodeURIComponent(contractKey ?? '')}`,
        undefined,
        signal,
      ),
    staleTime: 60_000,
  })
  const authoring = useQuery<ToolAuthoringView>({
    queryKey: [
      'digital-employee-tool-authoring',
      props.typeRef,
      props.item.workItemRef,
      props.tool?.id,
    ],
    enabled: props.open && props.tool !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/work-items/${encodeURIComponent(props.item.workItemRef)}/tools/${encodeURIComponent(props.tool?.id ?? '')}`,
        undefined,
        signal,
      ),
  })
  useEffect(() => {
    if (!props.open) {
      editorSessionKey.current = null
      hydratedToolId.current = null
      workingToolId.current = null
      return
    }
    const sessionKey = props.tool?.id ?? 'new'
    if (editorSessionKey.current === sessionKey) return
    editorSessionKey.current = sessionKey
    hydratedToolId.current = null
    workingToolId.current = props.tool?.id ?? null
    setKind(allowedKinds[0] ?? 'agent')
    setName('')
    setDescription('')
    setResource('')
    setSource('')
    setParameterValuesJson('{}')
    setRuntimeKind('bash')
    setConnectionId('')
    setAcceptedDispatchRoutes(
      Object.fromEntries(props.dispatchSources.map((source) => [source.workItemRef, []])),
    )
    dispatchDefinitionOrdinal.current = 0
    setDispatchRouteDefinitions(
      props.item.orderedDispatchAuthoring === null
        ? []
        : [
            {
              localRef: `problem-${++dispatchDefinitionOrdinal.current}`,
              routeRef: '',
              displayName: '',
              description: '',
            },
          ],
    )
    setRoleRef(availableRoles[0]?.roleRef ?? '')
    setValidationChecks([])
  }, [
    allowedKinds,
    props.dispatchSources,
    props.item.orderedDispatchAuthoring,
    props.item.toolRoleGroups,
    props.open,
    props.tool?.id,
    availableRoles,
  ])
  useEffect(() => {
    if (
      !props.open ||
      props.tool === null ||
      authoring.data?.id !== props.tool.id ||
      hydratedToolId.current === props.tool.id
    ) {
      return
    }
    hydratedToolId.current = props.tool.id
    const body = authoring.data.body
    setKind(body.implementation.kind)
    setName(body.displayName)
    setDescription(body.description)
    setRoleRef(body.roleRef)
    setConnectionId(body.connectionRef?.id ?? '')
    setAcceptedDispatchRoutes(
      Object.fromEntries(
        props.dispatchSources.map((source) => [
          source.workItemRef,
          body.acceptedDispatchRoutes?.find(
            (accepted) => accepted.classifierWorkItemRef === source.workItemRef,
          )?.routeRefs ?? ['*'],
        ]),
      ),
    )
    dispatchDefinitionOrdinal.current = 0
    const loadedDispatchRouteDefinitions =
      props.item.orderedDispatchAuthoring === null
        ? []
        : (body.dispatchRouteDefinitions ?? [
            {
              routeRef: '',
              displayName: '',
              description: '',
              fallback: true,
            },
          ])
    setDispatchRouteDefinitions(
      loadedDispatchRouteDefinitions.map((definition) => ({
        localRef: `problem-${++dispatchDefinitionOrdinal.current}`,
        routeRef: definition.routeRef,
        displayName: definition.displayName,
        description: definition.description,
      })),
    )
    setValidationChecks(authoring.data.validationReceipt.checks)
    if (body.implementation.kind === 'agent') {
      setResource(body.implementation.agentRef.id)
      setSource('')
      setParameterValuesJson('{}')
      return
    }
    if (body.implementation.kind === 'workflow') {
      setResource(body.implementation.workflowRef.id)
      setSource('')
      setParameterValuesJson('{}')
      return
    }
    setResource('')
    setRuntimeKind(body.implementation.runtimeKind)
    setSource(body.implementation.source)
    setParameterValuesJson(JSON.stringify(body.implementation.parameterValues ?? {}, null, 2))
  }, [
    authoring.data,
    props.dispatchSources,
    props.item.orderedDispatchAuthoring,
    props.open,
    props.tool,
  ])
  useEffect(() => {
    if (!props.open) return
    if (!allowedKinds.includes(kind)) setKind(allowedKinds[0] ?? 'agent')
    if (!availableRoles.some((role) => role.roleRef === roleRef)) {
      setRoleRef(availableRoles[0]?.roleRef ?? '')
    }
  }, [allowedKinds, availableRoles, kind, props.open, roleRef])
  useEffect(() => {
    if (props.open && kind === 'program' && source.trim() === '') {
      setSource(executionContractProgramStarter(runtimeKind))
    }
  }, [kind, props.open, runtimeKind, source])
  const parsedParameters = useMemo(() => {
    try {
      const parsed = JSON.parse(parameterValuesJson) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      if (
        Object.values(parsed).some(
          (value) => !['string', 'number', 'boolean'].includes(typeof value),
        )
      ) {
        return null
      }
      return parsed as Record<string, string | number | boolean>
    } catch {
      return null
    }
  }, [parameterValuesJson])
  const parsedDispatchRoutes = useMemo(() => {
    const parsed = props.dispatchSources.map((sourceItem) => {
      const routeRefs = acceptedDispatchRoutes[sourceItem.workItemRef] ?? []
      const valid =
        routeRefs.length > 0 &&
        new Set(routeRefs).size === routeRefs.length &&
        routeRefs.every(
          (routeRef) => routeRef === '*' || /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(routeRef),
        ) &&
        (!routeRefs.includes('*') || routeRefs.length === 1)
      return valid ? { classifierWorkItemRef: sourceItem.workItemRef, routeRefs } : null
    })
    return parsed.some((value) => value === null)
      ? null
      : parsed.filter(
          (value): value is { classifierWorkItemRef: string; routeRefs: string[] } =>
            value !== null,
        )
  }, [acceptedDispatchRoutes, props.dispatchSources])
  const parsedDispatchRouteDefinitions = useMemo(() => {
    if (props.item.orderedDispatchAuthoring === null) return undefined
    const routeRefs = dispatchRouteDefinitions.map((definition) => definition.routeRef.trim())
    const valid =
      dispatchRouteDefinitions.length > 0 &&
      new Set(routeRefs).size === routeRefs.length &&
      dispatchRouteDefinitions.every(
        (definition) =>
          /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(definition.routeRef.trim()) &&
          definition.displayName.trim() !== '',
      )
    if (!valid) return null
    return dispatchRouteDefinitions.map((definition, index) => ({
      routeRef: definition.routeRef.trim(),
      displayName: definition.displayName.trim(),
      description: definition.description.trim(),
      fallback: index === dispatchRouteDefinitions.length - 1,
    }))
  }, [dispatchRouteDefinitions, props.item.orderedDispatchAuthoring])
  const agents = useQuery<AgentChoice[]>({
    queryKey: ['digital-employee-agent-choices'],
    enabled: props.open && kind === 'agent',
    queryFn: async ({ signal }) => {
      const [ordinary, builtin] = await Promise.all([
        api.get<AgentChoice[]>('/api/agents', undefined, signal),
        api.get<AgentChoice[]>(
          '/api/agents/builtins/digital-employee-templates',
          undefined,
          signal,
        ),
      ])
      return [...builtin, ...ordinary]
    },
  })
  const agentRefs = useMemo(
    () =>
      (agents.data ?? []).map((agent) => ({
        id: agent.id,
        revision: agent.updatedAt,
      })),
    [agents.data],
  )
  const agentCompatibility = useQuery<{ items: ExecutionContractAgentCandidateReceipt[] }>({
    queryKey: ['execution-contract-agent-candidates', contractKey, agentRefs],
    enabled: props.open && kind === 'agent' && contractKey !== null && agents.data !== undefined,
    queryFn: ({ signal }) =>
      api.post(
        `/api/execution-contracts/${encodeURIComponent(contractKey ?? '')}/agent-candidates`,
        { agentRefs },
        signal,
      ),
    staleTime: 60_000,
  })
  const agentReceipt = (agent: AgentChoice): ExecutionContractAgentCandidateReceipt | undefined =>
    agentCompatibility.data?.items.find(
      (candidate) =>
        candidate.agentRef.id === agent.id && candidate.agentRef.revision === agent.updatedAt,
    )
  const agentSupportsContract = (agent: AgentChoice): boolean =>
    agentReceipt(agent)?.validationReceipt.status === 'valid'
  const expectedAgentOutputPort = contractGuide.data?.transports.agent?.outputPort ?? 'agent-result'
  const workflows = useQuery<WorkflowListItem[]>({
    queryKey: ['digital-employee-workflow-choices'],
    enabled: props.open && kind === 'workflow',
    queryFn: ({ signal }) => api.get('/api/workflows', undefined, signal),
  })
  const connections = useQuery<{ items: DevelopmentAdapterChoice[] }>({
    queryKey: ['digital-employee-tool-connections', contract?.requiredConnectionPurpose],
    enabled: props.open && contract?.requiredConnectionPurpose != null,
    queryFn: ({ signal }) => api.get('/api/integrations/development-adapters', undefined, signal),
  })
  const save = useMutation({
    mutationFn: async () => {
      const implementation =
        kind === 'agent'
          ? {
              kind,
              agentRef: {
                id: resource,
                revision: agents.data?.find((agent) => agent.id === resource)?.updatedAt ?? 0,
              },
            }
          : kind === 'workflow'
            ? {
                kind,
                workflowRef: {
                  id: resource,
                  revision:
                    workflows.data?.find((workflow) => workflow.id === resource)?.version ?? 0,
                },
              }
            : {
                kind,
                runtimeKind,
                source,
                parameterValues: parsedParameters ?? undefined,
                runtimeProfileRef: {
                  id: 'builtin:script-runtime',
                  revision: 1,
                },
              }
      const body = {
        displayName: name,
        description,
        roleRef,
        implementation,
        ...(parsedDispatchRouteDefinitions === undefined || parsedDispatchRouteDefinitions === null
          ? {}
          : { dispatchRouteDefinitions: parsedDispatchRouteDefinitions }),
        ...(parsedDispatchRoutes === null || parsedDispatchRoutes.length === 0
          ? {}
          : { acceptedDispatchRoutes: parsedDispatchRoutes }),
        connectionRef:
          contract?.requiredConnectionPurpose == null
            ? null
            : {
                id: connectionId,
                revision:
                  connections.data?.items.find((candidate) => candidate.id === connectionId)
                    ?.publishedRevision ?? 0,
              },
      }
      const basePath = `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/work-items/${encodeURIComponent(props.item.workItemRef)}/tools`
      const existingId = props.tool?.id ?? workingToolId.current
      const draft =
        existingId === null
          ? await api.post<ToolRegistration>(basePath, body)
          : await api.put<ToolRegistration>(`${basePath}/${encodeURIComponent(existingId)}`, body)
      workingToolId.current = draft.id
      if (draft.validationReceipt.status !== 'valid') return draft
      await api.post(`${basePath}/${encodeURIComponent(draft.id)}/publish`)
      return draft
    },
    onMutate: () => setValidationChecks([]),
    onSuccess: async (draft) => {
      await qc.invalidateQueries({
        queryKey: ['digital-employee-tools', props.typeRef, props.item.workItemRef],
      })
      if (draft.validationReceipt.status !== 'valid') {
        setValidationChecks(draft.validationReceipt.checks)
        return
      }
      setName('')
      setDescription('')
      setResource('')
      setSource('')
      setParameterValuesJson('{}')
      setConnectionId('')
      setAcceptedDispatchRoutes(
        Object.fromEntries(props.dispatchSources.map((sourceItem) => [sourceItem.workItemRef, []])),
      )
      setDispatchRouteDefinitions([])
      workingToolId.current = null
      props.onClose()
    },
  })
  const resourceValid =
    allowedKinds.includes(kind) && kind === 'program'
      ? source.trim() !== '' &&
        !source.includes('TODO_IMPLEMENT_CONTRACT') &&
        parsedParameters !== null
      : allowedKinds.includes(kind) &&
        resource !== '' &&
        (kind !== 'agent' ||
          (agents.data?.some((agent) => agent.id === resource && agentSupportsContract(agent)) ??
            false))
  const connectionValid =
    contract?.requiredConnectionPurpose == null ||
    (connections.data?.items.some(
      (candidate) =>
        candidate.id === connectionId &&
        candidate.purpose === contract?.requiredConnectionPurpose &&
        candidate.publishedRevision !== null,
    ) ??
      false)
  const addDispatchRouteDefinition = () => {
    setDispatchRouteDefinitions((current) => [
      ...current,
      {
        localRef: `problem-${++dispatchDefinitionOrdinal.current}`,
        routeRef: '',
        displayName: '',
        description: '',
      },
    ])
  }
  const updateDispatchRouteDefinition = (
    localRef: string,
    patch: Partial<DispatchRouteDefinitionDraft>,
  ) => {
    setDispatchRouteDefinitions((current) =>
      current.map((definition) =>
        definition.localRef === localRef ? { ...definition, ...patch } : definition,
      ),
    )
  }
  const moveDispatchRouteDefinition = (index: number, delta: -1 | 1) => {
    setDispatchRouteDefinitions((current) => {
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [definition] = next.splice(index, 1)
      if (definition === undefined) return current
      next.splice(target, 0, definition)
      return next
    })
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={
        props.tool === null
          ? `${zh ? '给工具职责增加工具：' : 'Add tool to '}${localized(
              availableRoles.length === 1 ? availableRoles[0]!.label : props.item.label,
              props.language,
            )}`
          : `${zh ? '编辑工具：' : 'Edit tool: '}${props.tool.content.displayName}`
      }
      size="lg"
      panelClassName="employee-add-tool-dialog"
      data-testid="employee-add-tool-dialog"
      dismissDisabled={save.isPending}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose} disabled={save.isPending}>
            {zh ? '取消' : 'Cancel'}
          </button>
          <button
            type="submit"
            form="employee-add-tool-form"
            className="btn btn--primary"
            disabled={
              save.isPending ||
              contractGuide.data === undefined ||
              (props.tool !== null && authoring.data === undefined) ||
              name.trim() === '' ||
              !resourceValid ||
              !connectionValid ||
              parsedDispatchRoutes === null ||
              parsedDispatchRouteDefinitions === null
            }
          >
            {save.isPending
              ? zh
                ? '正在验证…'
                : 'Validating…'
              : props.tool === null
                ? zh
                  ? '检查契约并加入工具箱'
                  : 'Check contract and add'
                : zh
                  ? '检查契约并发布新版本'
                  : 'Check contract and publish new version'}
          </button>
        </>
      }
    >
      <form
        id="employee-add-tool-form"
        className="employee-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        {props.tool !== null && authoring.isPending ? (
          <LoadingState label={zh ? '正在加载工具草稿…' : 'Loading tool draft…'} />
        ) : props.tool !== null && authoring.isError ? (
          <ErrorBanner error={authoring.error} onRetry={() => void authoring.refetch()} />
        ) : null}
        <WorkItemContractCard
          item={props.item}
          contract={contract}
          language={props.language}
          toolRole={selectedRole}
        />
        {contractGuide.isPending ? (
          <LoadingState label={zh ? '正在加载平台执行契约…' : 'Loading platform contract…'} />
        ) : contractGuide.isError ? (
          <ErrorBanner error={contractGuide.error} onRetry={() => void contractGuide.refetch()} />
        ) : contractGuide.data === undefined ? (
          <NoticeBanner
            tone="warning"
            title={zh ? '这个工作项缺少执行契约' : 'This work item has no execution contract'}
            size="compact"
          >
            {zh
              ? '分类程序必须先注册确定性输入和输出，才能增加执行工具。'
              : 'The employee type must register deterministic input and output before adding an executor.'}
          </NoticeBanner>
        ) : (
          <ExecutionContractGuidePanel
            guide={contractGuide.data}
            language={props.language}
            kind={kind}
          />
        )}
        <Field label={zh ? '工具名称' : 'Tool name'} required>
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Field label={zh ? '说明' : 'Description'}>
          <TextArea value={description} onChange={setDescription} />
        </Field>
        {props.item.orderedDispatchAuthoring === null ? null : (
          <section
            className="tool-dispatch-definition-editor"
            data-testid="tool-dispatch-route-definitions"
          >
            <header>
              <div>
                <strong>
                  {zh ? '本工具产出的问题种类' : 'Problem categories emitted by this tool'}
                </strong>
                <p>
                  {zh
                    ? '这是分类输出的闭集，不是全局配置或上游输入。每次运行会产出命中的问题记录和待处理种类；清单随工具版本发布，岗位选择后按同一顺序自动生成并连接 P1…Pn 修复节点，最后一项固定为兜底。'
                    : 'This is the closed set for classifier output, not global configuration or upstream input. Each run emits matched problem records and remaining categories. The list is versioned with this tool; selecting it in a job automatically creates and connects P1…Pn repair nodes in this order, with the final item as fallback.'}
                </p>
              </div>
              <button type="button" className="btn btn--sm" onClick={addDispatchRouteDefinition}>
                {zh ? '增加问题类型' : 'Add problem type'}
              </button>
            </header>
            <div className="tool-dispatch-definition-list">
              {dispatchRouteDefinitions.map((definition, index) => (
                <article key={definition.localRef} className="tool-dispatch-definition">
                  <header>
                    <b>P{index + 1}</b>
                    {index === dispatchRouteDefinitions.length - 1 ? (
                      <StatusChip kind="warn" size="sm">
                        {zh ? '兜底问题' : 'Fallback'}
                      </StatusChip>
                    ) : null}
                    <div className="tool-dispatch-definition__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        aria-label={
                          zh ? `提高问题 P${index + 1} 的优先级` : `Move problem P${index + 1} up`
                        }
                        disabled={index === 0}
                        onClick={() => moveDispatchRouteDefinition(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        aria-label={
                          zh ? `降低问题 P${index + 1} 的优先级` : `Move problem P${index + 1} down`
                        }
                        disabled={index === dispatchRouteDefinitions.length - 1}
                        onClick={() => moveDispatchRouteDefinition(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        disabled={dispatchRouteDefinitions.length === 1}
                        onClick={() =>
                          setDispatchRouteDefinitions((current) =>
                            current.filter(
                              (candidate) => candidate.localRef !== definition.localRef,
                            ),
                          )
                        }
                      >
                        {zh ? '删除' : 'Remove'}
                      </button>
                    </div>
                  </header>
                  <div className="tool-dispatch-definition__fields">
                    <Field label={`${zh ? '问题标识' : 'Problem key'} P${index + 1}`} required>
                      <TextInput
                        value={definition.routeRef}
                        onChange={(routeRef) =>
                          updateDispatchRouteDefinition(definition.localRef, { routeRef })
                        }
                      />
                    </Field>
                    <Field label={`${zh ? '问题名称' : 'Problem name'} P${index + 1}`} required>
                      <TextInput
                        value={definition.displayName}
                        onChange={(displayName) =>
                          updateDispatchRouteDefinition(definition.localRef, { displayName })
                        }
                      />
                    </Field>
                    <Field label={`${zh ? '识别说明' : 'Matching description'} P${index + 1}`}>
                      <TextArea
                        value={definition.description}
                        onChange={(description) =>
                          updateDispatchRouteDefinition(definition.localRef, { description })
                        }
                      />
                    </Field>
                  </div>
                </article>
              ))}
            </div>
            {parsedDispatchRouteDefinitions === null ? (
              <NoticeBanner
                tone="warning"
                title={zh ? '问题清单尚未完成' : 'Problem list is incomplete'}
                size="compact"
              >
                {zh
                  ? '至少保留一个问题；问题标识必须唯一且使用小写机器键，每项都要填写名称。'
                  : 'Keep at least one problem. Keys must be unique lowercase machine keys, and every problem needs a name.'}
              </NoticeBanner>
            ) : null}
          </section>
        )}
        {props.dispatchSources.map((sourceItem) => {
          const routeRefs = acceptedDispatchRoutes[sourceItem.workItemRef] ?? []
          const acceptsAll = routeRefs.includes('*')
          return (
            <Field
              key={`dispatch-routes/${sourceItem.workItemRef}`}
              label={zh ? '该工具解决哪些问题' : 'Problems solved by this tool'}
              hint={
                zh
                  ? `问题选项来自“${localized(sourceItem.label, props.language)}”节点中已发布分类工具的问题清单；可以多选。`
                  : `Options come from problem lists in published classifier tools under “${localized(sourceItem.label, props.language)}”; select one or more.`
              }
              required
            >
              <Segmented
                value={acceptsAll ? 'all' : 'selected'}
                onChange={(mode) =>
                  setAcceptedDispatchRoutes((current) => ({
                    ...current,
                    [sourceItem.workItemRef]: mode === 'all' ? ['*'] : [],
                  }))
                }
                ariaLabel={zh ? '问题覆盖范围' : 'Problem coverage'}
                options={[
                  { value: 'selected' as const, label: zh ? '选择问题' : 'Specific problems' },
                  { value: 'all' as const, label: zh ? '全部问题' : 'All problems' },
                ]}
              />
              {acceptsAll ? (
                <NoticeBanner
                  tone="info"
                  title={zh ? '解决全部问题' : 'Solves all problems'}
                  size="compact"
                >
                  {zh
                    ? '该能力以 * 冻结；内置通用流水线修复 Agent 使用这一模式。'
                    : 'This capability is frozen as *. The built-in general pipeline repair Agent uses this mode.'}
                </NoticeBanner>
              ) : (
                <MultiSelect
                  value={routeRefs}
                  onChange={(next) =>
                    setAcceptedDispatchRoutes((current) => ({
                      ...current,
                      [sourceItem.workItemRef]: next,
                    }))
                  }
                  options={dispatchProblemOptions(sourceItem, props.toolsByWorkItem)}
                  ariaLabel={zh ? '该工具解决哪些问题' : 'Problems solved by this tool'}
                  placeholder={zh ? '选择一个或多个问题' : 'Select one or more problems'}
                  emptyLabel={zh ? '还没有已发布的问题清单' : 'No published problem list yet'}
                  openOnFocus={false}
                />
              )}
            </Field>
          )
        })}
        {props.dispatchSources.length > 0 && parsedDispatchRoutes === null ? (
          <NoticeBanner
            tone="warning"
            title={zh ? '请选择工具能解决的问题' : 'Select problems this tool can solve'}
            size="compact"
          >
            {zh
              ? '至少选择一个具体问题，或选择“全部问题”。'
              : 'Select at least one specific problem, or choose “All problems”.'}
          </NoticeBanner>
        ) : null}
        <Field label={zh ? '执行方式' : 'Executor kind'} group>
          <Segmented
            value={kind}
            onChange={(next) => {
              setKind(next)
              setResource('')
              if (next === 'program' && source.trim() === '') {
                setSource(executionContractProgramStarter(runtimeKind))
              }
            }}
            ariaLabel={zh ? '执行方式' : 'Executor kind'}
            options={[
              ...(allowedKinds.includes('agent')
                ? [{ value: 'agent' as const, label: 'Agent' }]
                : []),
              ...(allowedKinds.includes('workflow')
                ? [{ value: 'workflow' as const, label: 'Workflow' }]
                : []),
              ...(allowedKinds.includes('program')
                ? [{ value: 'program' as const, label: zh ? '程序 / 脚本' : 'Program / script' }]
                : []),
            ]}
          />
        </Field>
        {contract?.requiredConnectionPurpose != null ? (
          <Field
            label={zh ? '使用哪个已注册系统' : 'Registered system connection'}
            hint={
              zh
                ? '执行时只使用这个冻结版本；Agent 只能看到引用，不能取得凭据。'
                : 'Execution pins this revision; the Agent sees only its reference, never credentials.'
            }
            required
          >
            <Select
              value={connectionId}
              onChange={setConnectionId}
              searchable
              placeholder={zh ? '请选择已发布的系统程序' : 'Choose a published system program'}
              options={(connections.data?.items ?? [])
                .filter(
                  (candidate) =>
                    candidate.purpose === contract?.requiredConnectionPurpose &&
                    candidate.publishedRevision !== null,
                )
                .map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            />
          </Field>
        ) : null}
        {props.item.toolRoleGroups.length > 1 ? (
          <Field label={zh ? '工具职责' : 'Tool responsibility'} required>
            <Select
              value={roleRef}
              onChange={setRoleRef}
              options={availableRoles.map((role) => ({
                value: role.roleRef,
                label: localized(role.label, props.language),
                description: localized(role.description, props.language),
              }))}
            />
          </Field>
        ) : null}
        {kind === 'agent' ? (
          <Field label={zh ? '从 Agent 库选择' : 'Choose from Agent library'} required>
            <Select
              value={resource}
              onChange={setResource}
              searchable
              placeholder={
                agents.isPending
                  ? zh
                    ? '正在加载…'
                    : 'Loading…'
                  : zh
                    ? '请选择 Agent'
                    : 'Choose an Agent'
              }
              options={(agents.data ?? []).map((agent) => ({
                value: agent.id,
                label: agentChoiceLabel(agent, props.language),
                disabled: !agentSupportsContract(agent),
                description: agentSupportsContract(agent)
                  ? zh
                    ? `契约声明与 ${expectedAgentOutputPort} 输出端口均匹配`
                    : `Contract declaration and ${expectedAgentOutputPort} output both match`
                  : (agentReceipt(agent)?.validationReceipt.checks.find((check) => !check.ok)
                      ?.detail ?? (zh ? '平台正在检查契约' : 'Platform contract check pending')),
                badge: agentSupportsContract(agent)
                  ? zh
                    ? '可用'
                    : 'Compatible'
                  : zh
                    ? '不匹配'
                    : 'Mismatch',
                badgeTone: agentSupportsContract(agent)
                  ? ('neutral' as const)
                  : ('danger' as const),
              }))}
            />
            {agents.data !== undefined && agentCompatibility.isPending ? (
              <LoadingState
                size="compact"
                label={zh ? '平台正在逐个检查 Agent 契约…' : 'Checking Agent contracts…'}
              />
            ) : agentCompatibility.isError ? (
              <ErrorBanner
                error={agentCompatibility.error}
                onRetry={() => void agentCompatibility.refetch()}
              />
            ) : (agents.data ?? []).some((agent) => agentSupportsContract(agent)) ? null : (
              <NoticeBanner
                tone="info"
                title={zh ? '没有匹配这个契约的 Agent' : 'No Agent matches this contract'}
                size="compact"
              >
                {zh
                  ? `请先在 Agent 库的“输入/输出 → 平台执行契约”中声明该契约；${expectedAgentOutputPort} 端口由契约自动维护，不能单独编辑或删除。`
                  : `Declare this contract under Agent library → Inputs & outputs → Platform execution contracts. The contract owns the ${expectedAgentOutputPort} port, so it cannot be edited or deleted separately.`}
              </NoticeBanner>
            )}
          </Field>
        ) : kind === 'workflow' ? (
          <Field label={zh ? '从工作流库选择' : 'Choose from workflow library'} required>
            <Select
              value={resource}
              onChange={setResource}
              searchable
              placeholder={
                workflows.isPending
                  ? zh
                    ? '正在加载…'
                    : 'Loading…'
                  : zh
                    ? '请选择工作流'
                    : 'Choose a workflow'
              }
              options={(workflows.data ?? []).map((workflow) => ({
                value: workflow.id,
                label: workflow.name,
              }))}
            />
          </Field>
        ) : (
          <>
            <Field label={zh ? '程序语言' : 'Language'} required>
              <Select
                value={runtimeKind}
                onChange={(next) => {
                  setRuntimeKind(next)
                  if (source.trim() === '' || source.includes('TODO_IMPLEMENT_CONTRACT')) {
                    setSource(executionContractProgramStarter(next))
                  }
                }}
                options={[
                  { value: 'bash', label: 'Bash' },
                  { value: 'node', label: 'Node.js' },
                  { value: 'python', label: 'Python' },
                ]}
              />
            </Field>
            <Field
              label={zh ? '程序内容' : 'Program source'}
              hint={
                zh
                  ? '完整 envelope 固定从 AW_PORT_CONTRACT_INPUT 读取；大输入改从 AW_PORT_FILE_CONTRACT_INPUT 文件读取。stdout 只能写一个 JSON 对象。'
                  : 'Read the complete envelope from AW_PORT_CONTRACT_INPUT, or AW_PORT_FILE_CONTRACT_INPUT for large input. stdout must contain only one JSON object.'
              }
              required
            >
              <TextArea
                className="employee-dialog-form__code"
                value={source}
                onChange={setSource}
                monospace
              />
            </Field>
            {source.includes('TODO_IMPLEMENT_CONTRACT') ? (
              <NoticeBanner
                tone="warning"
                title={zh ? '请完成程序逻辑' : 'Implement the program logic'}
                size="compact"
              >
                {zh
                  ? '示例已经演示输入注入和确定性输出，但 TODO 分支会阻止发布。替换该分支并保留 fixture 分支后，平台会实际运行一次契约样例。'
                  : 'The starter demonstrates injection and exact output, but its TODO branch blocks publishing. Replace it and keep the fixture branch; the platform will execute one contract fixture.'}
              </NoticeBanner>
            ) : null}
            <Field
              label={zh ? '程序参数（JSON）' : 'Program parameters (JSON)'}
              hint={
                zh
                  ? '可选。只填写字符串、数字或布尔值；平台会与程序版本一起冻结。'
                  : 'Optional. Use string, number, or boolean values; the platform freezes them with the program version.'
              }
            >
              <TextArea
                className="employee-dialog-form__code"
                value={parameterValuesJson}
                onChange={setParameterValuesJson}
                monospace
              />
            </Field>
            {parsedParameters === null ? (
              <NoticeBanner
                tone="warning"
                title={zh ? '程序参数格式不正确' : 'Invalid program parameters'}
                size="compact"
              >
                {zh
                  ? '请输入一个 JSON 对象，且每个值只能是字符串、数字或布尔值。'
                  : 'Enter a JSON object whose values are strings, numbers, or booleans.'}
              </NoticeBanner>
            ) : null}
          </>
        )}
        {validationChecks.length > 0 ? (
          <NoticeBanner
            tone="warning"
            title={zh ? '这个工具还不能发布' : 'This tool is not publishable yet'}
            size="compact"
          >
            <ul>
              {validationChecks
                .filter((check) => !check.ok)
                .map((check) => (
                  <li key={check.code}>{check.detail}</li>
                ))}
            </ul>
          </NoticeBanner>
        ) : null}
        {save.isError ? <ErrorBanner error={save.error} onRetry={() => save.reset()} /> : null}
      </form>
    </Dialog>
  )
}

interface OrderedDispatchRouteDraft {
  localRef: string
  routeRef: string
  displayName: string
  description: string
  destinationWorkItemRef: string
  toolId: string
}

function toolAcceptsDispatchRoute(
  tool: ToolRegistration,
  classifierWorkItemRef: string,
  routeRef: string,
): boolean {
  if (tool.content.acceptedDispatchRoutes === undefined) return true
  const accepted = tool.content.acceptedDispatchRoutes.find(
    (candidate) => candidate.classifierWorkItemRef === classifierWorkItemRef,
  )
  return (
    accepted?.routeRefs.includes('*') === true ||
    (routeRef !== '' && accepted?.routeRefs.includes(routeRef) === true)
  )
}

function preferredDispatchTool(
  tools: readonly ToolRegistration[],
  classifierWorkItemRef: string,
  routeRef: string,
): ToolRegistration | undefined {
  const score = (tool: ToolRegistration): number => {
    const accepted = tool.content.acceptedDispatchRoutes?.find(
      (candidate) => candidate.classifierWorkItemRef === classifierWorkItemRef,
    )
    const wildcard =
      tool.content.acceptedDispatchRoutes === undefined ||
      accepted?.routeRefs.includes('*') === true
    if (tool.origin === 'platform' && wildcard) return 0
    if (wildcard) return 1
    if (tool.origin === 'platform') return 2
    return 3
  }
  return tools
    .filter(
      (tool) =>
        tool.state === 'published' &&
        tool.publishedRevision !== null &&
        tool.selection === 'selectable' &&
        toolAcceptsDispatchRoute(tool, classifierWorkItemRef, routeRef),
    )
    .sort((left, right) => score(left) - score(right))[0]
}

function deriveDispatchRouteDrafts(input: {
  classifier: WorkItem
  definitions: NonNullable<ToolRegistration['content']['dispatchRouteDefinitions']>
  existing: readonly OrderedDispatchRouteDraft[]
  workItems: readonly WorkItem[]
  toolsByWorkItem: Readonly<Record<string, ToolRegistration[]>>
}): OrderedDispatchRouteDraft[] {
  const destinations = input.classifier.orderedDispatchAuthoring?.destinationWorkItemRefs ?? []
  const defaultDestination =
    destinations.find(
      (workItemRef) =>
        input.workItems.find((item) => item.workItemRef === workItemRef)?.nodeKind ===
        'business-tool',
    ) ??
    destinations[0] ??
    ''
  const existingByRoute = new Map(input.existing.map((route) => [route.routeRef, route]))
  return input.definitions.map((definition, index) => {
    const current = existingByRoute.get(definition.routeRef)
    const destinationWorkItemRef =
      current !== undefined && destinations.includes(current.destinationWorkItemRef)
        ? current.destinationWorkItemRef
        : defaultDestination
    const destination = input.workItems.find((item) => item.workItemRef === destinationWorkItemRef)
    const compatibleCurrentTool = (input.toolsByWorkItem[destinationWorkItemRef] ?? []).find(
      (tool) =>
        tool.id === current?.toolId &&
        tool.state === 'published' &&
        tool.selection === 'selectable' &&
        toolAcceptsDispatchRoute(tool, input.classifier.workItemRef, definition.routeRef),
    )
    const toolId =
      destination?.nodeKind === 'business-tool'
        ? ((
            compatibleCurrentTool ??
            preferredDispatchTool(
              input.toolsByWorkItem[destinationWorkItemRef] ?? [],
              input.classifier.workItemRef,
              definition.routeRef,
            )
          )?.id ?? '')
        : ''
    return {
      localRef:
        current?.localRef ??
        `${input.classifier.workItemRef}/${definition.routeRef}/${String(index + 1)}`,
      routeRef: definition.routeRef,
      displayName: definition.displayName,
      description: definition.description,
      destinationWorkItemRef,
      toolId,
    }
  })
}

function defaultReactionLaneOrder(type: EmployeeTypePackage): string[] {
  const workItems = new Map(
    type.authoringManifest.workItems.map((item) => [item.workItemRef, item]),
  )
  const priorities = new Map<string, number>()
  for (const rule of type.reactionRules) {
    const laneId = workItems.get(
      rule.capabilityWorkItemRef ?? rule.workItemRef,
    )?.responsibilityLaneId
    if (laneId !== null && laneId !== undefined) {
      priorities.set(laneId, Math.max(priorities.get(laneId) ?? 0, rule.priority))
    }
  }
  return type.authoringManifest.lifecycleRegions
    .slice()
    .sort((left, right) => left.order - right.order)
    .flatMap((region) =>
      region.responsibilityLanes
        .slice()
        .sort((left, right) => left.order - right.order)
        .filter((lane) => lane.kind === 'branch' && priorities.has(lane.laneId))
        .map((lane, laneIndex) => ({
          laneId: lane.laneId,
          declaredOrder: region.order * 100 + laneIndex,
        })),
    )
    .sort(
      (left, right) =>
        (priorities.get(right.laneId) ?? 0) - (priorities.get(left.laneId) ?? 0) ||
        left.declaredOrder - right.declaredOrder,
    )
    .map((lane) => lane.laneId)
}

function JobTemplatesPanel(props: {
  typeRef: string
  type: EmployeeTypePackage
  toolsByWorkItem: Record<string, ToolRegistration[]>
  language: string
  requestedWorkItemRef: string | null
  requestedToolSlotTarget: ResponsibilityToolSlotTarget | null
  requestedJobTemplateId?: string
  onRequestedJobTemplateClose: () => void
  onConfigureIngress: (ingress: WorkIngress) => void
}): ReactElement {
  const zh = props.language.startsWith('zh')
  const qc = useQueryClient()
  const requestedWorkItem =
    props.type.authoringManifest.workItems.find(
      (item) => item.workItemRef === props.requestedWorkItemRef,
    ) ?? null
  const requestedToolRole =
    requestedWorkItem?.toolRoleGroups.find(
      (role) => role.roleRef === props.requestedToolSlotTarget?.roleRef,
    ) ?? null
  const [open, setOpen] = useState(false)
  const [identityOpen, setIdentityOpen] = useState(false)
  const [dutyOpen, setDutyOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<JobTemplate | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [identityName, setIdentityName] = useState('')
  const [identityDescription, setIdentityDescription] = useState('')
  const [editorWorkItemRef, setEditorWorkItemRef] = useState('')
  const [editorToolSlotTarget, setEditorToolSlotTarget] =
    useState<ResponsibilityToolSlotTarget | null>(null)
  const [editorReviewOptionRef, setEditorReviewOptionRef] = useState<string | null>(null)
  const [editorDispatchRouteKey, setEditorDispatchRouteKey] = useState<string | null>(null)
  const [validationAttempt, setValidationAttempt] = useState(0)
  const dispatchOrdinal = useRef(0)
  const configurableGroups = props.type.authoringManifest.workItems
    .map((item) => ({
      item,
      slots: item.toolRoleGroups.flatMap((role) =>
        role.bindingSlots.map((slot) => ({ item, role, slot })),
      ),
    }))
    .filter((group) => group.slots.length > 0)
  const configurableSlots = configurableGroups.flatMap((group) => group.slots)
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [collaborationBindings, setCollaborationBindings] = useState<Record<string, string>>({})
  const [orderedDispatchRoutes, setOrderedDispatchRoutes] = useState<
    Record<string, OrderedDispatchRouteDraft[]>
  >({})
  const [reactionLaneOrder, setReactionLaneOrder] = useState<string[]>(() =>
    defaultReactionLaneOrder(props.type),
  )
  const dispatchItems = props.type.authoringManifest.workItems.filter(
    (item) => item.orderedDispatchAuthoring !== null,
  )
  const query = useQuery<{ items: JobTemplate[] }>({
    queryKey: ['digital-employee-job-templates', props.typeRef],
    queryFn: ({ signal }) =>
      api.get(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/job-templates`,
        undefined,
        signal,
      ),
  })
  const employees = useQuery<{ items: DigitalEmployeeDefinition[] }>({
    queryKey: ['digital-employees', 'all'],
    enabled: open,
    queryFn: ({ signal }) => api.get('/api/digital-employees/launchable', undefined, signal),
  })
  const createDraft = useMutation({
    mutationFn: (identity: { name: string; description: string }) =>
      api.post<JobTemplate>(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/job-templates`,
        {
          name: identity.name,
          description: identity.description,
          defaultToolBindings: [],
          defaultCollaborationBindings: [],
          orderedDispatchConfigurations: [],
          reactionLaneOrder: defaultReactionLaneOrder(props.type),
        },
      ),
    onSuccess: async (draft) => {
      await qc.invalidateQueries({
        queryKey: ['digital-employee-job-templates', props.typeRef],
      })
      setEditingJob(draft)
      setName(draft.name)
      setDescription(draft.draft.description)
      setIdentityOpen(false)
      setOpen(true)
      setDutyOpen(editorWorkItemRef !== '')
    },
  })
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        description,
        defaultToolBindings: configurableSlots.flatMap(({ item, slot }) => {
          const toolId = bindings[`${item.workItemRef}/${slot.slotRef}`]
          if (toolId === undefined || toolId === '') return []
          const tool = props.toolsByWorkItem[item.workItemRef]?.find(
            (candidate) => candidate.id === toolId && candidate.selection === 'selectable',
          )
          if (tool?.publishedRevision == null) return []
          return [
            {
              workItemRef: item.workItemRef,
              slotRef: slot.slotRef,
              registrationRef: { id: tool.id, revision: tool.publishedRevision },
            },
          ]
        }),
        defaultCollaborationBindings: props.type.authoringManifest.workItems
          .filter(
            (item) =>
              item.nodeKind === 'collaboration' &&
              item.collaborationContractId !== null &&
              collaborationBindings[item.workItemRef],
          )
          .flatMap((item) => {
            const employee = employees.data?.items.find(
              (candidate) => candidate.id === collaborationBindings[item.workItemRef],
            )
            if (employee === undefined || item.collaborationContractId === null) {
              return []
            }
            return [
              {
                workItemRef: item.workItemRef,
                targetEmployeeRef: {
                  id: employee.id,
                  revision: employee.revision,
                },
                invocationContractId: item.collaborationContractId,
              },
            ]
          }),
        orderedDispatchConfigurations: dispatchItems.flatMap((classifier) => {
          const routes = orderedDispatchRoutes[classifier.workItemRef] ?? []
          if (routes.length === 0) return []
          return [
            {
              classifierWorkItemRef: classifier.workItemRef,
              routes: routes.map((route, index) => {
                const destination = props.type.authoringManifest.workItems.find(
                  (item) => item.workItemRef === route.destinationWorkItemRef,
                )
                const tool = (props.toolsByWorkItem[route.destinationWorkItemRef] ?? []).find(
                  (candidate) =>
                    candidate.id === route.toolId && candidate.selection === 'selectable',
                )
                return {
                  routeRef: route.routeRef.trim(),
                  displayName: route.displayName.trim(),
                  description: route.description.trim(),
                  destinationWorkItemRef: route.destinationWorkItemRef,
                  registrationRef:
                    destination?.nodeKind === 'business-tool' && tool?.publishedRevision != null
                      ? { id: tool.id, revision: tool.publishedRevision }
                      : null,
                  fallback: index === routes.length - 1,
                }
              }),
            },
          ]
        }),
        reactionLaneOrder,
      }
      const draft =
        editingJob === null
          ? await api.post<JobTemplate>(
              `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/job-templates`,
              body,
            )
          : await api.put<JobTemplate>(
              `/api/digital-employee-job-templates/${encodeURIComponent(editingJob.id)}`,
              body,
            )
      await api.post(`/api/digital-employee-job-templates/${encodeURIComponent(draft.id)}/publish`)
      return draft
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['digital-employee-job-templates', props.typeRef] })
      if (props.requestedJobTemplateId !== undefined) props.onRequestedJobTemplateClose()
      setOpen(false)
      setIdentityOpen(false)
      setDutyOpen(false)
      setEditingJob(null)
      setEditorToolSlotTarget(null)
      setEditorDispatchRouteKey(null)
      setName('')
      setDescription('')
      setBindings({})
      setCollaborationBindings({})
      setOrderedDispatchRoutes({})
      setValidationAttempt(0)
    },
  })
  const resetDraft = () => {
    setName('')
    setDescription('')
    setBindings({})
    setCollaborationBindings({})
    setOrderedDispatchRoutes({})
    setReactionLaneOrder(defaultReactionLaneOrder(props.type))
    dispatchOrdinal.current = 0
  }
  const openNew = () => {
    createDraft.reset()
    save.reset()
    resetDraft()
    setEditingJob(null)
    setEditorWorkItemRef(requestedWorkItem?.workItemRef ?? '')
    setEditorToolSlotTarget(props.requestedToolSlotTarget)
    setEditorDispatchRouteKey(null)
    setValidationAttempt(0)
    setIdentityName('')
    setIdentityDescription('')
    setOpen(false)
    setDutyOpen(false)
    setIdentityOpen(true)
  }
  const openExisting = (job: JobTemplate) => {
    createDraft.reset()
    save.reset()
    dispatchOrdinal.current = 0
    setEditingJob(job)
    setEditorWorkItemRef(requestedWorkItem?.workItemRef ?? '')
    setEditorToolSlotTarget(props.requestedToolSlotTarget)
    setEditorDispatchRouteKey(null)
    setValidationAttempt(0)
    setName(job.name)
    setDescription(job.draft.description)
    const loadedBindings = Object.fromEntries(
      job.draft.defaultToolBindings.map((binding) => [
        `${binding.workItemRef}/${binding.slotRef}`,
        binding.registrationRef.id,
      ]),
    )
    setBindings(loadedBindings)
    setCollaborationBindings(
      Object.fromEntries(
        job.draft.defaultCollaborationBindings.map((binding) => [
          binding.workItemRef,
          binding.targetEmployeeRef.id,
        ]),
      ),
    )
    const loadedDispatchRoutes: Record<string, OrderedDispatchRouteDraft[]> = Object.fromEntries(
      job.draft.orderedDispatchConfigurations.map((configuration) => [
        configuration.classifierWorkItemRef,
        configuration.routes.map((route) => ({
          localRef: `${configuration.classifierWorkItemRef}-${++dispatchOrdinal.current}`,
          routeRef: route.routeRef,
          displayName: route.displayName,
          description: route.description,
          destinationWorkItemRef: route.destinationWorkItemRef,
          toolId: route.registrationRef?.id ?? '',
        })),
      ]),
    )
    for (const classifier of dispatchItems) {
      const slot = classifier.toolRoleGroups.flatMap((role) => role.bindingSlots)[0]
      const toolId =
        slot === undefined ? '' : loadedBindings[`${classifier.workItemRef}/${slot.slotRef}`]
      const tool = (props.toolsByWorkItem[classifier.workItemRef] ?? []).find(
        (candidate) => candidate.id === toolId,
      )
      if (tool?.content.dispatchRouteDefinitions === undefined) continue
      loadedDispatchRoutes[classifier.workItemRef] = deriveDispatchRouteDrafts({
        classifier,
        definitions: tool.content.dispatchRouteDefinitions,
        existing: loadedDispatchRoutes[classifier.workItemRef] ?? [],
        workItems: props.type.authoringManifest.workItems,
        toolsByWorkItem: props.toolsByWorkItem,
      })
    }
    setOrderedDispatchRoutes(loadedDispatchRoutes)
    setReactionLaneOrder(
      job.draft.reactionLaneOrder.length > 0
        ? job.draft.reactionLaneOrder
        : defaultReactionLaneOrder(props.type),
    )
    setIdentityOpen(false)
    setDutyOpen(requestedWorkItem !== null)
    setOpen(true)
  }
  const openedRequestedJobTemplateId = useRef<string | null>(null)
  const openExistingRef = useRef(openExisting)
  openExistingRef.current = openExisting
  useEffect(() => {
    const requestedId = props.requestedJobTemplateId
    if (requestedId === undefined) {
      openedRequestedJobTemplateId.current = null
      return
    }
    if (openedRequestedJobTemplateId.current === requestedId) return
    const requestedJobTemplate = query.data?.items.find((job) => job.id === requestedId)
    if (requestedJobTemplate === undefined) return
    openedRequestedJobTemplateId.current = requestedId
    openExistingRef.current(requestedJobTemplate)
  }, [props.requestedJobTemplateId, query.data?.items])
  const openIdentityEditor = () => {
    setIdentityName(name)
    setIdentityDescription(description)
    setIdentityOpen(true)
  }
  const closeIdentityEditor = () => {
    if (createDraft.isPending) return
    setIdentityOpen(false)
    if (!open) {
      setEditingJob(null)
      resetDraft()
    }
  }
  const confirmIdentity = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (identityName.trim() === '') return
    if (!open && editingJob === null) {
      createDraft.mutate({
        name: identityName.trim(),
        description: identityDescription,
      })
      return
    }
    setName(identityName)
    setDescription(identityDescription)
    setIdentityOpen(false)
    setOpen(true)
    setDutyOpen(editorWorkItemRef !== '')
  }
  const closeEditor = () => {
    if (props.requestedJobTemplateId !== undefined) props.onRequestedJobTemplateClose()
    setOpen(false)
    setIdentityOpen(false)
    setDutyOpen(false)
    setEditingJob(null)
    setEditorToolSlotTarget(null)
    setEditorDispatchRouteKey(null)
    setValidationAttempt(0)
    createDraft.reset()
    save.reset()
    resetDraft()
  }
  const laneOptional = new Map(
    props.type.authoringManifest.lifecycleRegions.flatMap((region) =>
      region.responsibilityLanes.map((lane) => [lane.laneId, lane.optional] as const),
    ),
  )
  const activeOptionalLanes = new Set<string>()
  const activateLane = (workItemRef: string) => {
    const item = props.type.authoringManifest.workItems.find(
      (candidate) => candidate.workItemRef === workItemRef,
    )
    if (item?.responsibilityLaneId != null) activeOptionalLanes.add(item.responsibilityLaneId)
  }
  for (const key of Object.keys(bindings)) {
    if (bindings[key]) activateLane(key.split('/')[0] ?? '')
  }
  for (const [workItemRef, employeeId] of Object.entries(collaborationBindings)) {
    if (employeeId) activateLane(workItemRef)
  }
  for (const classifier of dispatchItems) {
    const routes = orderedDispatchRoutes[classifier.workItemRef] ?? []
    if (routes.length === 0) continue
    activateLane(classifier.workItemRef)
    for (const route of routes) activateLane(route.destinationWorkItemRef)
  }
  const itemEnabled = (item: WorkItem): boolean =>
    item.responsibilityLaneId === null ||
    laneOptional.get(item.responsibilityLaneId) !== true ||
    activeOptionalLanes.has(item.responsibilityLaneId)
  const dispatchRouteComplete = (
    classifier: WorkItem,
    route: OrderedDispatchRouteDraft,
  ): boolean => {
    const destination = props.type.authoringManifest.workItems.find(
      (item) => item.workItemRef === route.destinationWorkItemRef,
    )
    return (
      /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(route.routeRef) &&
      route.displayName.trim() !== '' &&
      destination !== undefined &&
      (destination.nodeKind === 'collaboration'
        ? Boolean(collaborationBindings[destination.workItemRef])
        : destination.nodeKind === 'business-tool' &&
          (props.toolsByWorkItem[destination.workItemRef] ?? []).some(
            (tool) =>
              tool.id === route.toolId &&
              tool.state === 'published' &&
              tool.selection === 'selectable' &&
              toolAcceptsDispatchRoute(tool, classifier.workItemRef, route.routeRef),
          ))
    )
  }
  const dispatchItemComplete = (classifier: WorkItem): boolean => {
    const routes = orderedDispatchRoutes[classifier.workItemRef] ?? []
    if (routes.length === 0) return false
    return routes.every((route) => dispatchRouteComplete(classifier, route))
  }
  const dispatchComplete = dispatchItems.every(
    (classifier) => !itemEnabled(classifier) || dispatchItemComplete(classifier),
  )
  const complete =
    configurableSlots.every(
      ({ item, slot }) =>
        !itemEnabled(item) ||
        !slot.required ||
        Boolean(bindings[`${item.workItemRef}/${slot.slotRef}`]),
    ) && dispatchComplete
  const requiredMissingWorkItemRefs = new Set<string>([
    ...configurableSlots.flatMap(({ item, slot }) =>
      slot.required && itemEnabled(item) && !bindings[`${item.workItemRef}/${slot.slotRef}`]
        ? [item.workItemRef]
        : [],
    ),
    ...dispatchItems.flatMap((item) =>
      itemEnabled(item) && !dispatchItemComplete(item) ? [item.workItemRef] : [],
    ),
  ])
  const selectedEditorItem =
    props.type.authoringManifest.workItems.find((item) => item.workItemRef === editorWorkItemRef) ??
    null
  const selectedEditorToolSlotTarget = resolveToolSlotTarget(
    selectedEditorItem,
    editorToolSlotTarget?.roleRef,
    editorToolSlotTarget?.slotRef,
  )
  const selectedEditorRole =
    selectedEditorItem?.toolRoleGroups.find(
      (role) => role.roleRef === selectedEditorToolSlotTarget?.roleRef,
    ) ?? null
  const selectedEditorReview =
    selectedEditorToolSlotTarget === null &&
    selectedEditorItem?.humanReview?.optionRef === editorReviewOptionRef
      ? selectedEditorItem.humanReview
      : null
  const selectedEditorContractRef =
    selectedEditorRole?.workContractRef ?? selectedEditorItem?.workContractRef
  const selectedEditorContract =
    props.type.workContracts.find(
      (contract) =>
        contract.contractId === selectedEditorContractRef?.contractId &&
        contract.version === selectedEditorContractRef.version,
    ) ?? null
  const selectedEditorRoleRefs =
    selectedEditorItem === null
      ? []
      : selectedEditorRole === null
        ? primaryToolRoleRefs(selectedEditorItem)
        : [selectedEditorRole.roleRef]
  const dispatchRouteEntries = dispatchItems.flatMap((classifier) =>
    (orderedDispatchRoutes[classifier.workItemRef] ?? []).map((route, index) => ({
      classifier,
      route,
      priority: index + 1,
    })),
  )
  const selectedDispatchRoute =
    dispatchRouteEntries.find((entry) => entry.route.localRef === editorDispatchRouteKey) ?? null
  const selectedDispatchDestination =
    selectedDispatchRoute === null
      ? null
      : (props.type.authoringManifest.workItems.find(
          (item) => item.workItemRef === selectedDispatchRoute.route.destinationWorkItemRef,
        ) ?? null)
  const selectedDispatchTools =
    selectedDispatchRoute === null || selectedDispatchDestination?.nodeKind !== 'business-tool'
      ? []
      : (props.toolsByWorkItem[selectedDispatchDestination.workItemRef] ?? []).filter(
          (tool) =>
            tool.state === 'published' &&
            tool.selection === 'selectable' &&
            toolAcceptsDispatchRoute(
              tool,
              selectedDispatchRoute.classifier.workItemRef,
              selectedDispatchRoute.route.routeRef,
            ),
        )
  const dispatchNodes: ResponsibilityDispatchNode[] = dispatchRouteEntries.map(
    ({ classifier, route, priority }) => {
      const destination = props.type.authoringManifest.workItems.find(
        (item) => item.workItemRef === route.destinationWorkItemRef,
      )
      const tool = (props.toolsByWorkItem[route.destinationWorkItemRef] ?? []).find(
        (candidate) => candidate.id === route.toolId,
      )
      const employeeName = employees.data?.items.find(
        (candidate) => candidate.id === collaborationBindings[route.destinationWorkItemRef],
      )?.name
      const configured = dispatchRouteComplete(classifier, route)
      return {
        key: route.localRef,
        classifierWorkItemRef: classifier.workItemRef,
        destinationWorkItemRef: route.destinationWorkItemRef,
        routeRef: route.routeRef,
        displayName: route.displayName,
        priority,
        configured,
        detail: configured
          ? (tool?.content.displayName ?? employeeName ?? (zh ? '已配置' : 'Configured'))
          : destination?.nodeKind === 'collaboration'
            ? zh
              ? '未选择协同员工'
              : 'Employee missing'
            : zh
              ? '未选择兼容工具'
              : 'Compatible tool missing',
        ...(validationAttempt > 0 && !configured ? { attention: true } : {}),
      }
    },
  )
  const jobCardState = (
    item: WorkItem,
  ): {
    state: 'configured' | 'missing' | 'neutral'
    detail: string
    compactDetail?: string
    attention?: boolean
  } => {
    const optionalLane =
      item.responsibilityLaneId !== null && laneOptional.get(item.responsibilityLaneId) === true
    let configured = item.nodeKind === 'system'
    if (item.nodeKind === 'collaboration') {
      configured = Boolean(collaborationBindings[item.workItemRef])
    } else if (item.orderedDispatchAuthoring !== null) {
      configured = dispatchItemComplete(item)
    } else if (item.nodeKind === 'business-tool') {
      const slots = configurableSlots.filter(
        (candidate) => candidate.item.workItemRef === item.workItemRef,
      )
      const requiredSlots = slots.filter((candidate) => candidate.slot.required)
      configured =
        slots.length === 0 ||
        (requiredSlots.length > 0
          ? requiredSlots.every((candidate) =>
              Boolean(bindings[`${item.workItemRef}/${candidate.slot.slotRef}`]),
            )
          : slots.some((candidate) =>
              Boolean(bindings[`${item.workItemRef}/${candidate.slot.slotRef}`]),
            ))
    }
    const requiredMissing = requiredMissingWorkItemRefs.has(item.workItemRef)
    return configured
      ? {
          state: 'configured',
          detail:
            item.nodeKind === 'system'
              ? zh
                ? '平台固定规则'
                : 'Platform fixed rule'
              : zh
                ? '已配置'
                : 'Configured',
          compactDetail:
            item.nodeKind === 'system' ? (zh ? '固定' : 'Fixed') : zh ? '已配置' : 'Configured',
        }
      : {
          state: 'missing',
          detail: requiredMissing
            ? zh
              ? '必选职责尚未配置'
              : 'Required duty is not configured'
            : optionalLane
              ? zh
                ? '未启用这项可选能力'
                : 'Optional capability is disabled'
              : zh
                ? '尚未配置'
                : 'Not configured',
          compactDetail: requiredMissing
            ? zh
              ? '必选未配'
              : 'Required'
            : optionalLane
              ? zh
                ? '未启用'
                : 'Disabled'
              : zh
                ? '未配置'
                : 'Missing',
          ...(requiredMissing && validationAttempt > 0 ? { attention: true } : {}),
        }
  }
  const jobToolSlotState = (
    target: ResponsibilityToolSlotTarget,
  ): {
    state: 'configured' | 'neutral'
    detail: string
    compactDetail: string
  } => {
    const toolId = bindings[`${target.workItemRef}/${target.slotRef}`]
    const tool = (props.toolsByWorkItem[target.workItemRef] ?? []).find(
      (candidate) => candidate.id === toolId && candidate.content.roleRef === target.roleRef,
    )
    return tool === undefined
      ? {
          state: 'neutral',
          detail: zh ? '尚未选择方案分析工具' : 'No planning tool selected',
          compactDetail: zh ? '未配置' : 'Missing',
        }
      : {
          state: 'configured',
          detail: zh
            ? `已配置：${tool.content.displayName}`
            : `Configured: ${tool.content.displayName}`,
          compactDetail: zh ? '已配置' : 'Configured',
        }
  }
  const firstMissingToolItem = configurableSlots.find(
    ({ item, role, slot }) =>
      slot.required &&
      itemEnabled(item) &&
      !(props.toolsByWorkItem[item.workItemRef] ?? []).some(
        (tool) =>
          tool.state === 'published' &&
          tool.selection === 'selectable' &&
          tool.content.roleRef === role.roleRef,
      ),
  )?.item
  const updateToolBinding = (item: WorkItem, slotRef: string, toolId: string) => {
    setBindings((current) => ({ ...current, [`${item.workItemRef}/${slotRef}`]: toolId }))
    if (item.orderedDispatchAuthoring === null) return
    if (toolId === '') {
      setOrderedDispatchRoutes((current) => ({ ...current, [item.workItemRef]: [] }))
      return
    }
    const tool = (props.toolsByWorkItem[item.workItemRef] ?? []).find(
      (candidate) => candidate.id === toolId,
    )
    const definitions = tool?.content.dispatchRouteDefinitions
    if (definitions === undefined) return
    setOrderedDispatchRoutes((current) => ({
      ...current,
      [item.workItemRef]: deriveDispatchRouteDrafts({
        classifier: item,
        definitions,
        existing: current[item.workItemRef] ?? [],
        workItems: props.type.authoringManifest.workItems,
        toolsByWorkItem: props.toolsByWorkItem,
      }),
    }))
  }
  const updateDispatchRoute = (
    classifierRef: string,
    localRef: string,
    patch: Partial<OrderedDispatchRouteDraft>,
  ) => {
    setOrderedDispatchRoutes((current) => ({
      ...current,
      [classifierRef]: (current[classifierRef] ?? []).map((route) =>
        route.localRef === localRef ? { ...route, ...patch } : route,
      ),
    }))
  }
  const submitJob = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!complete) {
      const firstMissing = [...requiredMissingWorkItemRefs][0]
      const firstMissingDispatchTool = dispatchRouteEntries.find(
        ({ classifier, route }) =>
          /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(route.routeRef) &&
          route.displayName.trim() !== '' &&
          !dispatchRouteComplete(classifier, route),
      )
      setValidationAttempt((current) => current + 1)
      if (firstMissingDispatchTool !== undefined) {
        setEditorWorkItemRef('')
        setEditorToolSlotTarget(null)
        setEditorDispatchRouteKey(firstMissingDispatchTool.route.localRef)
        setDutyOpen(true)
      } else if (firstMissing !== undefined) {
        setEditorDispatchRouteKey(null)
        setEditorWorkItemRef(firstMissing)
        setEditorToolSlotTarget(null)
        setDutyOpen(true)
      }
      return
    }
    save.mutate()
  }
  return (
    <section className={`employee-node-panel${open ? ' job-template-detail-editor' : ''}`}>
      <header>
        <div>
          {open ? null : (
            <span className="employee-node-panel__eyebrow">
              {zh ? '岗位模板' : 'Job templates'}
            </span>
          )}
          <h2>
            {open
              ? zh
                ? `配置岗位模板：${name}`
                : `Configure job template: ${name}`
              : requestedWorkItem !== null
                ? zh
                  ? `配置“${localized(requestedToolRole?.label ?? requestedWorkItem.label, props.language)}”`
                  : `Configure “${localized(requestedToolRole?.label ?? requestedWorkItem.label, props.language)}”`
                : zh
                  ? '给每个职责节点设定默认工具'
                  : 'Choose a default tool for every responsibility'}
          </h2>
          {open ? null : (
            <p>
              {requestedWorkItem !== null
                ? zh
                  ? '这项配置属于岗位模板。选择已有模板会直接打开对应职责；也可以新建模板后继续配置。'
                  : 'This setting belongs to a job template. Choose an existing template to open this duty directly, or create a template and continue there.'
                : zh
                  ? '员工创建时只需选岗位模板；仍可在员工上覆盖个别节点。'
                  : 'An employee chooses one job template and can override individual nodes later.'}
            </p>
          )}
        </div>
        {open ? (
          <div className="employee-summary-card__actions">
            <button
              type="button"
              className="btn"
              onClick={openIdentityEditor}
              disabled={save.isPending}
            >
              {zh ? '基本信息' : 'Basic information'}
            </button>
            <button type="button" className="btn" onClick={closeEditor} disabled={save.isPending}>
              {zh ? '取消编辑' : 'Cancel editing'}
            </button>
            <button
              type="submit"
              form="employee-job-form"
              className="btn btn--primary"
              disabled={name.trim() === '' || save.isPending}
            >
              {save.isPending
                ? zh
                  ? '正在校验并发布…'
                  : 'Validating and publishing…'
                : editingJob?.publishedRevision == null
                  ? zh
                    ? '保存并发布'
                    : 'Save and publish'
                  : zh
                    ? '保存并发布新版本'
                    : 'Save and publish new revision'}
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn--primary" onClick={openNew}>
            {requestedWorkItem !== null
              ? zh
                ? '新建岗位模板并配置此职责'
                : 'New job template and configure this duty'
              : zh
                ? '新建岗位模板'
                : 'New job template'}
          </button>
        )}
      </header>
      {!open && firstMissingToolItem !== undefined ? (
        <NoticeBanner
          tone="info"
          title={zh ? '下一步：给必需工作项增加工具' : 'Next: add a required tool'}
        >
          <span>
            {zh
              ? `“${localized(firstMissingToolItem.label, props.language)}”还没有可用工具。`
              : `“${localized(firstMissingToolItem.label, props.language)}” has no available tool yet.`}
          </span>{' '}
          <Link
            to="/digital-employees/$typeRef"
            params={{ typeRef: props.typeRef }}
            search={{ view: 'toolbox', workItem: firstMissingToolItem.workItemRef }}
            className="btn btn--sm"
          >
            {zh ? '现在增加工具' : 'Add tool now'}
          </Link>
        </NoticeBanner>
      ) : null}
      {!identityOpen && createDraft.isError ? <ErrorBanner error={createDraft.error} /> : null}
      {!open && query.isPending ? <LoadingState /> : null}
      {!open && query.isError ? <ErrorBanner error={query.error} /> : null}
      {!open ? (
        <div className="employee-card-list">
          {query.data?.items.map((job) => (
            <article key={job.id} className="employee-summary-card">
              <div>
                <strong>{job.name}</strong>
                <p>{job.draft.description}</p>
              </div>
              <div className="employee-summary-card__actions">
                <StatusChip kind={job.publishedRevision === null ? 'neutral' : 'success'}>
                  {job.publishedRevision === null
                    ? zh
                      ? '草稿'
                      : 'Draft'
                    : zh
                      ? `可用 · v${job.publishedRevision}`
                      : `Published · v${job.publishedRevision}`}
                </StatusChip>
                <button type="button" className="btn btn--sm" onClick={() => openExisting(job)}>
                  {requestedWorkItem !== null
                    ? zh
                      ? '配置此职责'
                      : 'Configure this duty'
                    : zh
                      ? '修改'
                      : 'Edit'}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {open ? (
        <form
          id="employee-job-form"
          className="employee-job-editor__form"
          data-testid="employee-job-template-editor"
          onSubmit={submitJob}
        >
          <EmployeeCapabilityPanorama
            type={props.type}
            selectedWorkItemRef={selectedEditorItem?.workItemRef ?? null}
            selectedReviewOptionRef={selectedEditorReview?.optionRef ?? null}
            selectedToolSlotTarget={selectedEditorToolSlotTarget}
            toolsByWorkItem={props.toolsByWorkItem}
            language={props.language}
            onSelect={(workItemRef) => {
              setEditorDispatchRouteKey(null)
              setEditorReviewOptionRef(null)
              setEditorToolSlotTarget(null)
              setEditorWorkItemRef(workItemRef)
              setDutyOpen(true)
            }}
            onSelectToolSlot={(target) => {
              setEditorDispatchRouteKey(null)
              setEditorReviewOptionRef(null)
              setEditorToolSlotTarget(target)
              setEditorWorkItemRef(target.workItemRef)
              setDutyOpen(true)
            }}
            onSelectReviewGate={(gate) => {
              setEditorDispatchRouteKey(null)
              setEditorToolSlotTarget(null)
              setEditorWorkItemRef(gate.parentWorkItemRef)
              setEditorReviewOptionRef(gate.optionRef)
              setDutyOpen(true)
            }}
            onConfigureIngress={props.onConfigureIngress}
            dispatchNodes={dispatchNodes}
            selectedDispatchNodeKey={editorDispatchRouteKey}
            onSelectDispatchNode={(node) => {
              setEditorWorkItemRef('')
              setEditorReviewOptionRef(null)
              setEditorToolSlotTarget(null)
              setEditorDispatchRouteKey(node.key)
              setDutyOpen(true)
            }}
            cardIdPrefix="job-duty"
            lanePriorityOrder={reactionLaneOrder}
            onLanePriorityOrderChange={setReactionLaneOrder}
            attentionPulse={validationAttempt}
            cardState={jobCardState}
            toolSlotState={jobToolSlotState}
            compactChrome
          />
          {validationAttempt > 0 && !complete ? (
            <NoticeBanner
              tone="warning"
              title={zh ? '还有必选职责没有配置' : 'Required duties are still missing'}
            >
              {zh
                ? '已高亮对应黄色卡片，并打开第一项职责配置；补齐后再次保存发布。'
                : 'The missing yellow cards are highlighted and the first duty is open. Configure it, then publish again.'}
            </NoticeBanner>
          ) : null}
          <Dialog
            open={dutyOpen && (selectedEditorItem !== null || selectedDispatchRoute !== null)}
            onClose={() => {
              setDutyOpen(false)
              setEditorReviewOptionRef(null)
            }}
            title={
              selectedEditorReview !== null
                ? localized(selectedEditorReview.label, props.language)
                : selectedEditorRole !== null
                  ? zh
                    ? `配置工具：${localized(selectedEditorRole.label, props.language)}`
                    : `Configure tools: ${localized(selectedEditorRole.label, props.language)}`
                  : selectedDispatchRoute !== null
                    ? `${zh ? '配置修复优先级' : 'Configure repair priority'} P${selectedDispatchRoute.priority}：${
                        selectedDispatchRoute.route.displayName.trim() ||
                        selectedDispatchRoute.route.routeRef ||
                        (zh ? '未命名错误类型' : 'Unnamed failure type')
                      }`
                    : selectedEditorItem === null
                      ? zh
                        ? '配置职责'
                        : 'Configure duty'
                      : zh
                        ? `配置职责：${localized(selectedEditorItem.label, props.language)}`
                        : `Configure duty: ${localized(selectedEditorItem.label, props.language)}`
            }
            size="lg"
            panelClassName="employee-job-duty-dialog"
            data-testid="employee-job-duty-dialog"
            footer={
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setDutyOpen(false)
                  setEditorReviewOptionRef(null)
                }}
              >
                {zh ? '完成' : 'Done'}
              </button>
            }
          >
            {selectedEditorReview !== null && selectedEditorItem !== null ? (
              <section
                className="employee-job-duty-editor"
                data-testid="employee-job-review-gate-detail"
              >
                <WorkItemContractCard
                  item={selectedEditorItem}
                  contract={selectedEditorContract}
                  language={props.language}
                  focusHumanReview
                />
                <NoticeBanner
                  tone="info"
                  title={zh ? '可选，任务发起时决定' : 'Optional; decided when work starts'}
                >
                  {zh
                    ? '岗位模板只展示这条人工门禁合同；是否启用由每次任务的冻结输入决定，这里不增加或选择工具。'
                    : 'The job only displays this human-gate contract. Each task’s frozen input decides whether it is enabled; no tool can be added or selected here.'}
                </NoticeBanner>
              </section>
            ) : selectedDispatchRoute !== null && selectedDispatchDestination !== null ? (
              <section
                className="employee-job-duty-editor employee-dispatch-node-editor"
                data-testid="employee-dispatch-node-editor"
              >
                <header>
                  <div>
                    <span>
                      {zh
                        ? `修复优先级 P${selectedDispatchRoute.priority}`
                        : `Repair priority P${selectedDispatchRoute.priority}`}
                    </span>
                    <p>
                      {zh
                        ? `归类节点产出 “${selectedDispatchRoute.route.routeRef || '未填写类型标识'}” 后，只会调度声明支持该类型的工具。`
                        : `When the classifier emits “${selectedDispatchRoute.route.routeRef || 'missing type key'}”, only tools declaring support for that type can be dispatched.`}
                    </p>
                  </div>
                  <StatusChip
                    kind={
                      dispatchRouteComplete(
                        selectedDispatchRoute.classifier,
                        selectedDispatchRoute.route,
                      )
                        ? 'success'
                        : 'warn'
                    }
                  >
                    {dispatchRouteComplete(
                      selectedDispatchRoute.classifier,
                      selectedDispatchRoute.route,
                    )
                      ? zh
                        ? '已配置'
                        : 'Configured'
                      : zh
                        ? '必须配置'
                        : 'Required'}
                  </StatusChip>
                </header>
                <Field
                  label={zh ? '处理方式' : 'Handler'}
                  hint={
                    zh
                      ? '每个问题节点可以分别选择自动修复工具或数字员工协同；切换后会自动清除不兼容的旧工具。'
                      : 'Each problem node can independently use an automated repair tool or employee collaboration. Switching clears an incompatible tool selection.'
                  }
                  required
                >
                  <Select
                    value={selectedDispatchRoute.route.destinationWorkItemRef}
                    onChange={(value) =>
                      updateDispatchRoute(
                        selectedDispatchRoute.classifier.workItemRef,
                        selectedDispatchRoute.route.localRef,
                        {
                          destinationWorkItemRef: value,
                          toolId: '',
                        },
                      )
                    }
                    options={
                      selectedDispatchRoute.classifier.orderedDispatchAuthoring?.destinationWorkItemRefs.flatMap(
                        (workItemRef) => {
                          const item = props.type.authoringManifest.workItems.find(
                            (candidate) => candidate.workItemRef === workItemRef,
                          )
                          return item === undefined
                            ? []
                            : [
                                {
                                  value: workItemRef,
                                  label: localized(item.label, props.language),
                                  description:
                                    item.nodeKind === 'collaboration'
                                      ? zh
                                        ? '数字员工协同'
                                        : 'Employee collaboration'
                                      : zh
                                        ? '自动修复工具'
                                        : 'Automated repair tool',
                                },
                              ]
                        },
                      ) ?? []
                    }
                  />
                </Field>
                {selectedDispatchDestination.nodeKind === 'business-tool' ? (
                  <Field
                    label={zh ? '处理这个错误类型的工具' : 'Tool for this failure type'}
                    hint={
                      selectedDispatchRoute.route.routeRef === ''
                        ? zh
                          ? '先回到归类节点填写类型标识，平台才能进行能力匹配。'
                          : 'Enter the type key on the classifier node before matching tools.'
                        : selectedDispatchTools.length === 0
                          ? zh
                            ? '当前没有工具声明支持这个错误类型。'
                            : 'No tool currently declares support for this failure type.'
                          : zh
                            ? `仅显示支持 ${selectedDispatchRoute.route.routeRef} 的 ${selectedDispatchTools.length} 个工具。`
                            : `Showing ${selectedDispatchTools.length} tool(s) compatible with ${selectedDispatchRoute.route.routeRef}.`
                    }
                    required
                  >
                    <Select
                      value={selectedDispatchRoute.route.toolId}
                      onChange={(value) =>
                        updateDispatchRoute(
                          selectedDispatchRoute.classifier.workItemRef,
                          selectedDispatchRoute.route.localRef,
                          { toolId: value },
                        )
                      }
                      placeholder={
                        selectedDispatchTools.length === 0
                          ? zh
                            ? '没有匹配的工具'
                            : 'No compatible tools'
                          : zh
                            ? '选择兼容工具'
                            : 'Choose a compatible tool'
                      }
                      options={selectedDispatchTools.map((tool) => ({
                        value: tool.id,
                        label: tool.content.displayName,
                        description:
                          tool.content.implementation.kind === 'agent'
                            ? 'Agent'
                            : tool.content.implementation.kind === 'workflow'
                              ? 'Workflow'
                              : zh
                                ? '程序 / 脚本'
                                : 'Program / script',
                      }))}
                    />
                  </Field>
                ) : selectedDispatchDestination.nodeKind === 'collaboration' ? (
                  <Field
                    label={zh ? '处理这个错误类型的数字员工' : 'Employee for this failure type'}
                    required
                  >
                    <Select
                      value={collaborationBindings[selectedDispatchDestination.workItemRef] ?? ''}
                      onChange={(value) =>
                        setCollaborationBindings((current) => ({
                          ...current,
                          [selectedDispatchDestination.workItemRef]: value,
                        }))
                      }
                      searchable
                      placeholder={zh ? '选择数字员工' : 'Choose a digital employee'}
                      options={(employees.data?.items ?? []).map((employee) => ({
                        value: employee.id,
                        label: employee.name,
                      }))}
                    />
                  </Field>
                ) : null}
                {selectedDispatchDestination.nodeKind === 'business-tool' &&
                selectedDispatchTools.length === 0 ? (
                  <NoticeBanner
                    tone="warning"
                    title={zh ? '下一步：增加匹配工具' : 'Next: add a compatible tool'}
                    action={
                      <Link
                        to="/digital-employees/$typeRef"
                        params={{ typeRef: props.typeRef }}
                        search={{
                          view: 'toolbox',
                          workItem: selectedDispatchDestination.workItemRef,
                        }}
                        className="btn btn--sm"
                      >
                        {zh ? '去工具箱增加' : 'Add in toolbox'}
                      </Link>
                    }
                  >
                    {zh
                      ? `新增工具时，在“该工具解决哪些问题”里选择 ${selectedDispatchRoute.route.displayName || selectedDispatchRoute.route.routeRef || '对应问题'}；也可以声明解决全部问题。`
                      : `When adding the tool, select ${selectedDispatchRoute.route.displayName || selectedDispatchRoute.route.routeRef || 'the problem'} under “Problems solved by this tool”, or declare that it solves every problem.`}
                  </NoticeBanner>
                ) : null}
              </section>
            ) : (
              <section className="employee-job-duty-editor">
                <header>
                  <div>
                    <span>{zh ? '当前职责' : 'Selected duty'}</span>
                    {selectedEditorItem === null ? null : (
                      <p>
                        {localized(
                          selectedEditorRole?.description ?? selectedEditorItem.description,
                          props.language,
                        )}
                      </p>
                    )}
                  </div>
                </header>
                {selectedEditorItem?.nodeKind === 'system' ? (
                  <NoticeBanner tone="info" title={zh ? '平台固定职责' : 'Platform-fixed duty'}>
                    {zh
                      ? '这个节点由平台按固定规则执行，不需要岗位再选择工具。'
                      : 'The platform executes this node by fixed rules; the job does not select a tool.'}
                  </NoticeBanner>
                ) : null}
                <div className="job-binding-list">
                  {dispatchItems
                    .filter(
                      (classifier) => classifier.workItemRef === selectedEditorItem?.workItemRef,
                    )
                    .map((classifier) => {
                      const authoring = classifier.orderedDispatchAuthoring!
                      const routes = orderedDispatchRoutes[classifier.workItemRef] ?? []
                      const classifierSlot = classifier.toolRoleGroups.flatMap(
                        (role) => role.bindingSlots,
                      )[0]
                      const classifierToolId =
                        classifierSlot === undefined
                          ? ''
                          : (bindings[`${classifier.workItemRef}/${classifierSlot.slotRef}`] ?? '')
                      const classifierTool = (
                        props.toolsByWorkItem[classifier.workItemRef] ?? []
                      ).find((tool) => tool.id === classifierToolId)
                      return (
                        <section
                          key={`dispatch/${classifier.workItemRef}`}
                          className="job-binding-group job-dispatch-editor"
                          data-testid={`job-dispatch-${classifier.workItemRef}`}
                        >
                          <header>
                            <div>
                              <strong>{localized(authoring.label, props.language)}</strong>
                              <span>
                                {zh
                                  ? '问题清单归分类工具所有；岗位只为自动生成的节点选择处理方式。'
                                  : 'The classifier tool owns the problem list; the job only chooses a handler for each generated node.'}
                              </span>
                            </div>
                            <StatusChip kind={routes.length > 0 ? 'success' : 'warn'}>
                              {routes.length > 0
                                ? zh
                                  ? `${routes.length} 个节点已自动连接`
                                  : `${routes.length} nodes auto-connected`
                                : zh
                                  ? '等待选择分类工具'
                                  : 'Choose a classifier tool'}
                            </StatusChip>
                          </header>
                          {routes.length === 0 ? (
                            <p className="job-dispatch-editor__empty">
                              {zh
                                ? '请在下方选择带问题清单的分类工具；选择后，系统会立即按工具定义的顺序扇出 P1…Pn 节点并连接好线路。'
                                : 'Choose a classifier tool with a problem list below. The system immediately fans out and connects P1…Pn nodes in the tool-defined order.'}
                            </p>
                          ) : (
                            <div className="job-dispatch-routes">
                              {routes.map((route, index) => {
                                const destination = props.type.authoringManifest.workItems.find(
                                  (item) => item.workItemRef === route.destinationWorkItemRef,
                                )
                                const tool = (
                                  props.toolsByWorkItem[route.destinationWorkItemRef] ?? []
                                ).find((candidate) => candidate.id === route.toolId)
                                const employeeName = employees.data?.items.find(
                                  (employee) =>
                                    employee.id ===
                                    collaborationBindings[route.destinationWorkItemRef],
                                )?.name
                                const configured = dispatchRouteComplete(classifier, route)
                                return (
                                  <article key={route.localRef} className="job-dispatch-route">
                                    <header>
                                      <b>P{index + 1}</b>
                                      <strong>
                                        {route.displayName.trim() ||
                                          (zh ? '未命名问题' : 'Unnamed problem')}
                                      </strong>
                                      {index === routes.length - 1 ? (
                                        <StatusChip kind="warn">
                                          {zh ? '兜底问题' : 'Fallback'}
                                        </StatusChip>
                                      ) : null}
                                      <div className="job-dispatch-route__actions">
                                        <button
                                          type="button"
                                          className="btn btn--sm btn--primary"
                                          onClick={() => {
                                            setEditorWorkItemRef('')
                                            setEditorToolSlotTarget(null)
                                            setEditorDispatchRouteKey(route.localRef)
                                          }}
                                        >
                                          {zh ? '配置处理节点' : 'Configure handler node'}
                                        </button>
                                      </div>
                                    </header>
                                    <div className="job-dispatch-route__summary">
                                      <code>{route.routeRef}</code>
                                      <p>
                                        {route.description.trim() ||
                                          (zh
                                            ? `由“${classifierTool?.content.displayName ?? '所选分类工具'}”定义的问题。`
                                            : `Problem defined by “${classifierTool?.content.displayName ?? 'the selected classifier tool'}”.`)}
                                      </p>
                                      <StatusChip kind={configured ? 'success' : 'warn'}>
                                        {configured
                                          ? zh
                                            ? `已连接：${tool?.content.displayName ?? employeeName ?? localized(destination?.label ?? { 'en-US': 'Handler', 'zh-CN': '处理节点' }, props.language)}`
                                            : `Connected: ${tool?.content.displayName ?? employeeName ?? localized(destination?.label ?? { 'en-US': 'Handler', 'zh-CN': '处理节点' }, props.language)}`
                                          : zh
                                            ? '待选择兼容的处理节点'
                                            : 'Choose a compatible handler'}
                                      </StatusChip>
                                    </div>
                                  </article>
                                )
                              })}
                            </div>
                          )}
                        </section>
                      )
                    })}
                  {configurableGroups
                    .filter(({ item }) => item.workItemRef === selectedEditorItem?.workItemRef)
                    .map(({ item, slots }) => {
                      const visibleSlots = slots.filter(({ role }) =>
                        selectedEditorRoleRefs.includes(role.roleRef),
                      )
                      if (visibleSlots.length === 0) return null
                      return (
                        <section key={item.workItemRef} className="job-binding-group">
                          <header>
                            <strong>
                              {selectedEditorRole === null
                                ? localized(item.label, props.language)
                                : localized(selectedEditorRole.label, props.language)}
                            </strong>
                            {item.responsibilityLaneId !== null &&
                            laneOptional.get(item.responsibilityLaneId) === true ? (
                              <StatusChip kind="neutral">
                                {zh
                                  ? '可选能力 · 配置后启用'
                                  : 'Optional · enabled when configured'}
                              </StatusChip>
                            ) : visibleSlots.length > 1 ? (
                              <span>
                                {zh
                                  ? `${visibleSlots.length} 类工具槽位 · 按显示顺序动态调度`
                                  : `${visibleSlots.length} tool slots · dispatched in display order`}
                              </span>
                            ) : null}
                          </header>
                          {visibleSlots.map(({ role, slot }) => {
                            const key = `${item.workItemRef}/${slot.slotRef}`
                            const planningSlot =
                              item.humanReview?.planningRoleRef === role.roleRef &&
                              item.humanReview.planningSlotRef === slot.slotRef
                            const optionalLane =
                              item.responsibilityLaneId !== null &&
                              laneOptional.get(item.responsibilityLaneId) === true
                            const candidates = (
                              props.toolsByWorkItem[item.workItemRef] ?? []
                            ).filter(
                              (tool) =>
                                tool.state === 'published' &&
                                tool.selection === 'selectable' &&
                                tool.content.roleRef === role.roleRef,
                            )
                            return (
                              <Field
                                key={key}
                                label={localized(slot.label, props.language)}
                                hint={
                                  slot.required
                                    ? localized(slot.description, props.language) +
                                      (item.responsibilityLaneId !== null &&
                                      laneOptional.get(item.responsibilityLaneId) === true
                                        ? zh
                                          ? ' · 启用本泳道后必填'
                                          : ' · Required after enabling this lane'
                                        : '')
                                    : `${localized(slot.description, props.language)} · ${
                                        planningSlot
                                          ? zh
                                            ? '可选；未绑定时该岗位不能启用方案评审'
                                            : 'Optional; without a binding this job cannot enable plan review'
                                          : zh
                                            ? '可选，未绑定时使用未知错误兜底'
                                            : 'Optional; falls back to unknown'
                                      }`
                                }
                                required={
                                  slot.required &&
                                  (item.responsibilityLaneId === null ||
                                    laneOptional.get(item.responsibilityLaneId) !== true)
                                }
                              >
                                <Select
                                  value={bindings[key] ?? ''}
                                  onChange={(value) => updateToolBinding(item, slot.slotRef, value)}
                                  placeholder={
                                    candidates.length === 0
                                      ? zh
                                        ? '请先在该节点增加工具'
                                        : 'Add a tool to this node first'
                                      : zh
                                        ? '选择默认工具'
                                        : 'Choose default tool'
                                  }
                                  options={[
                                    ...(!slot.required || optionalLane
                                      ? [
                                          {
                                            value: '',
                                            label: optionalLane
                                              ? zh
                                                ? '不启用这项能力'
                                                : 'Disable this capability'
                                              : planningSlot
                                                ? zh
                                                  ? '不配置（不能启用方案评审）'
                                                  : 'Not configured (plan review unavailable)'
                                                : zh
                                                  ? '不配置（使用未知错误兜底）'
                                                  : 'Not configured (use unknown fallback)',
                                          },
                                        ]
                                      : []),
                                    ...candidates.map((tool) => ({
                                      value: tool.id,
                                      label: tool.content.displayName,
                                    })),
                                  ]}
                                />
                              </Field>
                            )
                          })}
                        </section>
                      )
                    })}
                  {props.type.authoringManifest.workItems
                    .filter(
                      (item) =>
                        item.nodeKind === 'collaboration' &&
                        item.workItemRef === selectedEditorItem?.workItemRef,
                    )
                    .map((item) => (
                      <Field
                        key={`collaboration/${item.workItemRef}`}
                        label={localized(item.label, props.language)}
                        hint={
                          zh
                            ? '可选：需要跨仓协作时，调起哪一名数字员工'
                            : 'Optional: employee invoked for cross-scope collaboration'
                        }
                      >
                        <Select
                          value={collaborationBindings[item.workItemRef] ?? ''}
                          onChange={(value) =>
                            setCollaborationBindings((current) => ({
                              ...current,
                              [item.workItemRef]: value,
                            }))
                          }
                          searchable
                          placeholder={
                            zh ? '不启用协同，或选择数字员工' : 'Disabled, or choose employee'
                          }
                          options={[
                            {
                              value: '',
                              label: zh ? '不启用员工协同' : 'Disable employee collaboration',
                            },
                            ...(employees.data?.items ?? []).map((employee) => ({
                              value: employee.id,
                              label: `${employee.name} · ${employee.definition.workScopeSummary}`,
                            })),
                          ]}
                        />
                      </Field>
                    ))}
                </div>
              </section>
            )}
          </Dialog>
          {save.isError ? <ErrorBanner error={save.error} /> : null}
        </form>
      ) : null}
      <Dialog
        open={identityOpen}
        onClose={closeIdentityEditor}
        title={
          !open && editingJob === null
            ? zh
              ? '新建岗位模板'
              : 'New job template'
            : zh
              ? '修改岗位模板基本信息'
              : 'Edit job template information'
        }
        dismissDisabled={save.isPending || createDraft.isPending}
        data-testid="employee-job-identity-dialog"
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={closeIdentityEditor}
              disabled={createDraft.isPending}
            >
              {zh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              form="employee-job-identity-form"
              className="btn btn--primary"
              disabled={identityName.trim() === '' || createDraft.isPending}
            >
              {createDraft.isPending
                ? zh
                  ? '正在创建草稿…'
                  : 'Creating draft…'
                : open
                  ? zh
                    ? '保存基本信息'
                    : 'Save information'
                  : zh
                    ? '创建并配置职责'
                    : 'Create and configure duties'}
            </button>
          </>
        }
      >
        <form
          id="employee-job-identity-form"
          className="employee-dialog-form"
          onSubmit={confirmIdentity}
        >
          <Field label={zh ? '岗位名称' : 'Template name'} required>
            <TextInput value={identityName} onChange={setIdentityName} autoFocus />
          </Field>
          <Field label={zh ? '说明' : 'Description'}>
            <TextArea value={identityDescription} onChange={setIdentityDescription} />
          </Field>
          {createDraft.isError ? <ErrorBanner error={createDraft.error} /> : null}
        </form>
      </Dialog>
    </section>
  )
}

function EmployeesPanel(props: {
  typeRef: string
  type: EmployeeTypePackage
  language: string
}): ReactElement {
  const zh = props.language.startsWith('zh')
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<DigitalEmployeeDefinition | null>(null)
  const [name, setName] = useState('')
  const [jobId, setJobId] = useState('')
  const firstVariant = props.type.workScopeAuthoring.variants[0]
  const taskLaunchVariant = props.type.workScopeAuthoring.variants.find(
    (variant) => variant.kind === 'task',
  )
  const defaultScopeKind = taskLaunchVariant?.kind ?? firstVariant?.kind ?? ''
  const [scopeKind, setScopeKind] = useState(defaultScopeKind)
  const [scopeValues, setScopeValues] = useState<Record<string, string>>({})
  const employees = useQuery<{ items: DigitalEmployeeDefinition[] }>({
    queryKey: ['digital-employees', props.typeRef],
    queryFn: ({ signal }) =>
      api.get(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/employees`,
        undefined,
        signal,
      ),
  })
  const jobs = useQuery<{ items: JobTemplate[] }>({
    queryKey: ['digital-employee-job-templates', props.typeRef],
    queryFn: ({ signal }) =>
      api.get(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/job-templates`,
        undefined,
        signal,
      ),
  })
  const runtimeOutcomes = useQuery<{ items: EmployeeTerminalOutcomeGroup[] }>({
    queryKey: ['digital-employee-outcomes', 'runtime'],
    queryFn: ({ signal }) => api.get('/api/digital-employees/outcome-summaries', undefined, signal),
  })
  const legacyOutcomes = useQuery<{ items: EmployeeTerminalOutcomeGroup[] }>({
    queryKey: ['digital-employee-outcomes', 'legacy'],
    queryFn: ({ signal }) => api.get('/api/code/missions/outcome-summaries', undefined, signal),
  })
  const repositories = useQuery<{
    items: Array<{ id: string; urlRedacted: string | null }>
  }>({
    queryKey: ['cached-repos', 'employee-scope'],
    enabled: open,
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })
  const repositoryGroups = useQuery<{
    items: Array<{ id: string; name: string; flatRepoCount?: number }>
  }>({
    queryKey: ['repo-groups', 'employee-scope'],
    enabled: open,
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
  })
  const selectedVariant =
    props.type.workScopeAuthoring.variants.find((variant) => variant.kind === scopeKind) ??
    firstVariant
  const closeEditor = () => {
    setOpen(false)
    setEditing(null)
    setName('')
    setJobId('')
    setScopeKind(defaultScopeKind)
    setScopeValues({})
  }
  const openEditor = (employee: DigitalEmployeeDefinition | null) => {
    setEditing(employee)
    setName(employee?.configuration.displayName ?? employee?.name ?? '')
    setJobId(employee?.configuration.jobTemplateRef.id ?? '')
    const scope =
      employee?.configuration.workScope !== null &&
      typeof employee?.configuration.workScope === 'object'
        ? (employee.configuration.workScope as Record<string, unknown>)
        : {}
    setScopeKind(typeof scope.kind === 'string' ? scope.kind : defaultScopeKind)
    setScopeValues(
      Object.fromEntries(
        Object.entries(scope).flatMap(([key, value]) =>
          key === 'kind' || typeof value !== 'string' ? [] : [[key, value]],
        ),
      ),
    )
    setOpen(true)
  }
  const save = useMutation({
    mutationFn: async () => {
      const job = jobs.data?.items.find((candidate) => candidate.id === jobId)
      if (job?.publishedRevision == null) throw new Error('job template is not published')
      if (selectedVariant === undefined) throw new Error('employee type has no work scope')
      const workScope = Object.fromEntries([
        ['kind', selectedVariant.kind],
        ...selectedVariant.fields.map((field) => [
          field.fieldRef,
          scopeValues[field.fieldRef] ?? '',
        ]),
      ])
      const body = {
        name,
        jobTemplateRef: { id: job.id, revision: job.publishedRevision },
        workScope,
        toolOverrides: editing?.configuration.toolOverrides ?? [],
        collaborationOverrides: editing?.configuration.collaborationOverrides ?? [],
      }
      return editing === null
        ? api.post<DigitalEmployeeDefinition>(
            `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/employees`,
            body,
          )
        : api.put<DigitalEmployeeDefinition>(
            `/api/digital-employees/${encodeURIComponent(editing.id)}`,
            body,
          )
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['digital-employees', props.typeRef] })
      await qc.invalidateQueries({ queryKey: ['digital-employees', 'all'] })
      closeEditor()
    },
  })
  const publishedJobs = (jobs.data?.items ?? []).filter((job) => job.publishedRevision !== null)
  const valid =
    name.trim() !== '' &&
    jobId !== '' &&
    selectedVariant !== undefined &&
    selectedVariant.fields.every(
      (field) => !field.required || (scopeValues[field.fieldRef] ?? '').trim() !== '',
    )
  const scopeSelection =
    scopeKind === 'repository'
      ? (scopeValues.repositoryId ?? '')
      : scopeKind === 'repository-group'
        ? `${GROUP_OPTION_PREFIX}${scopeValues.repositoryGroupId ?? ''}`
        : 'task'
  const changeScopeSelection = (value: string) => {
    if (value === 'task') {
      setScopeKind('task')
      setScopeValues({})
      return
    }
    if (value.startsWith(GROUP_OPTION_PREFIX)) {
      setScopeKind('repository-group')
      setScopeValues({ repositoryGroupId: value.slice(GROUP_OPTION_PREFIX.length) })
      return
    }
    setScopeKind('repository')
    setScopeValues({ repositoryId: value })
  }

  return (
    <section className="employee-node-panel" data-testid="digital-employee-definitions">
      <header>
        <div>
          <span className="employee-node-panel__eyebrow">{zh ? '数字员工' : 'Employees'}</span>
          <h2>
            {zh ? '让一名数字员工承担这套职责' : 'Assign this responsibility set to an employee'}
          </h2>
          <p>
            {zh
              ? '只配置岗位、名称和负责范围。自动接活由事件响应规则控制，执行状态在任务中查看。'
              : 'Configure only the job, name, and scope. Event response rules control automatic intake; tasks show execution state.'}
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => openEditor(null)}
          disabled={publishedJobs.length === 0}
        >
          {zh ? '创建数字员工' : 'Create employee'}
        </button>
      </header>
      {!jobs.isPending && publishedJobs.length === 0 ? (
        <NoticeBanner
          tone="info"
          title={zh ? '下一步：先准备岗位模板' : 'Next: prepare a job template'}
        >
          <span>
            {zh
              ? '岗位模板会把每个职责节点绑定到默认工具，页面会指出还缺哪个节点的工具。'
              : 'A job template binds each responsibility to a default tool and shows which node still needs one.'}
          </span>{' '}
          <Link
            to="/digital-employees/$typeRef"
            params={{ typeRef: props.typeRef }}
            search={{ view: 'jobs' }}
            className="btn btn--sm"
          >
            {zh ? '配置岗位模板' : 'Configure job templates'}
          </Link>
        </NoticeBanner>
      ) : null}
      {employees.isPending ? <LoadingState /> : null}
      {employees.isError ? <ErrorBanner error={employees.error} /> : null}
      <div className="employee-card-list">
        {employees.data?.items.map((employee) => {
          const outcomeUnavailable = runtimeOutcomes.isError || legacyOutcomes.isError
          const outcomePending = runtimeOutcomes.isPending || legacyOutcomes.isPending
          const outcomeCounts = employeeTerminalOutcomeCounts(employee.id, [
            runtimeOutcomes.data?.items ?? [],
            legacyOutcomes.data?.items ?? [],
          ])
          return (
            <article
              key={employee.id}
              className="employee-summary-card employee-summary-card--employee"
            >
              <div>
                <strong>{employee.name}</strong>
                <p>
                  {jobs.data?.items.find(
                    (job) => job.id === employee.configuration.jobTemplateRef.id,
                  )?.name ?? (zh ? '岗位模板不可用' : 'Job template unavailable')}
                  {' · '}
                  {employee.definition.workScopeSummary}
                </p>
              </div>
              <div
                className="employee-card-outcomes"
                aria-label={zh ? `${employee.name}的运行成效` : `${employee.name} run outcomes`}
                data-testid={`digital-employee-outcomes-${employee.id}`}
              >
                {outcomeUnavailable ? (
                  <span className="employee-card-outcomes__unavailable">
                    {zh ? '运行成效暂不可用' : 'Run outcomes unavailable'}
                  </span>
                ) : (
                  [
                    [zh ? '已合入' : 'Merged', outcomeCounts.merged],
                    [zh ? '无需修改' : 'No change', outcomeCounts.noChange],
                    [zh ? '其他结束' : 'Other finished', outcomeCounts.otherFinished],
                    [zh ? '执行失败' : 'Failed', outcomeCounts.failed],
                  ].map(([label, value]) => (
                    <span key={label}>
                      <small>{label}</small>
                      <strong>{outcomePending ? '—' : value}</strong>
                    </span>
                  ))
                )}
              </div>
              <div className="employee-summary-card__actions">
                <button type="button" className="btn btn--sm" onClick={() => openEditor(employee)}>
                  {zh ? '编辑' : 'Edit'}
                </button>
                <Link
                  to="/tasks/new"
                  search={{ kind: 'digital-employee', employeeId: employee.id }}
                  className="btn btn--sm"
                  data-testid={`digital-employee-create-task-${employee.id}`}
                >
                  {zh ? '创建任务' : 'Create task'}
                </Link>
              </div>
            </article>
          )
        })}
      </div>
      <Dialog
        open={open}
        onClose={closeEditor}
        title={
          editing === null
            ? zh
              ? '创建数字员工'
              : 'Create digital employee'
            : zh
              ? '编辑数字员工'
              : 'Edit digital employee'
        }
        dismissDisabled={save.isPending}
        footer={
          <>
            <button type="button" className="btn" onClick={closeEditor}>
              {zh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              form="employee-create-form-v2"
              className="btn btn--primary"
              disabled={!valid || save.isPending}
            >
              {editing === null ? (zh ? '创建' : 'Create') : zh ? '保存' : 'Save'}
            </button>
          </>
        }
      >
        <form
          id="employee-create-form-v2"
          className="employee-dialog-form"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <Field label={zh ? '员工名称' : 'Employee name'} required>
            <TextInput value={name} onChange={setName} autoFocus />
          </Field>
          <Field label={zh ? '岗位模板' : 'Job template'} required>
            <Select
              value={jobId}
              onChange={setJobId}
              placeholder={zh ? '请选择岗位模板' : 'Choose a job template'}
              options={publishedJobs.map((job) => ({ value: job.id, label: job.name }))}
            />
          </Field>
          <Field
            label={localized(props.type.workScopeAuthoring.label, props.language)}
            hint={localized(props.type.workScopeAuthoring.description, props.language)}
            required
          >
            <Select
              data-testid="employee-scope-picker"
              value={scopeSelection}
              onChange={changeScopeSelection}
              ariaLabel={localized(props.type.workScopeAuthoring.label, props.language)}
              searchable
              options={[
                {
                  value: 'task',
                  label: zh ? '任务启动时指定仓库' : 'Choose repository when starting a task',
                },
                ...(repositories.data?.items ?? []).map((repository) => ({
                  value: repository.id,
                  label: repository.urlRedacted ?? repository.id,
                })),
                ...(repositoryGroups.data?.items ?? []).map((group) => ({
                  value: `${GROUP_OPTION_PREFIX}${group.id}`,
                  label:
                    group.flatRepoCount === undefined
                      ? `${group.name}${zh ? '（仓库组）' : ' (group)'}`
                      : zh
                        ? `${group.name}（组 · ${group.flatRepoCount} 仓）`
                        : `${group.name} (group · ${group.flatRepoCount} repos)`,
                })),
              ]}
            />
          </Field>
          {save.isError ? <ErrorBanner error={save.error} /> : null}
        </form>
      </Dialog>
    </section>
  )
}
