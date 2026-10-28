import { useCallback, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type {
  GraphDesignActionRequest,
  GraphDesignDocument,
  GraphImplementationBasis,
  GraphProposal,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { Field, TextArea, TextInput, Switch } from '@/components/Form'
import { Select } from '@/components/Select'
import { ErrorBanner } from '@/components/ErrorBanner'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Prose } from '@/components/prose/Prose'
import { saveBlobAs } from '@/lib/download'
import { GraphModelView } from './GraphModelView'
import { GraphDesignEditDialog } from './GraphDesignEditors'
import { GraphDesignEvidence } from './GraphDesignEvidence'
import { GraphDesignDelivery } from './GraphDesignDelivery'
import type { GraphDeliveryProgress } from './graphDeliveryModel'
import { DecisionReadback } from '@/components/clarify/mindmap/DecisionDetails'
import {
  graphChangeLabel,
  graphDocumentChanges,
  graphSelectionAnchor,
  graphStateLabel,
  type GraphWorkspaceData,
  type GraphViewData,
  type GraphEvidenceData,
  type GraphVerificationProfile,
} from './graphDesignModel'
import './GraphDesignWorkspace.css'

export function GraphDesignWorkspace({
  caseId,
  canOperate,
  executionAvailable,
  initialSelection,
  initialView,
  deliveryProgress,
}: {
  caseId: string
  canOperate: boolean
  executionAvailable: boolean
  initialSelection?: string[]
  initialView?: string
  deliveryProgress?: GraphDeliveryProgress
}) {
  const { i18n } = useTranslation(),
    zh = (i18n.resolvedLanguage ?? i18n.language).startsWith('zh')
  const client = useQueryClient()
  const key = ['graph-design', caseId]
  const pendingRequests = useRef(new Map<string, string>())
  async function postRequest<T = unknown>(url: string, body: Record<string, unknown>): Promise<T> {
    const fingerprint = JSON.stringify([url, body])
    const requestId = pendingRequests.current.get(fingerprint) ?? crypto.randomUUID()
    pendingRequests.current.set(fingerprint, requestId)
    const response = await api.post<T>(url, { ...body, requestId })
    pendingRequests.current.delete(fingerprint)
    return response
  }
  const [revision, setRevision] = useState('current')
  const [viewId, setViewId] = useState<string | null>(initialView ?? null)
  const [offset, setOffset] = useState(0)
  const [viewSearch, setViewSearch] = useState('')
  const [focusId, setFocusId] = useState<string | null>(initialSelection?.[0] ?? null)
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelection ?? [])
  const [editing, setEditing] = useState(false)
  const [action, setAction] = useState<GraphDesignActionRequest['action'] | 'clarification' | null>(
    null,
  )
  const [instruction, setInstruction] = useState('')
  const [withdrawReview, setWithdrawReview] = useState(false)
  const [proposalId, setProposalId] = useState<string | null>(null)
  const [limitationReviewOpen, setLimitationReviewOpen] = useState(false)
  const [limitationReason, setLimitationReason] = useState('')
  const [basisId, setBasisId] = useState<string | null>(null)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [scopeIds, setScopeIds] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [followOnCaseId, setFollowOnCaseId] = useState<string | null>(null)
  const identity = useQuery<{ id: string } | null>({
    queryKey: [...key, 'identity'],
    queryFn: ({ signal }) =>
      api.get(`/api/employee-cases/${encodeURIComponent(caseId)}/design`, undefined, signal),
    refetchInterval: (query) => (query.state.data ? false : 5000),
  })
  const id = identity.data?.id,
    base = `/api/development-designs/${encodeURIComponent(id ?? '')}`
  const workspace = useQuery<GraphWorkspaceData>({
    queryKey: [...key, 'workspace', id, revision],
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      api.get(base, revision === 'current' ? undefined : { revision }, signal),
    refetchInterval: revision === 'current' ? 5000 : false,
  })
  const data = workspace.data,
    document = data?.document
  const current = Boolean(
    document && document.revision === data?.currentRevision && revision === 'current',
  )
  const terminal = data?.host.state === 'terminal' || deliveryProgress?.caseState === 'terminal'
  const canEdit = canOperate && current && !terminal
  const activeView =
    document?.views.find((view) => view.id === viewId) ??
    document?.views.find((view) => view.status !== 'archived')
  const view = useQuery<GraphViewData>({
    queryKey: [...key, 'view', activeView?.id, document?.revision, offset, viewSearch, focusId],
    enabled: Boolean(document && activeView),
    queryFn: ({ signal }) =>
      api.get(
        `${base}/views/${encodeURIComponent(activeView!.id)}`,
        {
          revision: document!.revision,
          offset,
          limit: 50,
          ...(viewSearch ? { search: viewSearch } : {}),
          ...(focusId ? { focusId } : {}),
        },
        signal,
      ),
  })
  const evidence = useQuery<GraphEvidenceData>({
    queryKey: [...key, 'evidence', document?.revision],
    enabled: Boolean(document),
    queryFn: ({ signal }) => api.get(`${base}/evidence`, undefined, signal),
    refetchInterval: 5000,
  })
  const profiles = useQuery<GraphVerificationProfile[]>({
    queryKey: [...key, 'profiles'],
    enabled: Boolean(id),
    queryFn: ({ signal }) => api.get(`${base}/verification-profiles`, undefined, signal),
  })
  const proposal = useQuery<GraphProposal>({
    queryKey: [...key, 'proposal', proposalId, document?.revision],
    enabled: Boolean(id && proposalId),
    queryFn: ({ signal }) =>
      api.get(`${base}/proposals/${encodeURIComponent(proposalId!)}`, undefined, signal),
  })
  const basis = useQuery<{ basis: GraphImplementationBasis; staleIds: string[] }>({
    queryKey: [...key, 'basis', basisId, document?.revision],
    enabled: Boolean(id && basisId),
    queryFn: ({ signal }) =>
      api.get(`${base}/bases/${encodeURIComponent(basisId!)}`, undefined, signal),
  })
  const command = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => await operation(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key })
      await client.invalidateQueries({ queryKey: ['employee-case', caseId] })
    },
  })
  const perform = async (operation: () => Promise<unknown>) => {
    try {
      await command.mutateAsync(operation)
      return true
    } catch {
      return false
    }
  }
  const save = async (next: GraphDesignDocument) =>
    perform(() =>
      postRequest(`${base}/changes`, { expectedRevision: next.revision, document: next }),
    )
  const toggleSelection = useCallback(
    (selected: string) =>
      setSelectedIds((previous) =>
        previous.includes(selected)
          ? previous.filter((id) => id !== selected)
          : [...previous, selected],
      ),
    [],
  )
  const locate = (selected: string) => {
    setSelectedIds([selected])
    setOffset(0)
    setViewSearch('')
    setFocusId(selected)
    const target = document?.views.find(
      (view) =>
        view.status !== 'archived' &&
        (view.elementIds.includes(selected) ||
          view.relationIds.includes(selected) ||
          view.modelIds.some((id) =>
            JSON.stringify(document.models.find((model) => model.id === id)).includes(
              `"${selected}"`,
            ),
          )),
    )
    if (target) setViewId(target.id)
  }
  const openAction = (next: NonNullable<typeof action>) => {
    setInstruction('')
    setWithdrawReview(false)
    setAction(next)
    command.reset()
  }
  const busy = command.isPending
  if (identity.error || workspace.error)
    return (
      <ErrorBanner
        error={identity.error ?? workspace.error}
        onRetry={() => void client.invalidateQueries({ queryKey: key })}
      />
    )
  if (identity.isLoading || workspace.isLoading) return <LoadingState />
  if (!document || !data)
    return (
      <EmptyState
        title={zh ? '设计正在准备' : 'Preparing the design'}
        description={
          zh
            ? '需求受理后会在这里展示关注点、图组合和待澄清问题。'
            : 'Concerns, views and questions appear here after intake.'
        }
      />
    )
  const selected = new Set(selectedIds)
  const selectedElements = document.elements.filter((element) => selected.has(element.id))
  const selectedRelations = document.relations.filter((relation) => selected.has(relation.id))
  const changes = proposal.data
    ? graphDocumentChanges(document, proposal.data.document, proposal.data.readSet)
    : []
  const reviews = basis.data
    ? data.executionLinks
        .flatMap((link) =>
          link.receipt?.basisDigest === basis.data?.basis.digest ? [link.receipt] : [],
        )
        .sort((a, b) => b.decidedAt - a.decidedAt)
    : []
  const approval = reviews[0]?.decision === 'approved' ? reviews[0] : null
  const actionEnabled = canEdit && executionAvailable && !busy
  const clarificationEnabled = canOperate && current && executionAvailable && !busy
  const presentation = activeView
    ? (data.presentation[activeView.id] ?? {
        viewId: activeView.id,
        revision: 1,
        collapsedIds: [],
        positions: {},
        viewport: { x: 0, y: 0, zoom: 1 },
      })
    : null
  const savePresentation = (next: NonNullable<typeof presentation>) =>
    perform(() =>
      api.put(`${base}/presentation`, {
        expectedRevision: data.presentationRevision,
        views: { ...data.presentation, [next.viewId]: next },
      }),
    )
  return (
    <div className="graph-design" data-testid="graph-design-workspace">
      {deliveryProgress && <GraphDesignDelivery progress={deliveryProgress} zh={zh} />}
      <Card
        title={document.title}
        actions={
          <Field label={zh ? '版本' : 'Revision'}>
            <Select
              value={revision}
              onChange={(value) => {
                setRevision(value)
                setSelectedIds([])
                setOffset(0)
              }}
              options={[
                {
                  value: 'current',
                  label: zh
                    ? `当前版本 ${data.currentRevision}`
                    : `Current revision ${data.currentRevision}`,
                },
                ...data.revisions.map((row) => ({
                  value: String(row.revision),
                  label: `v${row.revision} · ${new Date(row.createdAt).toLocaleString()}`,
                })),
              ]}
            />
          </Field>
        }
      >
        <div className="graph-design__stack">
          <p>{document.goals.join('\n')}</p>
          {!current && (
            <NoticeBanner tone="info">
              {zh
                ? '正在查看历史快照。返回当前版本后可编辑。'
                : 'Viewing a historical snapshot. Return to the current revision to edit.'}
            </NoticeBanner>
          )}
          {terminal && (
            <NoticeBanner
              tone="info"
              action={
                <Link
                  to="/tasks/employee-cases/$caseId"
                  params={{ caseId }}
                  search={{ tab: 'artifacts' }}
                  className="btn btn--sm"
                >
                  {zh ? '查看交付产物' : 'View delivery artifacts'}
                </Link>
              }
            >
              {zh
                ? '此任务已结束，设计和证据保留供查阅。'
                : 'This case has ended. Design and evidence remain available for inspection.'}
            </NoticeBanner>
          )}
          {command.error && <ErrorBanner error={command.error} onDismiss={() => command.reset()} />}
          {notice && (
            <NoticeBanner
              tone="info"
              dismiss={{ label: zh ? '关闭' : 'Close', onDismiss: () => setNotice('') }}
            >
              {notice}
            </NoticeBanner>
          )}
          {followOnCaseId && (
            <Link
              to="/tasks/employee-cases/$caseId"
              params={{ caseId: followOnCaseId }}
              search={{ tab: 'design' }}
            >
              {zh ? '打开后续工作' : 'Open follow-on case'}
            </Link>
          )}
          {!terminal && data.host.editableClarify && (
            <NoticeBanner
              tone="warning"
              action={
                <Link
                  to="/tasks/$id"
                  params={{ id: data.host.editableClarify.taskId }}
                  className="btn btn--sm btn--primary"
                >
                  {zh ? '回答原问题' : 'Answer original questions'}
                </Link>
              }
            >
              {zh
                ? '当前有待回答的澄清问题。回答、选择和判断会从原问题同步到这里。'
                : 'Clarification is awaiting your answer. Original choices and judgments are synchronized here.'}
            </NoticeBanner>
          )}
          {!terminal && data.host.workItemRef === 'review-design' && data.host.executionRef && (
            <NoticeBanner
              tone="info"
              action={
                <Link
                  to="/tasks/$id"
                  params={{ id: data.host.executionRef }}
                  className="btn btn--sm btn--primary"
                >
                  {zh ? '打开人工审核' : 'Open human review'}
                </Link>
              }
            >
              {zh
                ? '实现依据正在审核。补充澄清须明确撤回本次审核。'
                : 'The basis is under review. Further clarification requires withdrawing this review.'}
            </NoticeBanner>
          )}
          <div className="graph-design__actions">
            <button
              type="button"
              className="btn"
              disabled={!actionEnabled}
              onClick={() => openAction('replan')}
            >
              {zh ? '调整图组合' : 'Adapt the view combination'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!actionEnabled}
              onClick={() => openAction('inspect-exceptions')}
            >
              {zh ? '检查遗漏与例外' : 'Inspect gaps and exceptions'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!canEdit || busy}
              onClick={() => setEditing(true)}
            >
              {zh ? '编辑设计与验证安排' : 'Edit design and verification'}
            </button>
            {!terminal && (
              <button
                type="button"
                className={`btn ${!data.host.workItemRef || data.host.workItemRef === 'design-and-clarify' ? 'btn--primary' : ''}`}
                disabled={!canEdit || busy || !document.elements.length}
                onClick={() => {
                  setScopeIds(
                    selectedElements.length
                      ? selectedElements.map((e) => e.id)
                      : document.elements.map((e) => e.id),
                  )
                  setScopeOpen(true)
                }}
              >
                {zh ? '预览实现依据' : 'Preview implementation basis'}
              </button>
            )}
          </div>
        </div>
      </Card>
      <div className="graph-design__columns">
        <div className="graph-design__stack">
          <Card title={zh ? '当前图组合' : 'Current view combination'}>
            <ul className="graph-design__list">
              {document.views
                .filter((view) => view.status !== 'archived')
                .map((view) => (
                  <li key={view.id}>
                    <button
                      type="button"
                      className={`btn ${activeView?.id === view.id ? 'btn--primary' : ''}`}
                      aria-pressed={activeView?.id === view.id}
                      onClick={() => {
                        setViewId(view.id)
                        setOffset(0)
                        setFocusId(null)
                        setSelectedIds([])
                      }}
                    >
                      {view.title}
                      {view.pinned ? (zh ? ' · 固定' : ' · Pinned') : ''}
                    </button>
                    <p className="muted">{view.purpose}</p>
                    {view.status === 'needs-update' && (
                      <NoticeBanner tone="warning" size="compact">
                        {zh ? '所依据内容已变化，待更新' : 'Source changed; update needed'}
                      </NoticeBanner>
                    )}
                  </li>
                ))}
            </ul>
            {!document.views.some((view) => view.status !== 'archived') && (
              <EmptyState
                size="compact"
                title={zh ? '尚无合适图组合' : 'No suitable views yet'}
                description={
                  zh ? '补充需求或生成组合提案。' : 'Add requirements or request a proposal.'
                }
              />
            )}
          </Card>
          <Card title={zh ? '要解决的问题' : 'Concerns to address'}>
            <ul className="graph-design__list">
              {document.concerns.map((concern) => (
                <li key={concern.id}>
                  <strong>{concern.statement}</strong>
                  <p>
                    {graphStateLabel(concern.priority, zh)} ·{' '}
                    {graphStateLabel(concern.disposition, zh)}
                  </p>
                  <p className="muted">{concern.dispositionReason}</p>
                  <div className="graph-design__actions">
                    {document.views
                      .filter(
                        (view) =>
                          view.status !== 'archived' && view.concernIds.includes(concern.id),
                      )
                      .map((view) => (
                        <button
                          type="button"
                          key={view.id}
                          className="btn btn--xs"
                          onClick={() => {
                            setViewId(view.id)
                            setOffset(0)
                            setFocusId(null)
                          }}
                        >
                          {view.title}
                        </button>
                      ))}
                  </div>
                  {concern.priority === 'required' && concern.disposition === 'open' && (
                    <NoticeBanner tone="warning" size="compact">
                      {zh
                        ? '必须解决后才能形成实现依据'
                        : 'Resolve before freezing an implementation basis'}
                    </NoticeBanner>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <Card
          title={activeView?.title ?? (zh ? '语义模型' : 'Semantic model')}
          actions={
            activeView &&
            canEdit && (
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy}
                onClick={() =>
                  void save({
                    ...document,
                    views: document.views.map((view) =>
                      view.id === activeView.id ? { ...view, pinned: !view.pinned } : view,
                    ),
                  })
                }
              >
                {activeView.pinned
                  ? zh
                    ? '取消固定'
                    : 'Unpin'
                  : zh
                    ? '固定此图'
                    : 'Pin this view'}
              </button>
            )
          }
        >
          <div className="graph-design__stack">
            {activeView && (
              <>
                <p>{activeView.explanation}</p>
                {activeView.limitations.map((limitation, index) => (
                  <NoticeBanner tone="info" key={index}>
                    {limitation}
                  </NoticeBanner>
                ))}
              </>
            )}
            {view.error && <ErrorBanner error={view.error} onRetry={() => void view.refetch()} />}
            {view.isLoading && <LoadingState />}
            {view.data?.available === false && (
              <NoticeBanner tone="warning">
                {zh
                  ? '此历史表达器版本不可用，仍可阅读下方语义列表。'
                  : 'This renderer version is unavailable. The semantic list remains readable.'}
              </NoticeBanner>
            )}
            {view.data?.scope.truncated && !view.data.renderings.length && (
              <NoticeBanner tone="info">
                {zh
                  ? '此图范围较大，当前以分页列表展示完整语义；可围绕所选范围生成更小视图。'
                  : 'This large view uses a paged semantic list. Select a scope to request a smaller view.'}
              </NoticeBanner>
            )}
            {presentation && (
              <div className="graph-design__actions">
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={!canEdit || busy || presentation.viewport.zoom <= 0.5}
                  onClick={() =>
                    void savePresentation({
                      ...presentation,
                      viewport: {
                        ...presentation.viewport,
                        zoom: Math.max(0.5, presentation.viewport.zoom - 0.25),
                      },
                    })
                  }
                >
                  {zh ? '缩小' : 'Zoom out'}
                </button>
                <span>{Math.round(presentation.viewport.zoom * 100)}%</span>
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={!canEdit || busy || presentation.viewport.zoom >= 2}
                  onClick={() =>
                    void savePresentation({
                      ...presentation,
                      viewport: {
                        ...presentation.viewport,
                        zoom: Math.min(2, presentation.viewport.zoom + 0.25),
                      },
                    })
                  }
                >
                  {zh ? '放大' : 'Zoom in'}
                </button>
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={!canEdit || busy}
                  onClick={() =>
                    void savePresentation({
                      ...presentation,
                      collapsedIds: presentation.collapsedIds.includes('semantic-list')
                        ? []
                        : ['semantic-list'],
                    })
                  }
                >
                  {presentation.collapsedIds.includes('semantic-list')
                    ? zh
                      ? '展开列表'
                      : 'Expand list'
                    : zh
                      ? '折叠列表'
                      : 'Collapse list'}
                </button>
              </div>
            )}
            <div style={{ zoom: presentation?.viewport.zoom ?? 1 }}>
              {view.data?.renderings.map((rendering) => (
                <GraphModelView
                  key={rendering.modelId}
                  rendering={rendering}
                  selectedIds={selectedIds}
                  onSelect={toggleSelection}
                  zh={zh}
                />
              ))}
            </div>
            <div className="graph-design__actions">
              <button
                type="button"
                className="btn btn--sm"
                disabled={!actionEnabled || !selectedIds.length}
                onClick={() => openAction('explain')}
              >
                {zh ? '解释所选内容' : 'Explain selection'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                disabled={
                  !clarificationEnabled || (!terminal && Boolean(data.host.editableClarify))
                }
                onClick={() => openAction('clarification')}
              >
                {terminal
                  ? zh
                    ? '新建后续工作'
                    : 'Start follow-on work'
                  : zh
                    ? '围绕此处继续澄清'
                    : 'Clarify this scope'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!actionEnabled}
                onClick={() => openAction('compare-options')}
              >
                {zh ? '比较方案' : 'Compare options'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!actionEnabled || !activeView}
                onClick={() => openAction('update-view')}
              >
                {zh ? '更新此图' : 'Update this view'}
              </button>
              <button type="button" className="btn btn--sm" onClick={() => setSelectedIds([])}>
                {zh ? '清除选择' : 'Clear selection'}
              </button>
            </div>
            <details open={!presentation?.collapsedIds.includes('semantic-list')}>
              <summary>
                {zh
                  ? '元素与关系列表（可选择多个组成路径）'
                  : 'Elements and relations (select multiple for a path)'}
              </summary>
              <Field
                label={
                  zh ? '搜索当前视图的元素与关系' : 'Search elements and relations in this view'
                }
              >
                <TextInput
                  value={viewSearch}
                  onChange={(value) => {
                    setViewSearch(value)
                    setOffset(0)
                    setFocusId(null)
                  }}
                />
              </Field>
              {view.data &&
                !view.data.renderings.length &&
                view.data.scope.completeTotal !== undefined &&
                view.data.scope.completeTotal > 250 && (
                  <NoticeBanner
                    tone="info"
                    title={
                      zh
                        ? '当前视图较大，使用分页目录定位'
                        : 'Use the paged directory for this large view'
                    }
                  >
                    {zh
                      ? '目录可搜索全部元素与关系；当前页不是完整设计的校验结果。'
                      : 'Search covers all elements and relations. The current page is not a verification of the complete design.'}
                  </NoticeBanner>
                )}
              <ul className="graph-design__list">
                {(view.data?.elements ?? document.elements.slice(offset, offset + 50)).map(
                  (element) => (
                    <li key={element.id}>
                      <button
                        type="button"
                        className="btn btn--sm"
                        aria-pressed={selected.has(element.id)}
                        onClick={() => toggleSelection(element.id)}
                      >
                        {selected.has(element.id) ? '✓ ' : ''}
                        {element.label}
                      </button>
                    </li>
                  ),
                )}
                {(view.data?.relations ?? document.relations.slice(offset, offset + 50)).map(
                  (relation) => (
                    <li key={relation.id}>
                      <button
                        type="button"
                        className="btn btn--sm"
                        aria-pressed={selected.has(relation.id)}
                        onClick={() => toggleSelection(relation.id)}
                      >
                        {selected.has(relation.id) ? '✓ ' : ''}
                        {document.elements.find((e) => e.id === relation.from)?.label ??
                          relation.from}{' '}
                        →{' '}
                        {document.elements.find((e) => e.id === relation.to)?.label ?? relation.to}:{' '}
                        {relation.label}
                        {relation.condition ? ` [${relation.condition}]` : ''}
                      </button>
                    </li>
                  ),
                )}
              </ul>
            </details>
            <div className="graph-design__actions">
              <button
                type="button"
                className="btn btn--xs"
                disabled={!(view.data?.scope.offset ?? offset)}
                onClick={() => {
                  setOffset(Math.max(0, (view.data?.scope.offset ?? offset) - 50))
                  setFocusId(null)
                }}
              >
                {zh ? '上一页' : 'Previous'}
              </button>
              <span>
                {zh ? '目录页 ' : 'Directory page '}
                {Math.floor((view.data?.scope.offset ?? offset) / 50) + 1} ·{' '}
                {zh ? '元素' : 'Elements'} {view.data?.scope.total ?? document.elements.length} ·{' '}
                {zh ? '关系' : 'Relations'}{' '}
                {view.data?.relationScope?.total ?? document.relations.length}
              </span>
              <button
                type="button"
                className="btn btn--xs"
                disabled={
                  (view.data?.scope.offset ?? offset) + 50 >=
                  Math.max(
                    view.data?.scope.total ?? document.elements.length,
                    view.data?.relationScope?.total ?? document.relations.length,
                  )
                }
                onClick={() => {
                  setOffset((view.data?.scope.offset ?? offset) + 50)
                  setFocusId(null)
                }}
              >
                {zh ? '下一页' : 'Next'}
              </button>
            </div>
            {selectedElements.map((element) => (
              <section key={element.id} className="graph-design__selected">
                <h4>{element.label}</h4>
                <p>{element.description}</p>
                {element.kind === 'assumption' && (
                  <p>
                    {zh ? '条件 / 未知：' : 'Condition / unknowns: '}
                    {element.condition} / {element.unknowns}
                  </p>
                )}
                {element.kind === 'decision' && <DecisionReadback decision={element.decision} />}
                {document.sources
                  .filter((source) => element.sourceIds.includes(source.id))
                  .map((source) => (
                    <details key={source.id} open>
                      <summary>
                        {zh ? '来源' : 'Source'} · {graphStateLabel(source.kind, zh)}
                      </summary>
                      {source.kind === 'clarify' ? (
                        <>
                          <blockquote>{source.originalAnswer}</blockquote>
                          {source.answer?.selectedOptionLabels.length ? (
                            <p>
                              {zh ? '选择：' : 'Selected: '}
                              {source.answer.selectedOptionLabels.join('；')}
                            </p>
                          ) : null}
                          {source.answer?.customText && <p>{source.answer.customText}</p>}
                          <DecisionReadback decision={source.decision} />
                          <Link to="/tasks/$id" params={{ id: source.taskId }}>
                            {zh ? '打开原问题' : 'Open original question'} · {source.questionId}
                          </Link>
                        </>
                      ) : source.kind === 'material' ? (
                        <p>
                          {source.label} · <code>{source.artifactRef}</code>
                        </p>
                      ) : source.kind === 'code' ? (
                        <p>
                          <code>{source.path}</code>
                          {source.symbol ? ` · ${source.symbol}` : ''} ·{' '}
                          <code>{source.commitSha}</code>
                        </p>
                      ) : source.kind === 'review' ? (
                        <Link to="/tasks/$id" params={{ id: source.taskId }}>
                          {zh ? '查看审核回执' : 'View review receipt'} ·{' '}
                          {graphStateLabel(source.decision, zh)}
                        </Link>
                      ) : (
                        <p>
                          <code>
                            {source.kind === 'model' ? source.invocationRef : source.artifactRef}
                          </code>
                        </p>
                      )}
                    </details>
                  ))}
              </section>
            ))}
            {selectedRelations.map((relation) => (
              <p key={relation.id}>
                {relation.label} · {relation.condition ?? ''}
              </p>
            ))}
          </div>
        </Card>
      </div>
      <Card title={zh ? '待应用提案与调用' : 'Proposals and calls'}>
        <div className="graph-design__stack">
          {data.proposals.map((proposal, index) => (
            <div key={proposal.id} className="graph-design__actions">
              <button
                type="button"
                className="btn btn--sm"
                data-testid={`graph-proposal-${proposal.id}`}
                onClick={() => setProposalId(proposal.id)}
              >
                {zh ? '查看提案差异' : 'Compare proposal'} {index + 1} ·{' '}
                {new Date(proposal.createdAt).toLocaleString()}
              </button>
              <span>{graphStateLabel(proposal.status, zh)}</span>
            </div>
          ))}
          {data.requests.map((request, index) => (
            <div key={request.id}>
              <strong>
                {(
                  {
                    import: zh ? '设计导入' : 'Design import',
                    action: zh ? '设计调用' : 'Design call',
                    review: zh ? '设计审核' : 'Design review',
                    implementation: zh ? '代码实现' : 'Implementation',
                    clarification: zh ? '补充澄清' : 'Clarification',
                    verification: zh ? '候选验证' : 'Candidate verification',
                  } as Record<string, string>
                )[request.kind] ?? (zh ? '工作请求' : 'Work request')}{' '}
                {index + 1} · {graphStateLabel(request.status, zh)}
              </strong>
              {request.kind === 'action' &&
                ['running', 'failed', 'interrupted', 'canceled'].includes(request.status) && (
                  <button
                    type="button"
                    className="btn btn--xs"
                    disabled={!canEdit || busy}
                    onClick={() =>
                      void perform(() =>
                        api.post(
                          `${base}/actions/${encodeURIComponent(request.id.slice('action:'.length))}/${request.status === 'running' ? 'cancel' : 'retry'}`,
                        ),
                      )
                    }
                  >
                    {request.status === 'running'
                      ? zh
                        ? '取消调用'
                        : 'Cancel'
                      : zh
                        ? '重试'
                        : 'Retry'}
                  </button>
                )}
              <details>
                <summary>{zh ? '调用结果' : 'Call result'}</summary>
                <pre>{JSON.stringify(request.payload, null, 2)}</pre>
              </details>
            </div>
          ))}
        </div>
      </Card>
      <Card title={zh ? '实现依据与审核' : 'Implementation bases and reviews'}>
        <div className="graph-design__actions">
          {data.bases.map((basis) => (
            <button
              type="button"
              className="btn btn--sm"
              key={basis.id}
              onClick={() => setBasisId(basis.id)}
            >
              {new Date(basis.createdAt).toLocaleString()} · {zh ? '查看依据' : 'View basis'}
            </button>
          ))}
        </div>
      </Card>
      {evidence.error && (
        <ErrorBanner error={evidence.error} onRetry={() => void evidence.refetch()} />
      )}
      {!current && (
        <NoticeBanner tone="info">
          {zh
            ? '以下验证状态始终与当前设计和候选比较。'
            : 'Evidence freshness is compared with the current design and candidate.'}
        </NoticeBanner>
      )}
      {evidence.data && (
        <GraphDesignEvidence
          data={evidence.data}
          document={document}
          canEdit={canEdit}
          busy={busy || !executionAvailable}
          zh={zh}
          onLocate={locate}
          onVerify={() => void perform(() => postRequest(`${base}/verification-requests`, {}))}
          onAccept={(request) =>
            perform(async () => {
              const basisRefs = await Promise.all(
                data.bases.map((row) =>
                  api.get<{ basis: GraphImplementationBasis }>(
                    `${base}/bases/${encodeURIComponent(row.id)}`,
                  ),
                ),
              )
              const frozen = basisRefs.find((row) => row.basis.digest === request.basisDigest)
              if (!frozen)
                throw new Error(zh ? '找不到匹配的实现依据' : 'Matching basis is unavailable')
              await postRequest(`${base}/acceptance`, {
                basisId: frozen.basis.id,
                candidateTreeOid: request.candidateTreeOid,
                obligationIds: [request.obligationId],
                result: request.result,
                comment: request.comment,
              })
            })
          }
        />
      )}
      <Card title={zh ? '代码、测试与执行产物' : 'Code, tests and execution artifacts'}>
        <div className="graph-design__stack">
          {data.executionLinks
            .filter((link) => link.kind === 'host' && link.taskId)
            .map((link) => (
              <Link
                key={link.taskId}
                to="/tasks/$id"
                params={{ id: link.taskId! }}
                className="btn btn--sm"
              >
                {link.workItemRef} ·{' '}
                {zh ? '查看执行与下载工作区' : 'Inspect execution and download workspace'}
              </Link>
            ))}
          {data.executionLinks
            .filter((link) => link.kind === 'delivery')
            .map((link) => (
              <p key={link.commitSha}>
                {zh ? '内部候选提交：' : 'Internal candidate commit: '}
                <code>{link.commitSha}</code> ·{' '}
                {link.publication
                  ? `${zh ? '已发布到' : 'Published to'} ${link.publication.remoteRef} · ${zh ? 'CI 与部署另有回执' : 'CI and deployment require separate receipts'}`
                  : zh
                    ? '此回执仅记录内部候选；MR 进度见交付与持续看护。'
                    : 'This receipt records the internal candidate; see Delivery and ongoing care for MR progress.'}
              </p>
            ))}
        </div>
      </Card>
      {editing && (
        <GraphDesignEditDialog
          document={document}
          selectedIds={selectedIds}
          profiles={profiles.data ?? []}
          onSave={save}
          onClose={() => setEditing(false)}
          busy={busy}
          zh={zh}
          saveError={command.error}
          onReload={async () => {
            const latest = await api.get<GraphWorkspaceData>(base)
            client.setQueryData([...key, 'workspace', id, 'current'], latest)
            command.reset()
            return latest.document
          }}
        />
      )}
      <Dialog
        open={action !== null}
        onClose={() => setAction(null)}
        title={
          action === 'clarification'
            ? terminal
              ? zh
                ? '新建后续工作'
                : 'Start follow-on work'
              : zh
                ? '补充澄清'
                : 'Further clarification'
            : zh
              ? '生成设计提案'
              : 'Generate a design proposal'
        }
        dismissDisabled={busy}
        footer={
          <button
            type="button"
            className="btn btn--primary"
            disabled={
              !(action === 'clarification' ? clarificationEnabled : actionEnabled) ||
              !instruction.trim()
            }
            onClick={() =>
              void perform(async () => {
                const anchor = graphSelectionAnchor(
                  document,
                  action === 'replan' || action === 'update-view' ? [] : selectedIds,
                  action === 'update-view' ? activeView?.id : undefined,
                )
                if (action === 'clarification') {
                  const receipt = await postRequest<{ caseId: string; queued?: boolean }>(
                    `${base}/clarification-requests`,
                    {
                      expectedRevision: document.revision,
                      instruction,
                      anchor,
                      previousSourceIds: selectedElements
                        .flatMap((e) => e.sourceIds)
                        .filter((id) =>
                          document.sources.some((s) => s.id === id && s.kind === 'clarify'),
                        ),
                      withdrawReview,
                    },
                  )
                  if (receipt.caseId !== caseId) setFollowOnCaseId(receipt.caseId)
                  setNotice(
                    receipt.caseId !== caseId
                      ? `${zh ? '已创建后续任务' : 'Follow-on case created'}: ${receipt.caseId}`
                      : receipt.queued
                        ? zh
                          ? '补充澄清已排队，当前工作结束后受理。'
                          : 'Clarification queued until the current work finishes.'
                        : zh
                          ? '补充澄清已受理。'
                          : 'Clarification accepted.',
                  )
                } else {
                  await postRequest(`${base}/actions`, {
                    expectedRevision: document.revision,
                    action,
                    instruction,
                    anchor,
                  })
                  setNotice(
                    zh
                      ? '调用已开始，完成后可查看和应用差异。'
                      : 'Call started. Review and apply the resulting changes when ready.',
                  )
                }
                setAction(null)
              })
            }
          >
            {zh ? '提交请求' : 'Submit request'}
          </button>
        }
      >
        <div className="graph-design__stack">
          <p>
            {zh ? '所选范围：' : 'Selected scope: '}
            {action === 'update-view'
              ? `${zh ? '当前图' : 'Current view'}: ${activeView?.title ?? activeView?.id ?? ''}`
              : action === 'replan' || !selectedIds.length
                ? zh
                  ? '整个设计'
                  : 'Whole design'
                : `${selectedIds.join(', ')}${zh ? '（含关联依赖）' : ' (including dependencies)'}`}
          </p>
          <Field
            label={
              zh ? '想补充什么，或希望解决什么问题？' : 'What would you like to add or resolve?'
            }
            required
          >
            <TextArea value={instruction} onChange={setInstruction} rows={5} />
          </Field>
          {action === 'clarification' && data.host.workItemRef === 'review-design' && (
            <Switch
              checked={withdrawReview}
              onChange={setWithdrawReview}
              label={zh ? '撤回当前审核，再补充澄清' : 'Withdraw this review and clarify'}
            />
          )}
          {command.error && <ErrorBanner error={command.error} />}
        </div>
      </Dialog>
      <Dialog
        open={scopeOpen}
        onClose={() => setScopeOpen(false)}
        title={zh ? '选择本次实现范围' : 'Select implementation scope'}
        footer={
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canEdit || busy || !scopeIds.length}
            onClick={() =>
              void perform(async () => {
                const result = await postRequest<{ basis: GraphImplementationBasis }>(
                  `${base}/baseline-previews`,
                  { expectedRevision: document.revision, includedElementIds: scopeIds },
                )
                setBasisId(result.basis.id)
                setScopeOpen(false)
              })
            }
          >
            {zh ? '生成可审核预览' : 'Create reviewable preview'}
          </button>
        }
      >
        <ul className="graph-design__list">
          {document.elements.map((element) => (
            <li key={element.id}>
              <Switch
                checked={scopeIds.includes(element.id)}
                onChange={(enabled) =>
                  setScopeIds((ids) =>
                    enabled ? [...ids, element.id] : ids.filter((id) => id !== element.id),
                  )
                }
                label={element.label}
              />
            </li>
          ))}
        </ul>
        {command.error && <ErrorBanner error={command.error} />}
      </Dialog>
      <Dialog
        open={proposalId !== null && !limitationReviewOpen}
        onClose={() => setProposalId(null)}
        title={zh ? '比较设计提案' : 'Compare design proposal'}
        size="lg"
        footer={
          <>
            {proposal.data?.kind === 'code-feedback' && proposal.data.status === 'proposed' && (
              <button
                type="button"
                className="btn"
                disabled={!canEdit || busy}
                onClick={() => {
                  setLimitationReason('')
                  command.reset()
                  setLimitationReviewOpen(true)
                }}
              >
                {zh ? '判定不构成缺口' : 'Not a gap'}
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canEdit || busy || proposal.data?.status !== 'proposed'}
              onClick={() =>
                void perform(async () => {
                  const result = await postRequest<{ status: string }>(
                    `${base}/proposals/${encodeURIComponent(proposalId!)}/apply`,
                    {},
                  )
                  if (result.status === 'accepted') setProposalId(null)
                  else
                    setNotice(
                      zh
                        ? '提案依据已变化，请重新生成。'
                        : 'The proposal is stale; request a new one.',
                    )
                })
              }
            >
              {zh ? '应用此提案' : 'Apply proposal'}
            </button>
          </>
        }
      >
        <div className="graph-design">
          {proposal.error && <ErrorBanner error={proposal.error} />}
          {proposal.isLoading && <LoadingState />}
          {proposal.data && (
            <>
              <p>{proposal.data.explanation}</p>
              <strong>{graphStateLabel(proposal.data.status, zh)}</strong>
              {proposal.data.plan?.uncoveredConcernIds.length ? (
                <NoticeBanner tone="warning">
                  {zh ? '尚未覆盖：' : 'Still uncovered: '}
                  {proposal.data.plan.uncoveredConcernIds
                    .map(
                      (id) =>
                        proposal.data?.document.concerns.find((c) => c.id === id)?.statement ?? id,
                    )
                    .join('；')}
                </NoticeBanner>
              ) : null}
              <ul>
                {proposal.data.plan?.decisions.map((decision) => (
                  <li key={decision.candidateId}>
                    {decision.selected ? '✓' : '—'}{' '}
                    {proposal.data?.plan?.candidates.find((c) => c.id === decision.candidateId)
                      ?.title ?? decision.candidateId}
                    ：{decision.reason}
                  </li>
                ))}
              </ul>
              {changes.map((change) => (
                <section key={change.id}>
                  <strong>{graphChangeLabel(change, zh)}</strong>
                  <div className="graph-design__diff">
                    <div>
                      <p>{zh ? '修改前' : 'Before'}</p>
                      <pre>{change.before}</pre>
                    </div>
                    <div>
                      <p>{zh ? '修改后' : 'After'}</p>
                      <pre>{change.after}</pre>
                    </div>
                  </div>
                </section>
              ))}
            </>
          )}
          {command.error && <ErrorBanner error={command.error} />}
        </div>
      </Dialog>
      <Dialog
        open={limitationReviewOpen}
        onClose={() => {
          if (!busy) setLimitationReviewOpen(false)
        }}
        title={zh ? '判定不构成缺口' : 'Not a gap'}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setLimitationReviewOpen(false)}
            >
              {zh ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                !canEdit ||
                busy ||
                !limitationReason.trim() ||
                limitationReason.length > 20_000 ||
                proposal.data?.status !== 'proposed'
              }
              onClick={() =>
                void perform(async () => {
                  await postRequest(
                    `${base}/proposals/${encodeURIComponent(proposalId!)}/limitation-review`,
                    {
                      comment: limitationReason,
                    },
                  )
                  setLimitationReviewOpen(false)
                  setProposalId(null)
                })
              }
            >
              {zh ? '保存判定' : 'Save judgment'}
            </button>
          </>
        }
      >
        <div className="graph-design__stack">
          <ol>
            {proposal.data?.document.concerns
              .filter((concern) =>
                concern.id.startsWith(`implementation-gap:${proposal.data!.invocationRef}:`),
              )
              .map((concern) => (
                <li key={concern.id}>{concern.statement}</li>
              ))}
          </ol>
          <Field label={zh ? '判定理由' : 'Reason'} required>
            <TextArea
              value={limitationReason}
              onChange={setLimitationReason}
              disabled={busy}
              maxLength={20_000}
              required
            />
          </Field>
          {command.error && <ErrorBanner error={command.error} />}
        </div>
      </Dialog>
      <Dialog
        open={basisId !== null}
        onClose={() => setBasisId(null)}
        title={zh ? '实现依据' : 'Implementation basis'}
        size="lg"
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={!basis.data || busy}
              onClick={() =>
                void perform(async () => {
                  const result = await api.get(
                    `${base}/bases/${encodeURIComponent(basisId!)}/export`,
                  )
                  saveBlobAs(
                    new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
                    'implementation-basis.json',
                  )
                })
              }
            >
              {zh ? '导出' : 'Export'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!actionEnabled || !basis.data || Boolean(basis.data.staleIds.length)}
              onClick={() =>
                void perform(async () => {
                  await postRequest(`${base}/review-requests`, { basisId })
                  setNotice(
                    zh
                      ? '审核请求已受理，请从当前任务打开人工审核。'
                      : 'Review requested. Open the human review from the current task.',
                  )
                  setBasisId(null)
                })
              }
            >
              {zh ? '请求人工审核' : 'Request human review'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                !actionEnabled || !approval || !basis.data || Boolean(basis.data.staleIds.length)
              }
              onClick={() =>
                void perform(async () => {
                  await postRequest(`${base}/implementation-requests`, {
                    basisId,
                    reviewReceiptId: approval!.id,
                  })
                  setNotice(
                    zh
                      ? '实现请求已受理。代码和测试生成完成后将进入验证。'
                      : 'Implementation requested. Verification follows complete code and test generation.',
                  )
                  setBasisId(null)
                })
              }
            >
              {zh ? '按此依据发起实现' : 'Implement this basis'}
            </button>
          </>
        }
      >
        <div className="graph-design">
          {basis.error && <ErrorBanner error={basis.error} />}
          {basis.isLoading && <LoadingState />}
          {basis.data && (
            <>
              {basis.data.staleIds.length > 0 && (
                <NoticeBanner tone="warning">
                  {zh
                    ? '相关内容已变化，需要重新生成依据：'
                    : 'Related content changed; generate a new basis: '}
                  {basis.data.staleIds.join(', ')}
                </NoticeBanner>
              )}
              <p>
                v{basis.data.basis.document.revision} · <code>{basis.data.basis.digest}</code>
              </p>
              <Prose
                body={
                  basis.data.basis.files.find((file) => file.path === 'implementation.md')
                    ?.content ?? ''
                }
              />
              {reviews.map((review) => (
                <NoticeBanner
                  key={review.id}
                  tone={review.decision === 'approved' ? 'info' : 'warning'}
                  action={
                    <Link to="/tasks/$id" params={{ id: review.taskId }}>
                      {zh ? '原审核' : 'Original review'}
                    </Link>
                  }
                >
                  {review.decision} · {review.reason}
                </NoticeBanner>
              ))}
            </>
          )}
          {command.error && <ErrorBanner error={command.error} />}
        </div>
      </Dialog>
    </div>
  )
}
