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
  WorkItem,
} from '@/components/digital-employees/types'
import { localized } from '@/components/digital-employees/types'
import { ResponsibilityGraph } from '@/components/digital-employees/ResponsibilityGraph'
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
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { usePermission } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

type WorkspaceView = 'employees' | 'jobs' | 'toolbox' | 'scope'

interface WorkspaceSearch extends Record<string, unknown> {
  view: WorkspaceView
  workItem?: string
}

function validateSearch(raw: Record<string, unknown>): WorkspaceSearch {
  const view =
    raw.view === 'jobs' || raw.view === 'toolbox' || raw.view === 'scope' ? raw.view : 'employees'
  return {
    view,
    ...(typeof raw.workItem === 'string' && raw.workItem !== '' ? { workItem: raw.workItem } : {}),
  }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/digital-employees/$typeRef',
  validateSearch,
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
    : (workItems[0]?.workItemRef ?? null)
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
  const toolCounts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(toolsByWorkItem).map(([workItemRef, tools]) => [
          workItemRef,
          tools.filter((tool) => tool.state === 'published').length,
        ]),
      ),
    [toolsByWorkItem],
  )
  const selectedItem = workItems.find((item) => item.workItemRef === selectedRef) ?? null
  const panelIds = tabDomIds('digital-employee-type-sections', search.view)

  if (typeQuery.isPending) return <LoadingState />
  if (typeQuery.isError) return <ErrorBanner error={typeQuery.error} />
  const type = typeQuery.data
  const selectedContract =
    type.workContracts.find(
      (contract) =>
        contract.contractId === selectedItem?.workContractRef.contractId &&
        contract.version === selectedItem.workContractRef.version,
    ) ?? null
  const graphMode =
    search.view === 'jobs' ? 'job-template' : search.view === 'toolbox' ? 'toolbox' : 'employee'

  return (
    <div className="page page--operations digital-employee-type-page">
      <div className="operations-surface">
        <PageHeader
          className="operations-surface__header"
          title={localized(type.displayName, language)}
          actions={
            <Link to="/tasks" search={{ category: 'digital-employee' }} className="btn btn--sm">
              {zh ? '查看运行任务' : 'View running tasks'}
            </Link>
          }
        >
          <p className="operations-surface__subtitle">{localized(type.description, language)}</p>
        </PageHeader>

        <div className="digital-employee-surface__body">
          <TabBar
            active={search.view}
            onSelect={(view) => void navigate({ search: { ...search, view }, replace: true })}
            ariaLabel={zh ? '数字员工分类配置' : 'Employee type configuration'}
            idPrefix="digital-employee-type-sections"
            variant="segment"
            tabs={[
              { key: 'employees', label: zh ? '员工' : 'Employees' },
              { key: 'jobs', label: zh ? '岗位模板' : 'Job templates' },
              { key: 'toolbox', label: zh ? '工具箱' : 'Toolbox' },
              { key: 'scope', label: zh ? '适用范围' : 'Scope' },
            ]}
          />

          <section
            className="employee-map-section"
            aria-label={zh ? '职责全景' : 'Responsibility map'}
          >
            <div className="employee-map-section__heading">
              <div>
                <h2>{zh ? '确定性职责全景' : 'Deterministic responsibility map'}</h2>
                <p>
                  {zh
                    ? '生命周期是固定背景；节点和连线由分类程序定义。点击工作项，在同页完成配置。'
                    : 'Lifecycle regions are fixed backgrounds. The type package owns nodes and edges; select a work item to configure it here.'}
                </p>
              </div>
              <span className="employee-map-section__legend">
                {zh ? '全量展开 · 不可拖线' : 'Fully expanded · no edge editing'}
              </span>
            </div>
            <ResponsibilityGraph
              type={type}
              language={language}
              selectedWorkItemRef={selectedRef}
              onSelect={(workItem) =>
                void navigate({
                  search: { ...search, view: 'toolbox', workItem },
                  replace: true,
                })
              }
              toolCounts={toolCounts}
              mode={graphMode}
            />
          </section>

          <div role="tabpanel" id={panelIds.panelId} aria-labelledby={panelIds.tabId} tabIndex={0}>
            {search.view === 'toolbox' ? (
              <ToolboxPanel
                typeRef={typeRef}
                typeName={localized(type.displayName, language)}
                item={selectedItem}
                contract={selectedContract}
                tools={selectedRef === null ? [] : (toolsByWorkItem[selectedRef] ?? [])}
                language={language}
              />
            ) : search.view === 'jobs' ? (
              <JobTemplatesPanel
                typeRef={typeRef}
                type={type}
                toolsByWorkItem={toolsByWorkItem}
                selectedItem={selectedItem}
                language={language}
              />
            ) : search.view === 'scope' ? (
              <ScopePanel typeRef={typeRef} language={language} />
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
}): ReactElement {
  const zh = props.language.startsWith('zh')
  return (
    <div className="work-item-contract-card">
      <div>
        <span>{zh ? '输入材料' : 'Input material'}</span>
        <p>{localized(props.item.materialSummary, props.language)}</p>
        {props.contract === null || props.contract === undefined ? null : (
          <code>{props.contract.inputSchemaId}</code>
        )}
      </div>
      <div>
        <span>{zh ? '确定性产出与完成标准' : 'Deterministic output and completion'}</span>
        <p>{localized(props.item.completionStandard, props.language)}</p>
        {props.contract === null || props.contract === undefined ? null : (
          <code>{props.contract.outputSchemaId}</code>
        )}
      </div>
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

function ToolboxPanel(props: {
  typeRef: string
  typeName: string
  item: WorkItem | null
  contract: EmployeeWorkContract | null
  tools: ToolRegistration[]
  language: string
}): ReactElement {
  const qc = useQueryClient()
  const canUpdate = usePermission('digital-employees:update')
  const canArchive = usePermission('digital-employees:archive')
  const [open, setOpen] = useState(false)
  const [editingTool, setEditingTool] = useState<ToolRegistration | null>(null)
  const zh = props.language.startsWith('zh')
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
  return (
    <section className="employee-node-panel" data-testid="employee-node-toolbox">
      <header>
        <div>
          <span className="employee-node-panel__eyebrow">
            {zh
              ? `数字员工 / ${props.typeName} / ${localized(props.item.label, props.language)} / 工具`
              : `Digital employee / ${props.typeName} / ${localized(props.item.label, props.language)} / Tool`}
          </span>
          <h2>{localized(props.item.label, props.language)}</h2>
          <p>{localized(props.item.description, props.language)}</p>
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
      <WorkItemContractCard item={props.item} contract={props.contract} language={props.language} />
      {business && orderedDispatch !== null ? (
        <section className="employee-dispatch-card" data-testid="employee-runtime-dispatch">
          <header>
            <div>
              <span>{zh ? '运行时动态调度' : 'Runtime dispatch'}</span>
              <strong>{localized(orderedDispatch.label, props.language)}</strong>
            </div>
            <Link
              to="/digital-employees/$typeRef"
              params={{ typeRef: props.typeRef }}
              search={{ view: 'jobs', workItem: props.item.workItemRef }}
              className="btn btn--sm"
            >
              {zh ? '配置错误类型列表' : 'Configure failure types'}
            </Link>
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
              ? `${localized(orderedDispatch.description, props.language)}。类型不是平台枚举；未配置这条泳道时，该数字员工不会订阅或处理流水线失败事件。`
              : `${localized(orderedDispatch.description, props.language)}. Types are not a platform enum; without this lane configuration the employee does not subscribe to pipeline-failure events.`}
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
                    <strong>{tool.content.displayName}</strong>
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
                  </div>
                  <div className="employee-summary-card__actions">
                    <StatusChip kind={status.kind}>{status.label}</StatusChip>
                    {canUpdate ? (
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
                    {canArchive ? (
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
      {business && props.tools.some((tool) => tool.state === 'published') ? (
        <NoticeBanner
          tone="success"
          title={zh ? '这个工作项已有可用工具' : 'This work item has an available tool'}
        >
          <span>
            {zh
              ? '下一步可继续配置其他节点，或把这些工具组合成岗位模板。'
              : 'Next, configure another node or combine these tools into a job template.'}
          </span>{' '}
          <Link
            to="/digital-employees/$typeRef"
            params={{ typeRef: props.typeRef }}
            search={{ view: 'jobs', workItem: props.item.workItemRef }}
            className="btn btn--sm"
          >
            {zh ? '配置岗位模板' : 'Configure job template'}
          </Link>
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
        contract={props.contract}
        tool={editingTool}
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

function AddToolDialog(props: {
  open: boolean
  onClose: () => void
  typeRef: string
  item: WorkItem
  contract: EmployeeWorkContract | null
  tool: ToolRegistration | null
  language: string
}): ReactElement {
  const zh = props.language.startsWith('zh')
  const qc = useQueryClient()
  const [kind, setKind] = useState<'agent' | 'workflow' | 'program'>('agent')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [resource, setResource] = useState('')
  const [source, setSource] = useState('')
  const [parameterValuesJson, setParameterValuesJson] = useState('{}')
  const [runtimeKind, setRuntimeKind] = useState<'bash' | 'node' | 'python'>('bash')
  const [connectionId, setConnectionId] = useState('')
  const [roleRef, setRoleRef] = useState(props.item.toolRoleGroups[0]?.roleRef ?? '')
  const workingToolId = useRef<string | null>(null)
  const editorSessionKey = useRef<string | null>(null)
  const hydratedToolId = useRef<string | null>(null)
  const [validationChecks, setValidationChecks] = useState<
    Array<{ code: string; ok: boolean; detail: string }>
  >([])
  const allowedKinds = useMemo<ReadonlyArray<'agent' | 'workflow' | 'program'>>(
    () => props.contract?.allowedToolKinds ?? [],
    [props.contract],
  )
  const contractKey =
    props.contract === null
      ? null
      : contractRefKey({
          contractId: props.contract.contractId,
          version: props.contract.version,
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
    setRoleRef(props.item.toolRoleGroups[0]?.roleRef ?? '')
    setValidationChecks([])
  }, [allowedKinds, props.item.toolRoleGroups, props.open, props.tool?.id])
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
  }, [authoring.data, props.open, props.tool])
  useEffect(() => {
    if (!props.open) return
    if (!allowedKinds.includes(kind)) setKind(allowedKinds[0] ?? 'agent')
    if (!props.item.toolRoleGroups.some((role) => role.roleRef === roleRef)) {
      setRoleRef(props.item.toolRoleGroups[0]?.roleRef ?? '')
    }
  }, [allowedKinds, kind, props.item.toolRoleGroups, props.open, roleRef])
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
  const workflows = useQuery<WorkflowListItem[]>({
    queryKey: ['digital-employee-workflow-choices'],
    enabled: props.open && kind === 'workflow',
    queryFn: ({ signal }) => api.get('/api/workflows', undefined, signal),
  })
  const connections = useQuery<{ items: DevelopmentAdapterChoice[] }>({
    queryKey: ['digital-employee-tool-connections', props.contract?.requiredConnectionPurpose],
    enabled: props.open && props.contract?.requiredConnectionPurpose != null,
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
        connectionRef:
          props.contract?.requiredConnectionPurpose == null
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
    props.contract?.requiredConnectionPurpose == null ||
    (connections.data?.items.some(
      (candidate) =>
        candidate.id === connectionId &&
        candidate.purpose === props.contract?.requiredConnectionPurpose &&
        candidate.publishedRevision !== null,
    ) ??
      false)

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={
        props.tool === null
          ? `${zh ? '给工作项增加工具：' : 'Add tool to '}${localized(props.item.label, props.language)}`
          : `${zh ? '编辑工具：' : 'Edit tool: '}${props.tool.content.displayName}`
      }
      size="lg"
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
              !connectionValid
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
          contract={props.contract}
          language={props.language}
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
        {props.contract?.requiredConnectionPurpose != null ? (
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
                    candidate.purpose === props.contract?.requiredConnectionPurpose &&
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
              options={props.item.toolRoleGroups.map((role) => ({
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
                    ? '契约声明与 agent-result 输出端口均匹配'
                    : 'Contract declaration and agent-result output both match'
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
                  ? '请先在 Agent 库的“输入/输出 → 平台执行契约”中声明该契约；agent-result 端口由契约自动维护，不能单独编辑或删除。'
                  : 'Declare this contract under Agent library → Inputs & outputs → Platform execution contracts. The contract owns the agent-result port, so it cannot be edited or deleted separately.'}
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

function JobTemplatesPanel(props: {
  typeRef: string
  type: EmployeeTypePackage
  toolsByWorkItem: Record<string, ToolRegistration[]>
  selectedItem: WorkItem | null
  language: string
}): ReactElement {
  const zh = props.language.startsWith('zh')
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
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
    queryFn: ({ signal }) => api.get('/api/digital-employees', undefined, signal),
  })
  const create = useMutation({
    mutationFn: async () => {
      const draft = await api.post<JobTemplate>(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/job-templates`,
        {
          name,
          description,
          defaultToolBindings: configurableSlots.flatMap(({ item, slot }) => {
            const toolId = bindings[`${item.workItemRef}/${slot.slotRef}`]
            if (toolId === undefined || toolId === '') return []
            const tool = props.toolsByWorkItem[item.workItemRef]?.find(
              (candidate) => candidate.id === toolId,
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
              if (employee?.publishedRevision == null || item.collaborationContractId === null) {
                return []
              }
              return [
                {
                  workItemRef: item.workItemRef,
                  targetEmployeeRef: {
                    id: employee.id,
                    revision: employee.publishedRevision,
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
                    (candidate) => candidate.id === route.toolId,
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
        },
      )
      await api.post(`/api/digital-employee-job-templates/${encodeURIComponent(draft.id)}/publish`)
      return draft
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['digital-employee-job-templates', props.typeRef] })
      setOpen(false)
      setName('')
      setDescription('')
      setBindings({})
      setCollaborationBindings({})
      setOrderedDispatchRoutes({})
    },
  })
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
  const dispatchComplete = dispatchItems.every((classifier) => {
    if (!itemEnabled(classifier)) return true
    const routes = orderedDispatchRoutes[classifier.workItemRef] ?? []
    if (routes.length === 0) return false
    return routes.every((route) => {
      const destination = props.type.authoringManifest.workItems.find(
        (item) => item.workItemRef === route.destinationWorkItemRef,
      )
      return (
        /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(route.routeRef) &&
        route.displayName.trim() !== '' &&
        destination !== undefined &&
        (destination.nodeKind === 'collaboration'
          ? Boolean(collaborationBindings[destination.workItemRef])
          : destination.nodeKind === 'business-tool' && route.toolId !== '')
      )
    })
  })
  const complete =
    configurableSlots.every(
      ({ item, slot }) =>
        !itemEnabled(item) ||
        !slot.required ||
        Boolean(bindings[`${item.workItemRef}/${slot.slotRef}`]),
    ) && dispatchComplete
  const firstMissingToolItem = configurableSlots.find(
    ({ item, role, slot }) =>
      slot.required &&
      itemEnabled(item) &&
      !(props.toolsByWorkItem[item.workItemRef] ?? []).some(
        (tool) => tool.state === 'published' && tool.content.roleRef === role.roleRef,
      ),
  )?.item
  const addDispatchRoute = (classifier: WorkItem) => {
    const destinationWorkItemRef =
      classifier.orderedDispatchAuthoring?.destinationWorkItemRefs[0] ?? ''
    const route: OrderedDispatchRouteDraft = {
      localRef: `${classifier.workItemRef}-${++dispatchOrdinal.current}`,
      routeRef: '',
      displayName: '',
      description: '',
      destinationWorkItemRef,
      toolId: '',
    }
    setOrderedDispatchRoutes((current) => ({
      ...current,
      [classifier.workItemRef]: [...(current[classifier.workItemRef] ?? []), route],
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
  const moveDispatchRoute = (classifierRef: string, index: number, delta: -1 | 1) => {
    setOrderedDispatchRoutes((current) => {
      const routes = [...(current[classifierRef] ?? [])]
      const target = index + delta
      if (target < 0 || target >= routes.length) return current
      const [route] = routes.splice(index, 1)
      if (route === undefined) return current
      routes.splice(target, 0, route)
      return { ...current, [classifierRef]: routes }
    })
  }
  const removeDispatchRoute = (classifierRef: string, localRef: string) => {
    setOrderedDispatchRoutes((current) => ({
      ...current,
      [classifierRef]: (current[classifierRef] ?? []).filter(
        (route) => route.localRef !== localRef,
      ),
    }))
  }
  return (
    <section className="employee-node-panel">
      <header>
        <div>
          <span className="employee-node-panel__eyebrow">{zh ? '岗位模板' : 'Job templates'}</span>
          <h2>
            {zh ? '给每个职责节点设定默认工具' : 'Choose a default tool for every responsibility'}
          </h2>
          <p>
            {zh
              ? '员工创建时只需选岗位模板；仍可在员工上覆盖个别节点。'
              : 'An employee chooses one job template and can override individual nodes later.'}
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setOpen(true)}>
          {zh ? '新建岗位模板' : 'New job template'}
        </button>
      </header>
      {props.selectedItem ? (
        <WorkItemContractCard item={props.selectedItem} language={props.language} />
      ) : null}
      {firstMissingToolItem !== undefined ? (
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
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorBanner error={query.error} /> : null}
      <div className="employee-card-list">
        {query.data?.items.map((job) => (
          <article key={job.id} className="employee-summary-card">
            <div>
              <strong>{job.name}</strong>
              <p>{job.draft.description}</p>
            </div>
            <StatusChip kind={job.publishedRevision === null ? 'neutral' : 'success'}>
              {job.publishedRevision === null ? (zh ? '草稿' : 'Draft') : zh ? '可用' : 'Published'}
            </StatusChip>
          </article>
        ))}
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={zh ? '新建岗位模板' : 'New job template'}
        size="lg"
        dismissDisabled={create.isPending}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              {zh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              form="employee-job-form"
              className="btn btn--primary"
              disabled={!complete || name.trim() === '' || create.isPending}
            >
              {zh ? '保存并发布' : 'Save and publish'}
            </button>
          </>
        }
      >
        <form
          id="employee-job-form"
          className="employee-dialog-form"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <Field label={zh ? '岗位名称' : 'Template name'} required>
            <TextInput value={name} onChange={setName} autoFocus />
          </Field>
          <Field label={zh ? '说明' : 'Description'}>
            <TextArea value={description} onChange={setDescription} />
          </Field>
          <div className="job-binding-list">
            {dispatchItems.map((classifier) => {
              const authoring = classifier.orderedDispatchAuthoring!
              const routes = orderedDispatchRoutes[classifier.workItemRef] ?? []
              return (
                <section
                  key={`dispatch/${classifier.workItemRef}`}
                  className="job-binding-group job-dispatch-editor"
                  data-testid={`job-dispatch-${classifier.workItemRef}`}
                >
                  <header>
                    <div>
                      <strong>{localized(authoring.label, props.language)}</strong>
                      <span>{localized(authoring.description, props.language)}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => addDispatchRoute(classifier)}
                    >
                      {zh ? '增加错误类型' : 'Add failure type'}
                    </button>
                  </header>
                  {routes.length === 0 ? (
                    <p className="job-dispatch-editor__empty">
                      {zh
                        ? '未配置：这名数字员工不会启用该泳道，也不会订阅对应事件。'
                        : 'Not configured: this lane stays disabled and its events are not subscribed.'}
                    </p>
                  ) : (
                    <div className="job-dispatch-routes">
                      {routes.map((route, index) => {
                        const destination = props.type.authoringManifest.workItems.find(
                          (item) => item.workItemRef === route.destinationWorkItemRef,
                        )
                        const candidates = (
                          props.toolsByWorkItem[route.destinationWorkItemRef] ?? []
                        ).filter((tool) => tool.state === 'published')
                        return (
                          <article key={route.localRef} className="job-dispatch-route">
                            <header>
                              <b>{index + 1}</b>
                              <strong>
                                {route.displayName.trim() ||
                                  (zh ? '未命名错误类型' : 'Unnamed failure type')}
                              </strong>
                              {index === routes.length - 1 ? (
                                <StatusChip kind="warn">{zh ? '兜底类型' : 'Fallback'}</StatusChip>
                              ) : null}
                              <div className="job-dispatch-route__actions">
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  aria-label={zh ? '提高优先级' : 'Move up'}
                                  disabled={index === 0}
                                  onClick={() =>
                                    moveDispatchRoute(classifier.workItemRef, index, -1)
                                  }
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  aria-label={zh ? '降低优先级' : 'Move down'}
                                  disabled={index === routes.length - 1}
                                  onClick={() =>
                                    moveDispatchRoute(classifier.workItemRef, index, 1)
                                  }
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--sm btn--danger"
                                  onClick={() =>
                                    removeDispatchRoute(classifier.workItemRef, route.localRef)
                                  }
                                >
                                  {zh ? '删除' : 'Remove'}
                                </button>
                              </div>
                            </header>
                            <div className="job-dispatch-route__fields">
                              <Field
                                label={zh ? '类型标识' : 'Type key'}
                                hint={
                                  zh
                                    ? '写入确定性 envelope，例如 compile-error'
                                    : 'Written into the deterministic envelope, e.g. compile-error'
                                }
                                required
                              >
                                <TextInput
                                  value={route.routeRef}
                                  onChange={(value) =>
                                    updateDispatchRoute(classifier.workItemRef, route.localRef, {
                                      routeRef: value,
                                    })
                                  }
                                />
                              </Field>
                              <Field label={zh ? '错误类型名称' : 'Failure type name'} required>
                                <TextInput
                                  value={route.displayName}
                                  onChange={(value) =>
                                    updateDispatchRoute(classifier.workItemRef, route.localRef, {
                                      displayName: value,
                                    })
                                  }
                                />
                              </Field>
                              <Field label={zh ? '处理方式' : 'Handler'} required>
                                <Select
                                  value={route.destinationWorkItemRef}
                                  onChange={(value) =>
                                    updateDispatchRoute(classifier.workItemRef, route.localRef, {
                                      destinationWorkItemRef: value,
                                      toolId: '',
                                    })
                                  }
                                  options={authoring.destinationWorkItemRefs.flatMap(
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
                                            },
                                          ]
                                    },
                                  )}
                                />
                              </Field>
                              {destination?.nodeKind === 'business-tool' ? (
                                <Field label={zh ? '执行工具' : 'Executor'} required>
                                  <Select
                                    value={route.toolId}
                                    onChange={(value) =>
                                      updateDispatchRoute(classifier.workItemRef, route.localRef, {
                                        toolId: value,
                                      })
                                    }
                                    placeholder={
                                      candidates.length === 0
                                        ? zh
                                          ? '先到对应节点增加并发布工具'
                                          : 'Publish a tool on the target node first'
                                        : zh
                                          ? '选择 Agent、Workflow 或脚本'
                                          : 'Choose an Agent, Workflow, or program'
                                    }
                                    options={candidates.map((tool) => ({
                                      value: tool.id,
                                      label: tool.content.displayName,
                                    }))}
                                  />
                                </Field>
                              ) : (
                                <NoticeBanner
                                  tone="info"
                                  title={zh ? '由员工协同配置处理' : 'Handled by collaboration'}
                                >
                                  {zh
                                    ? '在下方“协同其他数字员工”选择目标员工；运行时会调起并等待其结果。'
                                    : 'Choose the target under “Collaborate with another employee” below; runtime invokes it and waits for its result.'}
                                </NoticeBanner>
                              )}
                              <Field label={zh ? '识别说明' : 'Matching description'}>
                                <TextArea
                                  value={route.description}
                                  onChange={(value) =>
                                    updateDispatchRoute(classifier.workItemRef, route.localRef, {
                                      description: value,
                                    })
                                  }
                                />
                              </Field>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
            {configurableGroups.map(({ item, slots }) => (
              <section key={item.workItemRef} className="job-binding-group">
                <header>
                  <strong>{localized(item.label, props.language)}</strong>
                  {item.responsibilityLaneId !== null &&
                  laneOptional.get(item.responsibilityLaneId) === true ? (
                    <StatusChip kind="neutral">
                      {zh ? '可选能力 · 配置后启用' : 'Optional · enabled when configured'}
                    </StatusChip>
                  ) : slots.length > 1 ? (
                    <span>
                      {zh
                        ? `${slots.length} 类工具槽位 · 按显示顺序动态调度`
                        : `${slots.length} tool slots · dispatched in display order`}
                    </span>
                  ) : null}
                </header>
                {slots.map(({ role, slot }) => {
                  const key = `${item.workItemRef}/${slot.slotRef}`
                  const optionalLane =
                    item.responsibilityLaneId !== null &&
                    laneOptional.get(item.responsibilityLaneId) === true
                  const candidates = (props.toolsByWorkItem[item.workItemRef] ?? []).filter(
                    (tool) => tool.state === 'published' && tool.content.roleRef === role.roleRef,
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
                          : `${localized(slot.description, props.language)} · ${zh ? '可选，未绑定时使用未知错误兜底' : 'Optional; falls back to unknown'}`
                      }
                      required={
                        slot.required &&
                        (item.responsibilityLaneId === null ||
                          laneOptional.get(item.responsibilityLaneId) !== true)
                      }
                    >
                      <Select
                        value={bindings[key] ?? ''}
                        onChange={(value) =>
                          setBindings((current) => ({ ...current, [key]: value }))
                        }
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
            ))}
            {props.type.authoringManifest.workItems
              .filter((item) => item.nodeKind === 'collaboration')
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
                    placeholder={zh ? '不启用协同，或选择数字员工' : 'Disabled, or choose employee'}
                    options={[
                      {
                        value: '',
                        label: zh ? '不启用员工协同' : 'Disable employee collaboration',
                      },
                      ...(employees.data?.items ?? [])
                        .filter((employee) => employee.publishedRevision !== null)
                        .map((employee) => ({
                          value: employee.id,
                          label: `${employee.name} · ${employee.published?.workScopeSummary ?? ''}`,
                        })),
                    ]}
                  />
                </Field>
              ))}
          </div>
          {create.isError ? <ErrorBanner error={create.error} /> : null}
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
  const [enabled, setEnabled] = useState<'enabled' | 'disabled'>('enabled')
  const firstVariant = props.type.workScopeAuthoring.variants[0]
  const [scopeKind, setScopeKind] = useState(firstVariant?.kind ?? '')
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
  const repositories = useQuery<{
    items: Array<{ id: string; urlRedacted: string | null }>
  }>({
    queryKey: ['cached-repos', 'employee-scope'],
    enabled: open,
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })
  const repositoryGroups = useQuery<{ items: Array<{ id: string; name: string }> }>({
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
    setEnabled('enabled')
    setScopeKind(firstVariant?.kind ?? '')
    setScopeValues({})
  }
  const openEditor = (employee: DigitalEmployeeDefinition | null) => {
    setEditing(employee)
    setName(employee?.draft.displayName ?? employee?.name ?? '')
    setJobId(employee?.draft.jobTemplateRef.id ?? '')
    setEnabled(employee?.draft.enabled === false ? 'disabled' : 'enabled')
    const scope =
      employee?.draft.workScope !== null && typeof employee?.draft.workScope === 'object'
        ? (employee.draft.workScope as Record<string, unknown>)
        : {}
    setScopeKind(typeof scope.kind === 'string' ? scope.kind : (firstVariant?.kind ?? ''))
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
        enabled: enabled === 'enabled',
        workScope,
        toolOverrides: editing?.draft.toolOverrides ?? [],
        collaborationOverrides: editing?.draft.collaborationOverrides ?? [],
      }
      const draft =
        editing === null
          ? await api.post<DigitalEmployeeDefinition>(
              `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/employees`,
              body,
            )
          : await api.put<DigitalEmployeeDefinition>(
              `/api/digital-employees/${encodeURIComponent(editing.id)}`,
              body,
            )
      await api.post(`/api/digital-employees/${encodeURIComponent(draft.id)}/publish`)
      return draft
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['digital-employees', props.typeRef] })
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
              ? '只配置岗位、名称、启停和负责范围。事件、流程与重试由分类和全局设置决定。'
              : 'Configure only the job, name, enabled state, and scope. The type and global settings own events, flow, and retry.'}
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
        {employees.data?.items.map((employee) => (
          <article key={employee.id} className="employee-summary-card">
            <div>
              <strong>{employee.name}</strong>
              <p>
                {jobs.data?.items.find((job) => job.id === employee.draft.jobTemplateRef.id)
                  ?.name ?? (zh ? '岗位模板不可用' : 'Job template unavailable')}
                {' · '}
                {employee.published?.workScopeSummary ?? (zh ? '尚未发布' : 'Not published')}
              </p>
            </div>
            <div className="employee-summary-card__actions">
              <StatusChip kind={employee.published?.enabled ? 'success' : 'neutral'}>
                {employee.published?.enabled
                  ? zh
                    ? '工作中'
                    : 'Enabled'
                  : zh
                    ? '未启用'
                    : 'Disabled'}
              </StatusChip>
              <button type="button" className="btn btn--sm" onClick={() => openEditor(employee)}>
                {zh ? '编辑' : 'Edit'}
              </button>
              {employee.publishedRevision !== null ? (
                <Link to="/tasks" search={{ category: 'digital-employee' }} className="btn btn--sm">
                  {zh ? '查看任务' : 'Tasks'}
                </Link>
              ) : null}
            </div>
          </article>
        ))}
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
              {editing === null
                ? zh
                  ? '创建并发布'
                  : 'Create and publish'
                : zh
                  ? '保存并发布新版本'
                  : 'Save and publish revision'}
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
          <Field label={zh ? '工作状态' : 'Work status'} group>
            <Segmented
              value={enabled}
              onChange={setEnabled}
              ariaLabel={zh ? '数字员工工作状态' : 'Digital employee work status'}
              options={[
                { value: 'enabled', label: zh ? '启用' : 'Enabled' },
                { value: 'disabled', label: zh ? '停用' : 'Disabled' },
              ]}
            />
          </Field>
          <Field
            label={localized(props.type.workScopeAuthoring.label, props.language)}
            hint={localized(props.type.workScopeAuthoring.description, props.language)}
            group
          >
            <Segmented
              value={scopeKind}
              onChange={(next) => {
                setScopeKind(next)
                setScopeValues({})
              }}
              ariaLabel={localized(props.type.workScopeAuthoring.label, props.language)}
              options={props.type.workScopeAuthoring.variants.map((variant) => ({
                value: variant.kind,
                label: localized(variant.label, props.language),
              }))}
            />
          </Field>
          {selectedVariant?.fields.map((field) => (
            <Field
              key={field.fieldRef}
              label={localized(field.label, props.language)}
              hint={localized(field.description, props.language)}
              required={field.required}
            >
              {field.inputKind === 'repository-picker' ? (
                <Select
                  value={scopeValues[field.fieldRef] ?? ''}
                  onChange={(value) =>
                    setScopeValues((current) => ({
                      ...current,
                      [field.fieldRef]: value,
                    }))
                  }
                  placeholder={
                    field.placeholder === null
                      ? zh
                        ? '请选择'
                        : 'Choose'
                      : localized(field.placeholder, props.language)
                  }
                  searchable
                  options={(repositories.data?.items ?? []).map((repository) => ({
                    value: repository.id,
                    label: repository.urlRedacted ?? repository.id,
                  }))}
                />
              ) : field.inputKind === 'repository-group-picker' ? (
                <Select
                  value={scopeValues[field.fieldRef] ?? ''}
                  onChange={(value) =>
                    setScopeValues((current) => ({
                      ...current,
                      [field.fieldRef]: value,
                    }))
                  }
                  placeholder={
                    field.placeholder === null
                      ? zh
                        ? '请选择'
                        : 'Choose'
                      : localized(field.placeholder, props.language)
                  }
                  searchable
                  options={(repositoryGroups.data?.items ?? []).map((group) => ({
                    value: group.id,
                    label: group.name,
                  }))}
                />
              ) : (
                <TextInput
                  value={scopeValues[field.fieldRef] ?? ''}
                  placeholder={
                    field.placeholder === null
                      ? undefined
                      : localized(field.placeholder, props.language)
                  }
                  onChange={(value) =>
                    setScopeValues((current) => ({
                      ...current,
                      [field.fieldRef]: value,
                    }))
                  }
                />
              )}
            </Field>
          ))}
          {save.isError ? <ErrorBanner error={save.error} /> : null}
        </form>
      </Dialog>
    </section>
  )
}

function ScopePanel(props: { typeRef: string; language: string }): ReactElement {
  const zh = props.language.startsWith('zh')
  const query = useQuery<{ items: DigitalEmployeeDefinition[] }>({
    queryKey: ['digital-employees', props.typeRef],
    queryFn: ({ signal }) =>
      api.get(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/employees`,
        undefined,
        signal,
      ),
  })
  return (
    <section className="employee-node-panel">
      <header>
        <div>
          <span className="employee-node-panel__eyebrow">{zh ? '适用范围' : 'Scope'}</span>
          <h2>{zh ? '按员工查看当前负责范围' : 'Employee responsibility scopes'}</h2>
          <p>
            {zh
              ? '范围属于员工定义，不在工作项或工具上重复配置。'
              : 'Scope belongs to the employee definition and is not repeated on work items or tools.'}
          </p>
        </div>
      </header>
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorBanner error={query.error} /> : null}
      <div className="employee-card-list">
        {query.data?.items.map((employee) => (
          <article key={employee.id} className="employee-summary-card">
            <strong>{employee.name}</strong>
            <p>
              {employee.published?.workScopeSummary ??
                (zh ? '草稿尚未发布' : 'Draft not published')}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}
