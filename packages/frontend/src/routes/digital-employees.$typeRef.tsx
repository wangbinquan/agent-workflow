import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { Agent, WorkflowListItem } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import type {
  DigitalEmployeeDefinition,
  EmployeeWorkContract,
  EmployeeTypePackage,
  JobTemplate,
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

function ToolboxPanel(props: {
  typeRef: string
  typeName: string
  item: WorkItem | null
  contract: EmployeeWorkContract | null
  tools: ToolRegistration[]
  language: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  const zh = props.language.startsWith('zh')
  if (props.item === null) return <div />
  const business = props.item.nodeKind === 'business-tool'
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
        {business ? (
          <button type="button" className="btn btn--primary" onClick={() => setOpen(true)}>
            {zh ? '增加工具' : 'Add tool'}
          </button>
        ) : (
          <StatusChip kind="neutral">{zh ? '平台内建步骤' : 'Platform-owned step'}</StatusChip>
        )}
      </header>
      <WorkItemContractCard item={props.item} contract={props.contract} language={props.language} />
      {business ? (
        <div className="node-tool-list">
          {props.tools.length === 0 ? (
            <p className="node-tool-list__empty">
              {zh
                ? '这个工作项还没有工具。增加后可在岗位模板中选择。'
                : 'No tools yet. Add one, then select it in a job template.'}
            </p>
          ) : (
            props.tools.map((tool) => (
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
                <StatusChip
                  kind={
                    tool.state === 'published'
                      ? 'success'
                      : tool.validationReceipt.status === 'invalid'
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {tool.state === 'published'
                    ? zh
                      ? '可用'
                      : 'Available'
                    : tool.validationReceipt.status === 'invalid'
                      ? zh
                        ? '验证失败'
                        : 'Invalid'
                      : zh
                        ? '草稿'
                        : 'Draft'}
                </StatusChip>
              </article>
            ))
          )}
        </div>
      ) : (
        <p className="node-tool-list__empty">
          {zh
            ? '这个节点由平台按固定规则执行，不需要也不允许选择 Agent 或脚本。'
            : 'The platform executes this node by fixed rules; no Agent or script can be attached.'}
        </p>
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
      <AddToolDialog
        open={open}
        onClose={() => setOpen(false)}
        typeRef={props.typeRef}
        item={props.item}
        contract={props.contract}
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
    'pipeline-repair': ['内置 · 流水线修复', 'Built in · Pipeline repair'],
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
  useEffect(() => {
    if (!props.open) return
    if (!allowedKinds.includes(kind)) setKind(allowedKinds[0] ?? 'agent')
    if (!props.item.toolRoleGroups.some((role) => role.roleRef === roleRef)) {
      setRoleRef(props.item.toolRoleGroups[0]?.roleRef ?? '')
    }
    setValidationChecks([])
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
  const create = useMutation({
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
      const draft = await api.post<ToolRegistration>(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/work-items/${encodeURIComponent(props.item.workItemRef)}/tools`,
        {
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
        },
      )
      if (draft.validationReceipt.status !== 'valid') return draft
      await api.post(
        `/api/digital-employee-types/${encodeURIComponent(props.typeRef)}/work-items/${encodeURIComponent(props.item.workItemRef)}/tools/${encodeURIComponent(draft.id)}/publish`,
      )
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
      title={`${zh ? '给工作项增加工具：' : 'Add tool to '}${localized(props.item.label, props.language)}`}
      size="lg"
      dismissDisabled={create.isPending}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose} disabled={create.isPending}>
            {zh ? '取消' : 'Cancel'}
          </button>
          <button
            type="submit"
            form="employee-add-tool-form"
            className="btn btn--primary"
            disabled={
              create.isPending ||
              contractGuide.data === undefined ||
              name.trim() === '' ||
              !resourceValid ||
              !connectionValid
            }
          >
            {create.isPending
              ? zh
                ? '正在验证…'
                : 'Validating…'
              : zh
                ? '检查契约并加入工具箱'
                : 'Check contract and add'}
          </button>
        </>
      }
    >
      <form
        id="employee-add-tool-form"
        className="employee-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
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
        {create.isError ? <ErrorBanner error={create.error} /> : null}
      </form>
    </Dialog>
  )
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
  const configurableSlots = props.type.authoringManifest.workItems.flatMap((item) =>
    item.toolRoleGroups.flatMap((role) => role.bindingSlots.map((slot) => ({ item, role, slot }))),
  )
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [collaborationBindings, setCollaborationBindings] = useState<Record<string, string>>({})
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
    },
  })
  const complete = configurableSlots.every(
    ({ item, slot }) => !slot.required || Boolean(bindings[`${item.workItemRef}/${slot.slotRef}`]),
  )
  const firstMissingToolItem = configurableSlots.find(
    ({ item, role, slot }) =>
      slot.required &&
      !(props.toolsByWorkItem[item.workItemRef] ?? []).some(
        (tool) => tool.state === 'published' && tool.content.roleRef === role.roleRef,
      ),
  )?.item
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
            {configurableSlots.map(({ item, role, slot }) => {
              const key = `${item.workItemRef}/${slot.slotRef}`
              const candidates = (props.toolsByWorkItem[item.workItemRef] ?? []).filter(
                (tool) => tool.state === 'published' && tool.content.roleRef === role.roleRef,
              )
              return (
                <Field
                  key={key}
                  label={`${localized(item.label, props.language)} · ${localized(slot.label, props.language)}`}
                  hint={
                    slot.required
                      ? localized(slot.description, props.language)
                      : `${localized(slot.description, props.language)} · ${zh ? '可选' : 'Optional'}`
                  }
                  required={slot.required}
                >
                  <Select
                    value={bindings[key] ?? ''}
                    onChange={(value) => setBindings((current) => ({ ...current, [key]: value }))}
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
                      ...(slot.required
                        ? []
                        : [
                            {
                              value: '',
                              label: zh
                                ? '不配置（使用兜底工具）'
                                : 'Not configured (use fallback)',
                            },
                          ]),
                      ...candidates.map((tool) => ({
                        value: tool.id,
                        label: tool.content.displayName,
                      })),
                    ]}
                  />
                </Field>
              )
            })}
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
                    options={(employees.data?.items ?? [])
                      .filter((employee) => employee.publishedRevision !== null)
                      .map((employee) => ({
                        value: employee.id,
                        label: `${employee.name} · ${employee.published?.workScopeSummary ?? ''}`,
                      }))}
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
