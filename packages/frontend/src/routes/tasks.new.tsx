// RFC-165 (T12) — /tasks/new: the unified 4-step task-creation wizard.
//
//   ① 执行方式 + 对象   (workflow / single agent / workgroup + which one)
//   ② 执行空间          (remote URL repos ⊕ scratch temp space)
//   ③ 名称 + 任务内容    (+ advanced fold: collaborators / branch & auto-push /
//                        limits / allowClarify)
//   ④ 只读确认          (summary with per-step "modify" backlinks; primary
//                        launch + secondary save-as-scheduled — swapped when
//                        `?schedule=1`)
//
// Deep links (`?kind=agent&agentId=<id>`) pre-fill Step 1 and land on Step 2
// (D9). `?editScheduled=<id>` turns the wizard into the schedule's config
// editor: kind + object lock, every field seeds from the stored payload
// (kind-aware, RFC-159 absorbed), and Step 4's single button PUTs the rebuilt
// payload back.

import { TASK_QUERY_KEYS } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  CachedRepo,
  ScheduledTask,
  Task,
  TaskMembers,
  UserPublic,
  Workflow,
  WorkflowDefinition,
  Workgroup,
  WorkflowListItem,
} from '@agent-workflow/shared'
import {
  TASK_SOURCE_REGISTRATIONS,
  deriveAgentLaunchForm,
  isLooseValidBranchName,
  taskExecutionKind,
  isTaskSourceId,
  taskSourceRegistration,
  workgroupLaunchReadiness,
  type RepoGroup,
  type RepoGroupLayoutResponse,
  type TaskCreationKind,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { ScheduleDialog, type ScheduleCreateRequest } from '@/components/ScheduleDialog'
import { ChoiceCards } from '@/components/ChoiceCards'
import { TaskCreationContractFrame } from '@/components/task-creation/TaskCreationContractFrame'
import {
  TaskCreationAdvancedSettings,
  buildTaskCreationAdvancedSummary,
  validateTaskCreationAdvancedValues,
  type TaskCreationAdvancedCapabilities,
  type TaskCreationAdvancedValues,
} from '@/components/task-creation/TaskCreationAdvancedSettings'
import { TaskCreationSubjectDescriptorContract } from '@/components/task-creation/TaskCreationSubjectDescriptorContract'
import { TaskCreationResourcePicker } from '@/components/task-creation/TaskCreationResourcePicker'
import { DynamicInput } from '@/components/launch/DynamicInput'
import { RepoSourceList } from '@/components/launch/RepoSourceList'
import { QueryState } from '@/components/QueryState'
import { RepoLayoutTree } from '@/components/repos/RepoLayoutTree'
import { StatusChip } from '@/components/StatusChip'
import { UploadPicker } from '@/components/launch/UploadPicker'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import { useActor, usePermission } from '@/hooks/useActor'
import { useUserLookup } from '@/hooks/useUserLookup'
import { defaultRepoSource, resolveUrlRepoPath, validateRepoUrl } from '@/lib/launch-repo-source'
import { buildResourceOptionLabeler } from '@/lib/resource-option-label'
import { stableStringify } from '@/lib/stable-stringify'
import {
  parseTaskWizardDraft,
  restoreWizardInputs,
  restoreWizardSpace,
  serializeWizardInputs,
  serializeWizardSpace,
  taskWizardBaselineFingerprint,
  taskWizardDraftKey,
  taskWizardNewDraftSourceId,
  writeTaskWizardDraft,
  type TaskWizardDraftFlow,
  type TaskWizardDraftValues,
  type TaskWizardDraftV1,
} from '@/lib/task-wizard-draft'
import {
  buildAgentStartBody,
  buildAgentStartFormData,
  findUploadDuplicate,
  buildScheduledEnvelope,
  taskToLaunchPayload,
  type WizardSeed,
  buildWorkflowStartBody,
  buildWorkflowStartFormData,
  buildWorkgroupStartBody,
  defaultWizardSpace,
  loadAutoCommitPushPref,
  loadSpaceKindPref,
  normalizeSeededInput,
  payloadToWizardSeed,
  saveAutoCommitPushPref,
  saveSpaceKindPref,
  type WizardKind,
} from '@/lib/task-wizard'
import { workgroupLaunchErrorMessage } from '@/lib/workgroup-launch'
import { classifyWriteOutcome } from '@/lib/write-outcome'
import { Route as RootRoute } from './__root'

interface OrchestrationTaskWizardSearch {
  kind?: WizardKind
  /** Deep-link object refs — canonical ids for all three resource kinds. */
  workflow?: string
  /** RFC-199: exact editor revision handed to the launch wizard. */
  workflowVersion?: number
  agentId?: string
  workgroupId?: string
  /** RFC-225: exact autosaved workgroup revision handed off by the editor. */
  workgroupVersion?: number
  /** `?schedule=1` — scheduled mode: save-as-scheduled becomes the primary action. */
  schedule?: boolean
  /** RFC-159 absorbed — edit an existing schedule's launch config. */
  editScheduled?: string
  /** RFC-175 — "relaunch": pre-fill from a terminal task's persisted params. */
  relaunchFrom?: string
  /**
   * RFC-211 §12 — the onboarding tour's launch entry. When set, the wizard opens
   * ready to submit: a sample task name + prompt are prefilled, the space is
   * forced to scratch (no repo needed), and it starts on the Confirm step so the
   * spotlight tour can point at a real, enabled launch button.
   */
  tour?: 'first-task'
}

interface TaskWizardSearch extends Omit<OrchestrationTaskWizardSearch, 'kind'> {
  kind?: TaskCreationKind
  employeeId?: string
}

export const TaskWizardRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/new',
  component: TaskCreationEntryPage,
  validateSearch: (raw: Record<string, unknown>): TaskWizardSearch => {
    const out: TaskWizardSearch = {}
    if (isTaskSourceId(raw.kind)) out.kind = raw.kind
    for (const k of [
      'workflow',
      'agentId',
      'workgroupId',
      'employeeId',
      'editScheduled',
      'relaunchFrom',
    ] as const) {
      const v = raw[k]
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    const rawWorkflowVersion = raw.workflowVersion
    const numericWorkflowVersion =
      typeof rawWorkflowVersion === 'number'
        ? rawWorkflowVersion
        : typeof rawWorkflowVersion === 'string' && rawWorkflowVersion.trim() !== ''
          ? Number(rawWorkflowVersion)
          : undefined
    if (
      numericWorkflowVersion !== undefined &&
      Number.isInteger(numericWorkflowVersion) &&
      numericWorkflowVersion > 0
    ) {
      out.workflowVersion = numericWorkflowVersion
    }
    const rawWorkgroupVersion = raw.workgroupVersion
    const numericWorkgroupVersion =
      typeof rawWorkgroupVersion === 'number'
        ? rawWorkgroupVersion
        : typeof rawWorkgroupVersion === 'string' && rawWorkgroupVersion.trim() !== ''
          ? Number(rawWorkgroupVersion)
          : undefined
    if (
      numericWorkgroupVersion !== undefined &&
      Number.isInteger(numericWorkgroupVersion) &&
      numericWorkgroupVersion > 0
    ) {
      out.workgroupVersion = numericWorkgroupVersion
    }
    if (raw.schedule === true || raw.schedule === 1 || raw.schedule === '1') out.schedule = true
    if (raw.tour === 'first-task') out.tour = 'first-task'
    return out
  },
})

function TaskCreationEntryPage() {
  const search = TaskWizardRoute.useSearch()
  const initialSourceIdRef = useRef<TaskCreationKind>(
    search.kind ?? TASK_SOURCE_REGISTRATIONS[0].id,
  )
  const [sourceId, setSourceId] = useState<TaskCreationKind>(initialSourceIdRef.current)
  const [sourceChanged, setSourceChanged] = useState(false)
  useEffect(() => {
    if (search.kind !== undefined) setSourceId(search.kind)
  }, [search.kind])
  const onSourceChange = (next: TaskCreationKind) => {
    if (next !== sourceId) setSourceChanged(true)
    setSourceId(next)
  }
  return (
    <TaskCreationFlow
      sourceId={sourceId}
      initialSourceId={initialSourceIdRef.current}
      initialResourceId={search.employeeId}
      allowDraftRecovery={!sourceChanged}
      onSourceChange={onSourceChange}
    />
  )
}

interface TaskCreationFlowProps {
  readonly sourceId: TaskCreationKind
  readonly initialSourceId: TaskCreationKind
  readonly initialResourceId?: string
  readonly allowDraftRecovery: boolean
  readonly onSourceChange: (sourceId: TaskCreationKind) => void
}

/**
 * The single task-creation flow. The source registration selects a declarative
 * contract interpreter; task identities never select a page or visual shell.
 */
function TaskCreationFlow(context: TaskCreationFlowProps) {
  const search = TaskWizardRoute.useSearch()
  const source = taskSourceRegistration(context.sourceId)
  const initialStep = taskCreationInitialStep(source, search)
  const [step, setStep] = useState(initialStep)
  const [maxVisited, setMaxVisited] = useState(initialStep)
  const previousSourceRef = useRef(context.sourceId)
  useEffect(() => {
    if (previousSourceRef.current === context.sourceId) return
    previousSourceRef.current = context.sourceId
    const nextStep = taskCreationInitialStep(source, search)
    setStep(nextStep)
    setMaxVisited(nextStep)
  }, [context.sourceId, search, source])
  const onSourceChange = (next: TaskCreationKind) => {
    setStep(STEP_MODE)
    setMaxVisited(STEP_MODE)
    context.onSourceChange(next)
  }
  if (source.creation.parameterContract.kind === 'subject-descriptor') {
    return (
      <TaskCreationSubjectDescriptorContract
        key={source.creation.parameterContract.schemaId}
        source={source}
        initialResourceId={context.initialResourceId}
        onSourceChange={onSourceChange}
        step={step}
        maxVisited={maxVisited}
        setStep={setStep}
        setMaxVisited={setMaxVisited}
      />
    )
  }
  return (
    <TaskCreationSharedSchemaContract
      key={source.creation.parameterContract.kind}
      sourceId={context.sourceId}
      initialSourceId={context.initialSourceId}
      allowDraftRecovery={context.allowDraftRecovery}
      onSourceChange={onSourceChange}
      step={step}
      maxVisited={maxVisited}
      setStep={setStep}
      setMaxVisited={setMaxVisited}
    />
  )
}

function taskCreationInitialStep(
  source: ReturnType<typeof taskSourceRegistration>,
  search: TaskWizardSearch,
): number {
  const editing = search.editScheduled !== undefined
  const relaunching = search.relaunchFrom !== undefined && !editing
  if (search.tour === 'first-task' && !editing && !relaunching) return STEP_CONFIRM
  const resource = search[source.creation.resourceSearchKey]
  return search.kind === source.id && typeof resource === 'string' && resource !== '' && !editing
    ? STEP_SPACE
    : STEP_MODE
}

const STEP_MODE = 0
const STEP_SPACE = 1
const STEP_CONTENT = 2
const STEP_CONFIRM = 3
const ORCHESTRATION_TASK_CREATION_KINDS = new Set<TaskCreationKind>(
  TASK_SOURCE_REGISTRATIONS.filter(
    (source) => source.creation.parameterContract.kind === 'shared-schema',
  ).map((source) => source.id),
)

function orchestrationWizardKind(sourceId: TaskCreationKind): WizardKind {
  if (!ORCHESTRATION_TASK_CREATION_KINDS.has(sourceId)) {
    throw new Error(`task source does not belong to orchestration: ${sourceId}`)
  }
  return sourceId as WizardKind
}

type TaskWizardSubmissionOperation = NonNullable<TaskWizardDraftV1['reconciliation']>['operation']

interface TaskCreationSharedSchemaContractProps {
  readonly sourceId: TaskCreationKind
  readonly initialSourceId: TaskCreationKind
  readonly allowDraftRecovery: boolean
  readonly onSourceChange: (sourceId: TaskCreationKind) => void
  readonly step: number
  readonly maxVisited: number
  readonly setStep: (step: number) => void
  readonly setMaxVisited: (update: number | ((current: number) => number)) => void
}

function TaskCreationSharedSchemaContract(context: TaskCreationSharedSchemaContractProps) {
  const props = {
    initialKind: orchestrationWizardKind(context.sourceId),
    draftPreferredKind: orchestrationWizardKind(context.initialSourceId),
    availableSourceIds: ORCHESTRATION_TASK_CREATION_KINDS,
    allowDraftRecovery: context.allowDraftRecovery,
    onSourceChange: context.onSourceChange,
  }
  const { t, i18n } = useTranslation()
  const search = TaskWizardRoute.useSearch() as OrchestrationTaskWizardSearch
  const routeKind =
    search.kind === 'workflow' || search.kind === 'agent' || search.kind === 'workgroup'
      ? search.kind
      : undefined
  const navigate = useNavigate()
  const qc = useQueryClient()
  const actor = useActor()
  const canReadTasks = usePermission('tasks:read')
  const canReadRepos = usePermission('repos:read')
  const canReadScheduledTasks = usePermission('scheduled-tasks:read')
  const canCreateScheduledTasks = usePermission('scheduled-tasks:create')
  const canUpdateScheduledTasks = usePermission('scheduled-tasks:update')
  const canSearchUsers = usePermission('users:search')
  const isEdit = search.editScheduled !== undefined
  // RFC-175: "relaunch" pre-fills from a terminal task (editScheduled wins if both).
  const isRelaunch = search.relaunchFrom !== undefined && !isEdit
  const missingCapabilityPermission =
    actor.status === 'success' && actor.fetchStatus === 'idle'
      ? isEdit && !canReadScheduledTasks
        ? 'scheduled-tasks:read'
        : isEdit && !canUpdateScheduledTasks
          ? 'scheduled-tasks:update'
          : isRelaunch && !canReadTasks
            ? 'tasks:read'
            : search.schedule === true && !canCreateScheduledTasks
              ? 'scheduled-tasks:create'
              : null
      : null

  // --- Step 1 state: execution kind + object -------------------------------
  const deepObject =
    routeKind === 'workflow'
      ? search.workflow
      : routeKind === 'agent'
        ? search.agentId
        : routeKind === 'workgroup'
          ? search.workgroupId
          : undefined
  const [kind, setKind] = useState<WizardKind>(props.initialKind)
  const [workflowId, setWorkflowId] = useState(
    routeKind === 'workflow' ? (search.workflow ?? '') : '',
  )
  const [agentId, setAgentId] = useState(routeKind === 'agent' ? (search.agentId ?? '') : '')
  const [workgroupId, setWorkgroupId] = useState(
    routeKind === 'workgroup' ? (search.workgroupId ?? '') : '',
  )
  const [selectedWorkgroupVersion, setSelectedWorkgroupVersion] = useState<number | undefined>(
    routeKind === 'workgroup' ? search.workgroupVersion : undefined,
  )
  // RFC-175 + RFC-199: every immediate WORKFLOW launch captures the exact
  // `workflows.version` its inputs were normalized against. Editor deep links
  // additionally require their validated version to match the first detail
  // read; later background advances never silently reseed user-entered inputs.
  const [normalizedWorkflowRevision, setNormalizedWorkflowRevision] = useState<{
    workflowId: string
    version: number
    definition: WorkflowDefinition
  } | null>(null)
  const [restoredWorkflowRevision, setRestoredWorkflowRevision] = useState<{
    workflowId: string
    version: number
  } | null>(null)
  const normalizedWorkflowVersion =
    kind === 'workflow' && normalizedWorkflowRevision?.workflowId === workflowId
      ? normalizedWorkflowRevision.version
      : undefined
  const normalizedWorkflowDefinition =
    kind === 'workflow' && normalizedWorkflowRevision?.workflowId === workflowId
      ? normalizedWorkflowRevision.definition
      : undefined
  const [workflowVersionMismatch, setWorkflowVersionMismatch] = useState<{
    workflowId: string
    expected: number
    current: number
  } | null>(null)

  // RFC-211 §12 — launched from the onboarding tour. Seeds a runnable sample so
  // the tour can walk build → run → result without the user typing anything.
  const fromTour = search.tour === 'first-task' && !isEdit && !isRelaunch
  const draftFlow: TaskWizardDraftFlow = isEdit
    ? 'edit-scheduled'
    : isRelaunch
      ? 'relaunch'
      : fromTour
        ? 'tour'
        : 'new'
  const newDraftSourceId = taskWizardNewDraftSourceId({
    scheduled: search.schedule === true,
    entry:
      routeKind === 'workflow' && search.workflow !== undefined
        ? {
            kind: 'workflow',
            resourceId: search.workflow,
            ...(search.workflowVersion !== undefined
              ? { workflowVersion: search.workflowVersion }
              : {}),
          }
        : routeKind === 'agent' && search.agentId !== undefined
          ? { kind: 'agent', resourceId: search.agentId }
          : routeKind === 'workgroup' &&
              taskExecutionKind({ workgroupId: search.workgroupId }) === 'workgroup'
            ? {
                kind: 'workgroup',
                resourceId: search.workgroupId ?? '',
                ...(search.workgroupVersion !== undefined
                  ? { workgroupVersion: search.workgroupVersion }
                  : {}),
              }
            : { kind: 'picker', preferredKind: props.draftPreferredKind },
  })
  const draftSourceId = isEdit
    ? (search.editScheduled ?? null)
    : isRelaunch
      ? (search.relaunchFrom ?? null)
      : fromTour
        ? 'first-task'
        : newDraftSourceId
  const actorId = actor.data?.user.id ?? null
  const activeDraftKey =
    actorId === null
      ? null
      : taskWizardDraftKey({ actorId, flow: draftFlow, sourceId: draftSourceId })

  // --- Step 2 state: execution space (D9: default remote, remember last) ---
  const [space, setSpace] = useState(() =>
    defaultWizardSpace(fromTour ? 'scratch' : isEdit ? 'remote' : loadSpaceKindPref()),
  )

  // --- Step 3 state: name + content + advanced fold -------------------------
  const [taskName, setTaskName] = useState(() => (fromTour ? t('tour.firstTask.seedTaskName') : ''))
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState<Record<string, File[]>>({})
  const [description, setDescription] = useState(() =>
    fromTour ? t('tour.firstTask.seedTaskPrompt') : '',
  )
  const [goal, setGoal] = useState('')
  // 单 agent 全新启动默认「不允许反问」（用户 2026-07-14）——保留开关，用户可按需勾选。
  // 后端 StartAgentTaskSchema.allowClarify 仍 default(true)：那是 RFC-175 relaunch/edit
  // 的「wire 省略 ⟺ 原值 true」重建锚点，翻它会误读旧持久化 launchPayload；产品默认在此处。
  // relaunch/edit 会经 applyWizardSeed → setAllowClarify(seed.allowClarify) 覆盖此默认。
  const [allowClarify, setAllowClarify] = useState(false)
  const [collaborators, setCollaborators] = useState<UserPublic[]>([])
  const [workingBranch, setWorkingBranch] = useState('')
  const [autoCommitPush, setAutoCommitPush] = useState(loadAutoCommitPushPref())
  const [maxDurationMin, setMaxDurationMin] = useState<number | undefined>(undefined)
  const [maxTotalTokens, setMaxTotalTokens] = useState<number | undefined>(undefined)

  // --- Wizard chrome: current step + reachable frontier ---------------------
  const deepLinked = routeKind !== undefined && deepObject !== undefined && !isEdit
  // From the tour, everything is prefilled — open straight on Confirm so the
  // spotlight lands on a real, enabled launch button (all steps reachable).
  const { step, maxVisited, setStep, setMaxVisited } = context
  const [saveScheduledOpen, setSaveScheduledOpen] = useState(false)
  const [draftCandidate, setDraftCandidate] = useState<TaskWizardDraftV1 | null>(null)
  const [draftReady, setDraftReady] = useState(false)
  const [draftWarning, setDraftWarning] = useState<string | null>(null)
  const [persistenceError, setPersistenceError] = useState<unknown | null>(null)
  const [draftReadError, setDraftReadError] = useState<unknown | null>(null)
  const [draftReadAttempt, setDraftReadAttempt] = useState(0)
  const [repoUrlReentryRequired, setRepoUrlReentryRequired] = useState(false)
  const [inputReentryKeys, setInputReentryKeys] = useState<string[]>([])
  const [uploadReselectKeys, setUploadReselectKeys] = useState<string[]>([])
  const [restoredCollaboratorIds, setRestoredCollaboratorIds] = useState<string[]>([])
  const [outcomeUnknown, setOutcomeUnknown] = useState<NonNullable<
    TaskWizardDraftV1['reconciliation']
  > | null>(null)
  const baselineMaterialSignatureRef = useRef<string | null>(null)
  const baselineFingerprintRef = useRef<string | null>(null)
  const initializedDraftKeyRef = useRef<string | null>(null)
  const dirtyRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const busySinceRef = useRef<number | null>(null)
  const submissionAbortRef = useRef<AbortController | null>(null)
  const submissionOperationRef = useRef<TaskWizardSubmissionOperation | null>(null)
  const navigationAuthorizedRef = useRef(false)
  const activeReconciliationRef = useRef<NonNullable<TaskWizardDraftV1['reconciliation']> | null>(
    null,
  )
  const restoreButtonRef = useRef<HTMLButtonElement | null>(null)

  // --- Object lists (Step 1) -------------------------------------------------
  const workflowsQ = useQuery<WorkflowListItem[]>({
    queryKey: ['workflows'],
    queryFn: ({ signal }) =>
      api.get(taskSourceRegistration('workflow').creation.inventoryPath, undefined, signal),
  })
  const agentsQ = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) =>
      api.get(taskSourceRegistration('agent').creation.inventoryPath, undefined, signal),
  })
  const workgroupsQ = useQuery<Workgroup[]>({
    queryKey: ['workgroups'],
    queryFn: ({ signal }) =>
      api.get(taskSourceRegistration('workgroup').creation.inventoryPath, undefined, signal),
  })

  // RFC-175: the source task + its members, for relaunch pre-fill.
  // RFC-175 impl-gate F1: both queries SHARE their keys with the task detail
  // page's task/members queries (global staleTime 5s), so React Query would
  // serve a stale cache hit immediately and the seed barrier below would lock
  // on it — re-granting a since-removed collaborator (ACL regression). Force a
  // fresh fetch this mount and gate seeding on `isFetchedAfterMount`.
  const relaunchTaskQ = useQuery<Task>({
    queryKey: TASK_QUERY_KEYS.detail(search.relaunchFrom ?? null),
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(search.relaunchFrom ?? '')}`, undefined, signal),
    enabled: isRelaunch && canReadTasks,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const relaunchMembersQ = useQuery<TaskMembers>({
    queryKey: [...TASK_QUERY_KEYS.detail(search.relaunchFrom ?? null), 'members'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(search.relaunchFrom ?? '')}/members`,
        undefined,
        signal,
      ),
    enabled: isRelaunch && canReadTasks,
    staleTime: 0,
    refetchOnMount: 'always',
  })

  // Selected workflow detail — the wizard needs `definition.inputs` for Step 3.
  const workflowQ = useQuery<Workflow>({
    queryKey: ['workflows', workflowId],
    queryFn: ({ signal }) =>
      api.get(`/api/workflows/${encodeURIComponent(workflowId)}`, undefined, signal),
    enabled: kind === 'workflow' && workflowId !== '',
    // The editor handoff is an exact revision fence. A shared 5s cache hit is
    // only a placeholder until this wizard mount has observed fresh server
    // truth; otherwise a writer between validate and navigation stays hidden.
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 15_000,
  })

  const expectedWorkflowVersionForCurrentSelection =
    kind === 'workflow' && normalizedWorkflowRevision?.workflowId === workflowId
      ? normalizedWorkflowRevision.version
      : kind === 'workflow' && restoredWorkflowRevision?.workflowId === workflowId
        ? restoredWorkflowRevision.version
        : routeKind === 'workflow' && search.workflow === workflowId
          ? search.workflowVersion
          : undefined
  // Derive the live mismatch in render as well as persisting it in state. A
  // query update renders before its effect runs; gating only on effect-owned
  // state would leave one paint where a stale vN form could still submit vN+1.
  const observedWorkflowVersionMismatch =
    kind === 'workflow' &&
    workflowQ.data !== undefined &&
    workflowQ.isFetchedAfterMount &&
    workflowQ.isSuccess &&
    expectedWorkflowVersionForCurrentSelection !== undefined &&
    workflowQ.data.version !== expectedWorkflowVersionForCurrentSelection
      ? {
          workflowId,
          expected: expectedWorkflowVersionForCurrentSelection,
          current: workflowQ.data.version,
        }
      : null
  const activeWorkflowVersionMismatch = observedWorkflowVersionMismatch ?? workflowVersionMismatch

  // RFC-110: matched cached clone for the files/git input pickers.
  const cachedRepos = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
    enabled: canReadRepos,
  })
  const readableCachedRepos = canReadRepos ? (cachedRepos.data?.items ?? []) : []

  // RFC-175: apply a reconstructed WizardSeed to the field state — shared by the
  // ?editScheduled= and ?relaunchFrom= seed paths (does NOT touch kind / subject
  // id capture / collaborators / step — those stay path-specific).
  const applyWizardSeed = (seed: WizardSeed): void => {
    setWorkflowId(seed.workflowId ?? '')
    setAgentId(seed.agentId ?? '')
    setWorkgroupId(seed.workgroupId ?? '')
    setSpace(seed.space)
    setTaskName(seed.taskName)
    setInputs(seed.inputs)
    setDescription(seed.description)
    setGoal(seed.goal)
    setAllowClarify(seed.allowClarify)
    setWorkingBranch(seed.workingBranch)
    setAutoCommitPush(seed.autoCommitPush)
    // Keep the exact stored value: fractional minutes round-trip back to the
    // original ms via Math.round(min * 60_000) — a no-op save must not mutate a
    // limit like 123456ms into 120000ms (Codex P2).
    setMaxDurationMin(seed.maxDurationMs !== undefined ? seed.maxDurationMs / 60_000 : undefined)
    setMaxTotalTokens(seed.maxTotalTokens)
  }

  // --- editScheduled: load + seed (kind-aware, one-shot) ---------------------
  const scheduleQ = useQuery<ScheduledTask>({
    queryKey: ['scheduled-tasks', 'detail', search.editScheduled],
    queryFn: ({ signal }) =>
      api.get(
        `/api/scheduled-tasks/${encodeURIComponent(search.editScheduled ?? '')}`,
        undefined,
        signal,
      ),
    enabled: isEdit && canReadScheduledTasks && canUpdateScheduledTasks,
  })
  const seededRef = useRef(false)
  const seedCollabIds = useRef<string[]>([])
  const [seedFailed, setSeedFailed] = useState(false)
  // RFC-175 impl-gate F2: set when a relaunch source's space could not be
  // faithfully rebuilt (internal/fusion, legacy path-mode, or materialize-failed
  // with a possibly-truncated repo prefix) — drives a notice on the space step.
  const [spaceUnresolved, setSpaceUnresolved] = useState(false)
  useEffect(() => {
    if (!isEdit || scheduleQ.data === undefined || seededRef.current) return
    seededRef.current = true
    const row = scheduleQ.data
    setKind(row.launchKind)
    const payload = row.launchPayload as Record<string, unknown> | null
    const seed = payload === null ? null : payloadToWizardSeed(row.launchKind, payload)
    if (seed === null) {
      // Degraded / legacy payload — kind stays locked, fields stay blank for
      // repair (a full re-fill + save rewrites the row).
      setSeedFailed(true)
      setStep(STEP_MODE)
      setMaxVisited(STEP_CONFIRM)
      return
    }
    applyWizardSeed(seed)
    seedCollabIds.current = seed.collaboratorUserIds
    // Everything is pre-filled — open every step so the user can jump straight
    // to what they want to change (or to Confirm to just re-save).
    setStep(STEP_SPACE)
    setMaxVisited(STEP_CONFIRM)
  }, [isEdit, scheduleQ.data, setMaxVisited, setStep])

  // Collaborator ids → UserPublic chips (second async hop, RFC-159 pattern).
  const collabLookup = useUserLookup(seedCollabIds.current)
  const restoredCollaboratorLookup = useUserLookup(restoredCollaboratorIds)
  const collabSeededRef = useRef(false)
  useEffect(() => {
    if (!seededRef.current || collabSeededRef.current) return
    const ids = seedCollabIds.current
    if (ids.length === 0) {
      collabSeededRef.current = true
      return
    }
    if (collabLookup.isLoading) return
    setCollaborators(
      ids.map((cid) => collabLookup.get(cid)).filter((u): u is UserPublic => u !== undefined),
    )
    collabSeededRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, scheduleQ.data, collabLookup.isLoading])

  useEffect(() => {
    if (restoredCollaboratorIds.length === 0 || restoredCollaboratorLookup.isLoading) return
    setCollaborators(
      restoredCollaboratorIds
        .map((id) => restoredCollaboratorLookup.get(id))
        .filter((user): user is UserPublic => user !== undefined),
    )
    if (
      restoredCollaboratorLookup.isSuccess &&
      restoredCollaboratorIds.some((id) => restoredCollaboratorLookup.get(id) === undefined)
    ) {
      setDraftWarning('taskWizard.draftCollaboratorsChanged')
    }
    setRestoredCollaboratorIds([])
    // The lookup object intentionally stays outside the dependency list: this
    // effect consumes one explicit restore batch, then clears that batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredCollaboratorIds, restoredCollaboratorLookup.isLoading])

  // --- RFC-175 relaunch: load task + members → seed (one-shot, kind-aware) ----
  const relaunchSeededRef = useRef(false)
  // Reactive twin of the one-shot ref (final-gate F1-followup-2): the SUBMIT gate
  // must not open until this effect has actually run PAST its fresh-fetch barrier
  // and applied the seed. A cached shared-key hit keeps relaunchTaskQ.isSuccess
  // true during the forced background refetch (isFetchedAfterMount still false),
  // so gating relaunchReady on isSuccess would let a user submit the DEFAULT form
  // pre-seed. This flag flips true only inside the effect, after the barrier.
  const [relaunchApplied, setRelaunchApplied] = useState(false)
  useEffect(() => {
    if (!isRelaunch || relaunchSeededRef.current) return
    // Barrier: the SOURCE TASK gates everything — it drives the kind, the
    // subject-id guard, and (for agent/workflow only) the seeded collaborators.
    //
    // Fresh-fetch barrier (impl-gate F1 + re-review): require this mount's fetch
    // to have SUCCEEDED before seeding. isFetchedAfterMount alone is insufficient
    // — an errored refetch keeps the STALE cached `data` and still flips that
    // flag, which would re-grant a since-removed collaborator. Gate on isSuccess
    // too, and on error do NOT set the one-shot ref (return early) so a later
    // successful retry re-enters and seeds fresh; the error surfaces via
    // relaunchError + the submit gate.
    if (!relaunchTaskQ.isFetchedAfterMount || !relaunchTaskQ.isSuccess) return
    if (relaunchTaskQ.data === undefined) return
    if (actor.isPending) return
    const task = relaunchTaskQ.data
    const kind = taskExecutionKind(task)
    // RFC-304: a code-round task is not relaunchable from this wizard. Its
    // subject is a work item's round, not a resource a user picks — re-running
    // it means asking the work item for another round, which is a /code action
    // with its own precondition (an open work item that still owns the anchor).
    // Seeding the wizard from one would produce a launch against the
    // synthesized host workflow: superficially valid, and detached from every
    // guarantee the round's own state machine provides. Fail closed by leaving
    // the wizard on its own defaults, exactly like an unseedable payload below.
    if (kind === 'code-round') {
      relaunchSeededRef.current = true
      setSeedFailed(true)
      setStep(STEP_MODE)
      setMaxVisited(STEP_CONFIRM)
      return
    }
    if (kind === 'workgroup' && workgroupsQ.data === undefined) return
    if (kind === 'agent' && agentsQ.data === undefined) return
    // Members feed ONLY the agent/workflow collaborator seed — a WORKGROUP
    // relaunch never consumes them, so it must NOT be blocked by a members fetch
    // it does not use (re-review F1-followup). Require the fresh successful
    // members fetch only for non-workgroup kinds (derived from the task, not the
    // wizard's default kind state).
    if (
      kind !== 'workgroup' &&
      (!relaunchMembersQ.isFetchedAfterMount ||
        !relaunchMembersQ.isSuccess ||
        relaunchMembersQ.data === undefined)
    )
      return
    relaunchSeededRef.current = true
    // Past the barrier — open the submit gate (batched with the seed setState
    // below, so no render sees relaunchApplied=true before the seed is applied).
    setRelaunchApplied(true)

    // Preserve the source execution kind even when an old row has no canonical
    // subject id. The seed then fails closed with a blank picker in the RIGHT
    // kind, so the user can explicitly choose a current resource; it must not
    // silently fall back to the wizard's default agent kind.
    setKind(kind)
    const { payload, spaceResolvable } = taskToLaunchPayload(task)
    const seed = payloadToWizardSeed(kind, payload)
    if (seed === null) {
      setSeedFailed(true)
      setStep(STEP_MODE)
      setMaxVisited(STEP_CONFIRM)
      return
    }
    // Impl-gate F2: an unresolvable space (internal/fusion, legacy path-mode with
    // no URL, or a task that failed during materialize and may hold only a repo
    // PREFIX) must NOT seed a partial/wrong space. Blank it to a single empty
    // remote row and flag a notice so the user rebuilds it explicitly; sourceReady
    // (which now requires a non-empty repo list) blocks the launch until they do.
    applyWizardSeed(spaceResolvable ? seed : { ...seed, space: defaultWizardSpace('remote') })
    setSpaceUnresolved(!spaceResolvable)

    // Subject identity is frozen as an id. Pre-select only when that exact row
    // is still present in the visible inventory. Historical rows without an id
    // fail closed and require an explicit current-resource pick; there is no
    // name lookup or same-name replacement adoption.
    if (kind === 'workgroup') {
      const cur = (workgroupsQ.data ?? []).find((g) => g.id === seed.workgroupId)
      if (cur !== undefined) {
        setWorkgroupId(cur.id)
        setSelectedWorkgroupVersion(cur.version)
      } else {
        setWorkgroupId('')
        setSelectedWorkgroupVersion(undefined)
      }
    } else if (kind === 'agent') {
      const cur = (agentsQ.data ?? []).find((a) => a.id === seed.agentId)
      setAgentId(cur?.id ?? '')
    }

    // Collaborators (§4.5, R3-F4): agent/workflow pre-fill the task's CURRENT
    // members (owner + collaborators) minus the launcher; workgroup does NOT
    // (its stored set unions auto-added human members — the launch re-derives
    // those, and replaying would over-grant to members since removed). The
    // barrier above guarantees a fresh successful members fetch for non-workgroup.
    const members = relaunchMembersQ.data
    if (kind !== 'workgroup' && members !== undefined) {
      const launcherId = actor.data?.source !== 'daemon' ? actor.data?.user.id : undefined
      const seen = new Set<string>()
      setCollaborators(
        // RFC-324 —— 只继承协作者：启动 body 的 collaborators 没有档位维度，把
        // 观察者一并带过去等于把他升成协作者。观察者在新任务里由发起人重新指定。
        [
          members.owner,
          ...members.members.filter((m) => m.role === 'collaborator').map((m) => m.user),
        ].filter(
          (u): u is UserPublic =>
            u != null && u.id !== launcherId && (seen.has(u.id) ? false : (seen.add(u.id), true)),
        ),
      )
    }

    setStep(STEP_MODE)
    setMaxVisited(STEP_CONFIRM)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isRelaunch,
    relaunchTaskQ.data,
    relaunchMembersQ.data,
    relaunchTaskQ.isFetchedAfterMount,
    relaunchMembersQ.isFetchedAfterMount,
    relaunchTaskQ.isSuccess,
    relaunchMembersQ.isSuccess,
    workgroupsQ.data,
    agentsQ.data,
    actor.isPending,
  ])

  // --- RFC-218: port-driven single-agent launch form -------------------------
  const selectedAgent =
    kind === 'agent' && agentId !== ''
      ? (agentsQ.data ?? []).find((a) => a.id === agentId)
      : undefined
  const selectedWorkgroup =
    kind === 'workgroup' && workgroupId !== ''
      ? (workgroupsQ.data ?? []).find((group) => group.id === workgroupId)
      : undefined
  const agentName = selectedAgent?.name ?? agentId
  const workgroupName = selectedWorkgroup?.name ?? workgroupId
  const agentLaunchForm = useMemo(
    () => (selectedAgent !== undefined ? deriveAgentLaunchForm(selectedAgent.inputs) : null),
    [selectedAgent],
  )
  const agentPorted = agentLaunchForm !== null
  const agentBlockers = agentLaunchForm?.blockers ?? []
  // Design P1-5 barrier: with a deep-linked agent id, "row not loaded yet"
  // is indistinguishable from "zero-port agent" — never guess the form shape
  // (a ported agent would reject the description body). Require a successful
  // list load AND a matching row before rendering step 3's content.
  const agentDataReady =
    kind !== 'agent' || agentId === '' || (agentsQ.isSuccess && selectedAgent !== undefined)

  // Seed the inputs map from the selected workflow's declared keys (merge:
  // stale keys drop, new keys start blank, user-typed values survive). The
  // uploads map is filtered in lockstep — leaving files picked for a PREVIOUS
  // workflow would force a multipart submit with unknown keys (Codex P2).
  useEffect(() => {
    if (
      kind !== 'workflow' ||
      workflowQ.data === undefined ||
      !workflowQ.isFetchedAfterMount ||
      !workflowQ.isSuccess
    )
      return
    const capturedVersion =
      normalizedWorkflowRevision?.workflowId === workflowId
        ? normalizedWorkflowRevision.version
        : undefined
    const expectedVersion = expectedWorkflowVersionForCurrentSelection
    if (expectedVersion !== undefined && workflowQ.data.version !== expectedVersion) {
      setWorkflowVersionMismatch({
        workflowId,
        expected: expectedVersion,
        current: workflowQ.data.version,
      })
      return
    }
    setWorkflowVersionMismatch((current) => (current?.workflowId === workflowId ? null : current))
    if (capturedVersion === undefined) {
      setNormalizedWorkflowRevision({
        workflowId,
        version: workflowQ.data.version,
        // React Query replaces cache values, but keep a private immutable-ish
        // snapshot so a later vN+1 refresh cannot redraw vN fields under the
        // user's already-entered values.
        definition: structuredClone(workflowQ.data.definition),
      })
    }
    const defs = workflowQ.data.definition.inputs ?? []
    setInputs((prev) => {
      const seeded: Record<string, string> = {}
      for (const i of defs) {
        // RFC-175 (§4.8, R4-F3 + impl-gate F3): normalize each seeded value
        // against the CURRENT def. Clears stale upload paths (browser can't
        // rebuild a File) AND enum values no longer among the declared choices
        // (they render blank in EnumPicker but would still submit) — the
        // missingRequired gate then forces a visible re-pick. Valid values and
        // free-form text/git survive untouched, so a normal launch is unaffected.
        seeded[i.key] = normalizeSeededInput(i, prev[i.key] ?? '')
      }
      return seeded
    })
    const uploadKeys = new Set(defs.filter((d) => d.kind === 'upload').map((d) => d.key))
    setUploads((prev) => {
      const kept = Object.entries(prev).filter(([k]) => uploadKeys.has(k))
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
    })
  }, [
    kind,
    expectedWorkflowVersionForCurrentSelection,
    normalizedWorkflowRevision,
    workflowId,
    workflowQ.data,
    workflowQ.isFetchedAfterMount,
    workflowQ.isSuccess,
  ])

  // RFC-218 (design P1-4): the agent-kind sibling of the workflow seeding
  // effect above — keep inputs/uploads keyed to the CURRENT agent's derived
  // port defs. Switching agent A→B (or workflow↔agent) must not leak A's keys
  // onto the wire: the service rejects undeclared keys, so a leaked map would
  // make a perfectly normal "pick a different agent" launch fail. Values for
  // surviving keys are preserved; upload keys are pruned in lockstep.
  useEffect(() => {
    // The readiness guard doubles as relaunch-seed protection: while the list
    // is still loading, agentLaunchForm is null and running would wipe the
    // just-applied seed values before the real defs arrive.
    if (kind !== 'agent' || !agentDataReady) return
    const defs = agentLaunchForm?.inputs ?? []
    setInputs((prev) => {
      const seeded: Record<string, string> = {}
      for (const d of defs) seeded[d.key] = normalizeSeededInput(d, prev[d.key] ?? '')
      return seeded
    })
    const uploadKeys = new Set(defs.filter((d) => d.kind === 'upload').map((d) => d.key))
    setUploads((prev) => {
      const kept = Object.entries(prev).filter(([k]) => uploadKeys.has(k))
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
    })
  }, [kind, agentDataReady, agentLaunchForm])

  // --- Step 1 filtering (launchability projection) ---------------------------
  const resourceOwners = useUserLookup([
    ...(workflowsQ.data ?? []).map((workflow) => workflow.ownerUserId),
    ...(agentsQ.data ?? []).map((agent) => agent.ownerUserId),
    ...(workgroupsQ.data ?? []).map((group) => group.ownerUserId),
  ])
  // RFC-264: labels come from the shared builder so same-name rows (legal for
  // workflows, and now easy to hit with human-readable names) get an id suffix.
  const optionRow = (r: { id: string; name: string; ownerUserId?: string | null }) => ({
    id: r.id,
    name: r.name,
    owner: resourceOwners.get(r.ownerUserId)?.displayName ?? r.ownerUserId ?? undefined,
  })
  const launchableWorkflows = (workflowsQ.data ?? []).filter(
    (workflow) => workflow.builtin !== true,
  )
  const workflowLabel = buildResourceOptionLabeler(launchableWorkflows.map(optionRow))
  const workflowOptions = launchableWorkflows.map((workflow) => ({
    value: workflow.id,
    label: workflowLabel(optionRow(workflow)),
  }))
  const launchableAgents = (agentsQ.data ?? []).filter((a) => a.builtin !== true)
  const agentLabel = buildResourceOptionLabeler(launchableAgents.map(optionRow))
  const agentOptions = launchableAgents.map((a) => ({
    value: a.id,
    label: agentLabel(optionRow(a)),
  }))
  const workgroupLabel = buildResourceOptionLabeler((workgroupsQ.data ?? []).map(optionRow))
  const workgroupOptions = (workgroupsQ.data ?? []).map((g) => {
    const readiness = workgroupLaunchReadiness(g)
    // RFC-187 TRAP-1 (Codex impl-gate P2): the ADVISORY tier must reach the
    // launch wizard too — a leader-only roster stays selectable (warning
    // never blocks) but says so, instead of silently launching a group that
    // can only idle. Blocking reasons keep the disabled treatment.
    return {
      value: g.id,
      label: workgroupLabel(optionRow(g)),
      ...(readiness.ready
        ? readiness.warnings.length > 0
          ? { description: t('taskWizard.workgroupLeaderOnlyWarning') }
          : {}
        : { disabled: true, description: t('taskWizard.workgroupNotReady') }),
    }
  })
  const activeInventoryQ =
    kind === 'workflow' ? workflowsQ : kind === 'agent' ? agentsQ : workgroupsQ
  const activeInventoryLoading = activeInventoryQ.data === undefined && activeInventoryQ.isLoading
  const activeInventoryError =
    activeInventoryQ.error !== null && activeInventoryQ.error !== undefined
  const objectOptions =
    kind === 'workflow' ? workflowOptions : kind === 'agent' ? agentOptions : workgroupOptions
  const objectFieldLabel =
    kind === 'workflow'
      ? t('taskWizard.objectWorkflow')
      : kind === 'agent'
        ? t('taskWizard.objectAgent')
        : t('taskWizard.objectWorkgroup')
  const selectedObject = kind === 'workflow' ? workflowId : kind === 'agent' ? agentId : workgroupId
  const changeSelectedObject = (nextObjectId: string) => {
    if (kind === 'workflow') {
      setWorkflowId(nextObjectId)
      setNormalizedWorkflowRevision(null)
      setRestoredWorkflowRevision(null)
      setWorkflowVersionMismatch(null)
      return
    }
    if (kind === 'agent') {
      setAgentId(nextObjectId)
      return
    }
    setWorkgroupId(nextObjectId)
    const selected = (workgroupsQ.data ?? []).find((group) => group.id === nextObjectId)
    setSelectedWorkgroupVersion(selected?.version)
  }
  const selectedObjectLabel =
    kind === 'workflow'
      ? (workflowOptions.find((o) => o.value === workflowId)?.label ??
        workflowQ.data?.name ??
        workflowId)
      : kind === 'agent'
        ? (agentOptions.find((option) => option.value === agentId)?.label ?? agentName)
        : (workgroupOptions.find((option) => option.value === workgroupId)?.label ?? workgroupName)

  // --- Gating ---------------------------------------------------------------
  // Launch-form field defs: authored (workflow) or derived from the agent's
  // declared input ports (RFC-218) — one render/validation path for both.
  const inputDefs =
    kind === 'workflow'
      ? (normalizedWorkflowDefinition?.inputs ?? [])
      : (agentLaunchForm?.inputs ?? [])
  const missingRequired = inputDefs.some((def) => {
    if (def.kind === 'upload') {
      const list = uploads[def.key] ?? []
      const rec = def as Record<string, unknown>
      const minCount = typeof rec.minCount === 'number' ? rec.minCount : 0
      if (def.required === true && list.length === 0) return true
      return list.length < minCount
    }
    if (def.required !== true) return false
    const raw = (inputs[def.key] ?? '').trim()
    if (raw === '') return true
    // Re-review F3: a required multi-select whose value is an empty array ('[]')
    // — or an unparseable non-selection — is "nothing picked" and must count as
    // missing, even though the raw string is non-empty.
    if (def.kind === 'enum' && (def as Record<string, unknown>).multiSelect === true) {
      try {
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed) && parsed.length === 0
      } catch {
        return true
      }
    }
    return false
  })
  const hasUploads = Object.values(uploads).some((arr) => arr.length > 0)
  const hasUploadInput = inputDefs.some((d) => d.kind === 'upload')
  // RFC-262: two picked files that would land on the same worktree path. The
  // daemon rejects this outright (`upload-duplicate-filename`), so surface it
  // here — same shared walker, same verdict — instead of shipping the bytes
  // first. Applies to workflow inputs and RFC-218 agent port forms alike.
  const uploadDuplicate = findUploadDuplicate(inputDefs, uploads)
  // RFC-218 (impl-gate P2-6): the upload arm applies to agent port forms too —
  // multipart + multi-repo is refused server-side (multi-repo-upload-
  // unsupported), so the wizard must gate it for BOTH kinds that can carry
  // upload inputs. wrapper-git stays workflow-only (agents have no canvas).
  // RFC-248 T38: `multiRepoBlockedReason` 已删除。它拦的是「向导里临时拼 N 行
  // URL」这种多仓形态，而多仓现在**只能**由仓库组表达（组空间由服务端展平，
  // wrapper-git 与上传输入两条限制都在服务端按组布局判定）。remote 空间因此
  // 恒为单行，这个门天然不可达。

  // RFC-248: 组名 / 展平仓数用于空间摘要与已选卡片。只在 remote 系空间下查。
  const repoGroups = useQuery<{ items: RepoGroup[] }>({
    queryKey: ['repo-groups'],
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
    enabled: canReadRepos && space.kind !== 'scratch',
  })
  const readableRepoGroups = canReadRepos ? (repoGroups.data?.items ?? []) : []
  const selectedGroup =
    space.kind === 'group'
      ? readableRepoGroups.find((group) => group.id === space.groupId)
      : undefined
  // 选中组后拉一次展平布局，供启动前预览（见「已选仓库组」卡片）。
  const selectedGroupId = space.kind === 'group' ? space.groupId : ''
  const groupLayout = useQuery<RepoGroupLayoutResponse>({
    queryKey: ['repo-group-layout', selectedGroupId],
    queryFn: ({ signal }) =>
      api.get(`/api/repo-groups/${encodeURIComponent(selectedGroupId)}/layout`, undefined, signal),
    enabled: canReadRepos && selectedGroupId !== '',
  })
  const readableGroupLayout = canReadRepos ? groupLayout.data : undefined

  const stepModeReady = selectedObject !== ''
  // Impl-gate F2: `[].every()` is vacuously true, so a zero-repo remote space
  // (produced by seeding an unresolvable source) would wrongly read "ready".
  // A remote launch needs at least one valid repo.
  const sourceReady =
    space.kind === 'scratch' ||
    // RFC-248: 组空间选中即就绪——布局与各仓 ref 都由服务端从组定义展平。
    (space.kind === 'group' && canReadRepos && space.groupId !== '') ||
    // RFC-248 H9: 重放空间选中即就绪——布局来自源任务的冻结快照。
    (space.kind === 'replay' && space.sourceTaskId !== '') ||
    (space.kind === 'remote' &&
      space.repos.length > 0 &&
      space.repos.every((r) => validateRepoUrl(r.repoUrl) === null))
  const nameReady = taskName.trim().length > 0
  // Codex P1: while the workflow detail is loading (or failed), inputDefs is
  // empty and missingRequired reads false — the wizard must NOT treat that as
  // "no required inputs" and let a launch skip them (or skip the multipart
  // path for upload inputs). Require a SUCCESSFUL detail load.
  const contentReady =
    kind === 'workflow'
      ? workflowQ.isSuccess &&
        workflowQ.isFetchedAfterMount &&
        normalizedWorkflowVersion !== undefined &&
        activeWorkflowVersionMismatch === null &&
        !missingRequired &&
        uploadDuplicate === null
      : kind === 'agent'
        ? // RFC-218: the P1-5 barrier gates BOTH shapes (an unloaded list must
          // not read as "zero-port"); ported agents launch on their port form,
          // blockers (signal / reserved names) hard-disable the launch.
          agentDataReady &&
          (agentPorted
            ? agentBlockers.length === 0 && !missingRequired && uploadDuplicate === null
            : description.trim().length > 0)
        : goal.trim().length > 0
  const gitCommitIdentity = actor.data?.profile.gitCommitIdentity ?? null
  const resolvesIdentityAtScheduleFire = isEdit || search.schedule === true
  const requiresCurrentGitIdentity = !isEdit && actor.data?.source !== 'daemon'
  const immediateGitIdentityReady = !requiresCurrentGitIdentity || gitCommitIdentity !== null
  const admissionGitIdentityReady = resolvesIdentityAtScheduleFire || immediateGitIdentityReady
  const advancedValues: TaskCreationAdvancedValues = {
    collaborators,
    workingBranch,
    autoCommitPush,
    maxDurationMin,
    maxTotalTokens,
  }
  const advancedCapabilities: TaskCreationAdvancedCapabilities = {
    collaborators: true,
    workingBranch: space.kind === 'remote',
    autoCommitPush: space.kind === 'remote',
    limits: true,
  }
  const advancedValidation = validateTaskCreationAdvancedValues(
    advancedValues,
    advancedCapabilities,
    isLooseValidBranchName,
  )
  const workingBranchTrim = advancedValidation.workingBranchTrim
  const stepContentReady =
    nameReady && contentReady && admissionGitIdentityReady && advancedValidation.valid
  // RFC-159 P2: editing a schedule with collaborators must wait for the id →
  // UserPublic lookup, else Save rebuilds the body with an empty set.
  const collabReady = !isEdit || seedCollabIds.current.length === 0 || collabLookup.isSuccess
  // RFC-175 (R3-F3): a relaunch must not submit until the source task AND (for
  // agent/workflow) its members have loaded — else the launch would fire with
  // empty/wrong collaborators or a half-applied seed. Derive the members
  // requirement from the SOURCE task's kind, NOT the wizard's default `kind`
  // state — for a workgroup source `kind` is still 'agent'/'workflow' until the
  // seed effect runs, and keying off it wrongly blocked a workgroup relaunch on
  // an unrelated members fetch (re-review F1-followup).
  const relaunchSourceKind =
    isRelaunch && relaunchTaskQ.data !== undefined
      ? taskExecutionKind(relaunchTaskQ.data)
      : undefined
  const relaunchNeedsMembers =
    relaunchSourceKind !== undefined && relaunchSourceKind !== 'workgroup'
  // Point the banner at whichever query actually failed (task, or members for a
  // non-workgroup source) so it never renders a null task error while members is
  // the real failure.
  const relaunchErrorQ = relaunchTaskQ.isError
    ? relaunchTaskQ
    : relaunchNeedsMembers && relaunchMembersQ.isError
      ? relaunchMembersQ
      : null
  const relaunchError = isRelaunch && relaunchErrorQ !== null
  // Final-gate F1-followup-2: gate the submit on the reactive relaunchApplied
  // flag (set only after the seed effect passes its full fresh-fetch barrier),
  // NOT on relaunchTaskQ.isSuccess — a cached success can precede the applied
  // seed, opening a pre-seed submit window. relaunchApplied ⇒ task fresh-success
  // + (non-workgroup) members fresh-success + actor/inventory ready + seed applied.
  const relaunchReady = !isRelaunch || relaunchApplied

  // --- RFC-250: strict same-tab recovery + submitted-snapshot integrity ----
  // The in-memory comparison deliberately includes raw values (including
  // fields that are too sensitive to persist). Serialization below applies the
  // fail-closed allowlist before anything reaches sessionStorage.
  const uploadMetadata = Object.fromEntries(
    Object.entries(uploads).map(([key, files]) => [
      key,
      files.map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      })),
    ]),
  )
  const materialSignature = stableStringify({
    kind,
    workflowId,
    agentId,
    workgroupId,
    selectedWorkgroupVersion,
    selectedWorkflowVersion: normalizedWorkflowVersion,
    space,
    taskName,
    inputs,
    uploadMetadata,
    description,
    goal,
    allowClarify,
    collaboratorIds: collaborators.map((user) => user.id),
    workingBranch,
    autoCommitPush,
    maxDurationMin,
    maxTotalTokens,
  })
  const serializedDraftValues = useMemo<TaskWizardDraftValues>(
    () => ({
      kind,
      workflowId,
      ...(normalizedWorkflowVersion !== undefined
        ? { selectedWorkflowVersion: normalizedWorkflowVersion }
        : {}),
      agentId,
      workgroupId,
      ...(selectedWorkgroupVersion !== undefined ? { selectedWorkgroupVersion } : {}),
      space: serializeWizardSpace(space),
      taskName,
      inputs: serializeWizardInputs(inputs, inputDefs),
      uploadMetadata,
      description,
      goal,
      allowClarify,
      collaboratorIds: collaborators.map((user) => user.id),
      workingBranch,
      autoCommitPush,
      ...(maxDurationMin !== undefined ? { maxDurationMin } : {}),
      ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
    }),
    // `materialSignature` covers every value above, while inputDefs controls
    // which input values are safe to persist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputDefs, materialSignature],
  )
  const draftSeedReady =
    actorId !== null &&
    activeInventoryQ.isSuccess &&
    (!isEdit || (seededRef.current && collabReady)) &&
    (!isRelaunch || relaunchApplied) &&
    (kind !== 'workflow' ||
      workflowId === '' ||
      (workflowQ.isSuccess &&
        workflowQ.isFetchedAfterMount &&
        normalizedWorkflowVersion !== undefined))

  const getSessionStorage = (): Storage | null => {
    try {
      return window.sessionStorage
    } catch {
      return null
    }
  }

  const makeTaskWizardDraft = (
    reconciliation = activeReconciliationRef.current,
  ): TaskWizardDraftV1 | null => {
    if (actorId === null || activeDraftKey === null || baselineFingerprintRef.current === null)
      return null
    return {
      schemaVersion: 1,
      actorId,
      flow: draftFlow,
      sourceId: draftSourceId,
      savedAt: Date.now(),
      baselineFingerprint: baselineFingerprintRef.current,
      step,
      ...(reconciliation !== null ? { reconciliation } : {}),
      values: serializedDraftValues,
    }
  }

  const writeActiveDraft = (reconciliation = activeReconciliationRef.current): boolean => {
    const storage = getSessionStorage()
    const draft = makeTaskWizardDraft(reconciliation)
    if (storage === null || draft === null || activeDraftKey === null) {
      setPersistenceError(new Error(t('taskWizard.draftStorageUnavailable')))
      return false
    }
    const result = writeTaskWizardDraft(storage, activeDraftKey, draft)
    if (!result.ok) {
      setPersistenceError(
        result.reason === 'oversize'
          ? new Error(t('taskWizard.draftTooLarge'))
          : (result.error ?? new Error(t('taskWizard.draftStorageUnavailable'))),
      )
      return false
    }
    setPersistenceError(null)
    return true
  }

  const clearActiveDraft = (authorizeNavigation = false): void => {
    if (activeDraftKey !== null) {
      try {
        getSessionStorage()?.removeItem(activeDraftKey)
      } catch {
        // Navigation/success must not be held hostage by storage cleanup. The
        // envelope is actor/source scoped and expires after 24h if removal is
        // unavailable.
      }
    }
    activeReconciliationRef.current = null
    navigationAuthorizedRef.current = authorizeNavigation
    if (authorizeNavigation) {
      submissionAbortRef.current = null
      submissionOperationRef.current = null
      busyRef.current = false
      busySinceRef.current = null
    }
    dirtyRef.current = null
    setPersistenceError(null)
  }

  useEffect(() => {
    if (
      !draftSeedReady ||
      activeDraftKey === null ||
      actorId === null ||
      initializedDraftKeyRef.current === activeDraftKey
    )
      return
    initializedDraftKeyRef.current = activeDraftKey
    baselineMaterialSignatureRef.current = materialSignature
    baselineFingerprintRef.current = taskWizardBaselineFingerprint(serializedDraftValues)
    setDraftReady(false)

    // A recovery decision belongs to entering the creation page, not to
    // switching its execution-kind card. A session that entered through the
    // digital-employee arm starts clean and must not surface an unrelated
    // orchestration draft when the user compares another card.
    if (!props.allowDraftRecovery) {
      setDraftCandidate(null)
      setDraftReadError(null)
      setDraftReady(true)
      return
    }

    const storage = getSessionStorage()
    if (storage === null) {
      setDraftReadError(new Error(t('taskWizard.draftStorageUnavailable')))
      return
    }
    let raw: string | null = null
    try {
      raw = storage.getItem(activeDraftKey)
    } catch (error: unknown) {
      setDraftReadError(error)
      return
    }
    const result = parseTaskWizardDraft(raw, {
      actorId,
      flow: draftFlow,
      sourceId: draftSourceId,
    })
    if (result.kind === 'ok') {
      setDraftCandidate(result.draft)
    } else if (result.kind !== 'missing') {
      try {
        storage.removeItem(activeDraftKey)
      } catch {
        // The warning below remains visible; current in-memory values stay
        // protected by the guard even when cleanup itself is unavailable.
      }
      setDraftWarning(
        result.kind === 'expired'
          ? 'taskWizard.draftExpired'
          : result.kind === 'oversize'
            ? 'taskWizard.draftTooLarge'
            : 'taskWizard.draftInvalid',
      )
    }
    setDraftReadError(null)
    setDraftReady(true)
  }, [
    activeDraftKey,
    actorId,
    draftFlow,
    draftSeedReady,
    draftSourceId,
    draftReadAttempt,
    materialSignature,
    props.allowDraftRecovery,
    serializedDraftValues,
    t,
  ])

  const restoreDraft = (): void => {
    if (draftCandidate === null) return
    const draft = draftCandidate
    const preserveExplicitIdentity = draftFlow !== 'new' || deepLinked
    if (!preserveExplicitIdentity) {
      setKind(draft.values.kind)
      setWorkflowId(draft.values.workflowId)
      setAgentId(draft.values.agentId)
      setWorkgroupId(draft.values.workgroupId)
      setSelectedWorkgroupVersion(draft.values.selectedWorkgroupVersion)
      setNormalizedWorkflowRevision(null)
      setRestoredWorkflowRevision(
        draft.values.kind === 'workflow' &&
          draft.values.workflowId !== '' &&
          draft.values.selectedWorkflowVersion !== undefined
          ? {
              workflowId: draft.values.workflowId,
              version: draft.values.selectedWorkflowVersion,
            }
          : null,
      )
      setWorkflowVersionMismatch(null)
    }
    const restoredSpace = restoreWizardSpace(draft.values.space)
    const restoredInputs = restoreWizardInputs(draft.values.inputs)
    setSpace(restoredSpace.space)
    setInputs(restoredInputs.values)
    setUploads({})
    setTaskName(draft.values.taskName)
    setDescription(draft.values.description)
    setGoal(draft.values.goal)
    setAllowClarify(draft.values.allowClarify)
    setRestoredCollaboratorIds(draft.values.collaboratorIds)
    setWorkingBranch(draft.values.workingBranch)
    setAutoCommitPush(draft.values.autoCommitPush)
    setMaxDurationMin(draft.values.maxDurationMin)
    setMaxTotalTokens(draft.values.maxTotalTokens)
    setStep(draft.step)
    setMaxVisited((current) => Math.max(current, draft.step))
    setRepoUrlReentryRequired(restoredSpace.requiresRepoUrlReentry)
    setInputReentryKeys(restoredInputs.reentryKeys)
    setUploadReselectKeys(
      Object.entries(draft.values.uploadMetadata)
        .filter(([, files]) => files.length > 0)
        .map(([key]) => key),
    )
    if (draft.baselineFingerprint !== baselineFingerprintRef.current) {
      setDraftWarning('taskWizard.draftSourceChanged')
    }
    activeReconciliationRef.current = draft.reconciliation ?? null
    setOutcomeUnknown(draft.reconciliation ?? null)
    setDraftCandidate(null)
  }

  const discardRecoveryDraft = (): void => {
    clearActiveDraft()
    setDraftCandidate(null)
    setOutcomeUnknown(null)
  }

  const nextEnabled =
    step === STEP_MODE ? stepModeReady : step === STEP_SPACE ? sourceReady : stepContentReady

  const onNavigate = (i: number) => {
    setStep(i)
    setMaxVisited((mv) => Math.max(mv, i))
  }

  const selectCreationKind = (next: TaskCreationKind): void => {
    if (!props.availableSourceIds.has(next)) {
      props.onSourceChange(next)
      return
    }
    if (next !== kind) {
      setKind(orchestrationWizardKind(next))
      // Changing the orchestration kind resets its object identity. Content
      // remains in this mounted wizard and is only sent for the active kind.
      setWorkflowId('')
      setAgentId('')
      setWorkgroupId('')
      setCollaborators([])
      setSelectedWorkgroupVersion(undefined)
      setNormalizedWorkflowRevision(null)
      setWorkflowVersionMismatch(null)
    }
    props.onSourceChange(next)
  }

  // --- Submission -------------------------------------------------------------
  const collectAdvanced = () => ({
    ...(collaborators.length > 0
      ? { collaboratorUserIds: collaborators.map((user) => user.id) }
      : {}),
    ...(workingBranchTrim !== '' ? { workingBranch: workingBranchTrim } : {}),
    ...(autoCommitPush ? { autoCommitPush: true } : {}),
    ...(maxDurationMin !== undefined && maxDurationMin > 0
      ? { maxDurationMs: Math.round(maxDurationMin * 60_000) }
      : {}),
    ...(maxTotalTokens !== undefined && maxTotalTokens > 0 ? { maxTotalTokens } : {}),
  })

  // RFC-218: the ported inputs map is filtered against the CURRENT derived
  // defs at assembly time — defense-in-depth behind the seeding effect (a
  // leaked stale key must never reach the wire; the service 422s it). Upload
  // keys are excluded: their values are server-written from landed files.
  const agentPortInputs = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const def of agentLaunchForm?.inputs ?? []) {
      if (def.kind === 'upload') continue
      out[def.key] = inputs[def.key] ?? ''
    }
    return out
  }

  const buildImmediateBody = (): Record<string, unknown> => {
    if (kind === 'agent') {
      return buildAgentStartBody(space, {
        name: taskName.trim(),
        ...(agentPorted ? { inputs: agentPortInputs() } : { description: description.trim() }),
        allowClarify,
        ...collectAdvanced(),
      })
    }
    if (kind === 'workgroup') {
      return buildWorkgroupStartBody(space, {
        name: taskName.trim(),
        goal: goal.trim(),
        ...collectAdvanced(),
      })
    }
    return buildWorkflowStartBody(space, {
      workflowId,
      name: taskName.trim(),
      inputs,
      ...collectAdvanced(),
    })
  }

  // RFC-175 (§2d): immediate-submit OCC guards — spread onto the immediate POST
  // body ONLY, never into buildImmediateBody (scheduledEnvelope reuses that; a
  // persisted schedule must not carry a point-in-time guard — R6/R7-F1).
  const immediateGuards = (): Record<string, unknown> => {
    if (kind === 'agent') return agentId !== '' ? { expectedAgentId: agentId } : {}
    if (kind === 'workgroup')
      return {
        ...(workgroupId !== '' ? { expectedWorkgroupId: workgroupId } : {}),
        ...(selectedWorkgroupVersion !== undefined
          ? { expectedWorkgroupVersion: selectedWorkgroupVersion }
          : {}),
      }
    return normalizedWorkflowVersion !== undefined
      ? { expectedWorkflowVersion: normalizedWorkflowVersion }
      : {}
  }

  const start = useMutation({
    mutationFn: () => {
      const signal = submissionAbortRef.current?.signal
      if (kind === 'agent') {
        // RFC-218: upload-kind ports (path<ext>) are multipart-only — the
        // backend refuses JSON for them (path values are server-written).
        // Same "any upload def → multipart" rule as the workflow arm.
        if (agentPorted && (hasUploadInput || hasUploads)) {
          return api.postMultipart<Task>(
            `/api/agents/${encodeURIComponent(agentId)}/tasks`,
            buildAgentStartFormData(
              space,
              {
                name: taskName.trim(),
                inputs: agentPortInputs(),
                allowClarify,
                ...collectAdvanced(),
              },
              uploads,
              immediateGuards(),
            ),
            { signal },
          )
        }
        return api.post<Task>(
          `/api/agents/${encodeURIComponent(agentId)}/tasks`,
          { ...buildImmediateBody(), ...immediateGuards() },
          signal,
        )
      }
      if (kind === 'workgroup') {
        return api.post<Task>(
          `/api/workgroups/${encodeURIComponent(workgroupId)}/tasks`,
          { ...buildImmediateBody(), ...immediateGuards() },
          signal,
        )
      }
      // RFC-020: any upload-kind input drives a multipart submit even with
      // zero picked files, so the backend's central min/max gate runs.
      if (hasUploadInput || hasUploads) {
        return api.postMultipart<Task>(
          '/api/tasks',
          buildWorkflowStartFormData(
            space,
            { workflowId, name: taskName.trim(), inputs, ...collectAdvanced() },
            uploads,
            // Impl-gate F4: the JSON path spreads immediateGuards() but any
            // upload-bearing workflow routes HERE — thread the same OCC guard
            // (expectedWorkflowVersion) into the multipart payload so a concurrent
            // workflow PUT still 409s instead of launching new-snapshot/old-params.
            immediateGuards(),
          ),
          { signal },
        )
      }
      return api.post<Task>('/api/tasks', { ...buildImmediateBody(), ...immediateGuards() }, signal)
    },
    onSuccess: (created) => {
      clearActiveDraft(true)
      void navigate({ to: '/tasks/$id', params: { id: created.id } })
    },
    onError: (error: unknown) => {
      if (classifyWriteOutcome(error, { idempotent: false }) === 'definitive') {
        activeReconciliationRef.current = null
        writeActiveDraft(null)
        return
      }
      const reconciliation =
        activeReconciliationRef.current ??
        ({
          operation: 'create-task',
          startedAt: Date.now(),
          taskName: taskName.trim(),
        } satisfies NonNullable<TaskWizardDraftV1['reconciliation']>)
      activeReconciliationRef.current = reconciliation
      setOutcomeUnknown(reconciliation)
      writeActiveDraft(reconciliation)
      void qc.invalidateQueries({ queryKey: TASK_QUERY_KEYS.root() })
    },
    onSettled: () => {
      submissionAbortRef.current = null
      submissionOperationRef.current = null
      busyRef.current = false
      busySinceRef.current = null
    },
  })

  const startWorkflowVersionMismatch =
    kind === 'workflow' && isWorkflowVersionMismatchError(start.error)

  const adoptLatestWorkflow = (latest: Workflow): void => {
    const defs = latest.definition.inputs ?? []
    setNormalizedWorkflowRevision({
      workflowId,
      version: latest.version,
      definition: structuredClone(latest.definition),
    })
    setRestoredWorkflowRevision(null)
    setInputs((previous) =>
      Object.fromEntries(
        defs.map((definition) => [
          definition.key,
          normalizeSeededInput(definition, previous[definition.key] ?? ''),
        ]),
      ),
    )
    const uploadKeys = new Set(
      defs.filter((definition) => definition.kind === 'upload').map((definition) => definition.key),
    )
    setUploads((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => uploadKeys.has(key))),
    )
    setWorkflowVersionMismatch(null)
    start.reset()
    // Explicit adoption may change/remove fields. Bring the user back to the
    // content step so the new version is reviewed before another submit.
    setStep(STEP_CONTENT)
    setMaxVisited((previous) => Math.max(previous, STEP_CONTENT))
  }

  const recoverWorkflowVersion = async (): Promise<void> => {
    if (search.workflowVersion !== undefined) {
      await navigate({ to: '/workflows/$id', params: { id: workflowId } })
      return
    }
    const refreshed = await workflowQ.refetch()
    if (!refreshed.isSuccess || refreshed.data === undefined) return
    adoptLatestWorkflow(refreshed.data)
  }

  const scheduledEnvelope = () =>
    buildScheduledEnvelope(kind, buildImmediateBody(), { agentId, workgroupId })

  const saveConfig = useMutation({
    mutationFn: () =>
      api.put(
        `/api/scheduled-tasks/${encodeURIComponent(search.editScheduled ?? '')}`,
        { launchPayload: scheduledEnvelope() },
        submissionAbortRef.current?.signal,
      ),
    onSuccess: () => {
      clearActiveDraft(true)
      void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      void navigate({ to: '/scheduled/$id', params: { id: search.editScheduled ?? '' } })
    },
    onError: (error: unknown) => {
      if (classifyWriteOutcome(error, { idempotent: false }) === 'definitive') {
        activeReconciliationRef.current = null
        writeActiveDraft(null)
        return
      }
      const reconciliation =
        activeReconciliationRef.current ??
        ({
          operation: 'save-scheduled-config',
          startedAt: Date.now(),
          taskName: taskName.trim(),
        } satisfies NonNullable<TaskWizardDraftV1['reconciliation']>)
      activeReconciliationRef.current = reconciliation
      setOutcomeUnknown(reconciliation)
      writeActiveDraft(reconciliation)
      void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
    },
    onSettled: () => {
      submissionAbortRef.current = null
      submissionOperationRef.current = null
      busyRef.current = false
      busySinceRef.current = null
    },
  })

  const createSchedule = useMutation<{ id: string }, ApiError, ScheduleCreateRequest>({
    mutationFn: (request) =>
      api.post('/api/scheduled-tasks', request, submissionAbortRef.current?.signal),
    onSuccess: () => {
      clearActiveDraft(true)
      setSaveScheduledOpen(false)
      void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      void navigate({ to: '/scheduled' })
    },
    onError: (error: unknown) => {
      if (classifyWriteOutcome(error, { idempotent: false }) === 'definitive') {
        activeReconciliationRef.current = null
        writeActiveDraft(null)
        return
      }
      const reconciliation =
        activeReconciliationRef.current ??
        ({
          operation: 'create-scheduled-task',
          startedAt: Date.now(),
          taskName: taskName.trim(),
        } satisfies NonNullable<TaskWizardDraftV1['reconciliation']>)
      activeReconciliationRef.current = reconciliation
      setOutcomeUnknown(reconciliation)
      writeActiveDraft(reconciliation)
      setSaveScheduledOpen(false)
      void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
    },
    onSettled: () => {
      submissionAbortRef.current = null
      submissionOperationRef.current = null
      busyRef.current = false
      busySinceRef.current = null
    },
  })

  const beginSubmission = (operation: TaskWizardSubmissionOperation): boolean => {
    if (submissionOperationRef.current !== null || outcomeUnknown !== null) return false
    const startedAt = Date.now()
    const reconciliation = { operation, startedAt, taskName: taskName.trim() }
    // The marker is the only durable evidence that a non-idempotent request
    // may have left the browser. If it cannot be written, fail closed before
    // sending anything so reload can never turn response loss into a blind
    // duplicate attempt.
    if (!writeActiveDraft(reconciliation)) return false
    submissionOperationRef.current = operation
    navigationAuthorizedRef.current = false
    submissionAbortRef.current = new AbortController()
    activeReconciliationRef.current = reconciliation
    busyRef.current = true
    busySinceRef.current = startedAt
    return true
  }

  const runStart = (): void => {
    if (!beginSubmission('create-task')) return
    start.mutate()
  }

  const runSaveConfig = (): void => {
    if (!canReadScheduledTasks || !canUpdateScheduledTasks) return
    if (!beginSubmission('save-scheduled-config')) return
    saveConfig.mutate()
  }

  const runCreateSchedule = (request: ScheduleCreateRequest): void => {
    if (!canCreateScheduledTasks) return
    if (!beginSubmission('create-scheduled-task')) return
    createSchedule.mutate(request)
  }

  const submitPending = start.isPending || saveConfig.isPending || createSchedule.isPending
  const materialDirty =
    draftReady &&
    baselineMaterialSignatureRef.current !== null &&
    materialSignature !== baselineMaterialSignatureRef.current
  // The server-owned seed and the same-source recovery decision establish the
  // baseline that subsequent edits are compared against. Letting a user edit
  // before either barrier settles can absorb those edits into the baseline and
  // silently lose both the dirty guard and the persisted draft.
  const materialLocked =
    !draftSeedReady ||
    !draftReady ||
    submitPending ||
    draftCandidate !== null ||
    outcomeUnknown !== null
  dirtyRef.current =
    !navigationAuthorizedRef.current &&
    activeDraftKey !== null &&
    (materialDirty || outcomeUnknown !== null)
      ? activeDraftKey
      : null
  if (submitPending) busyRef.current = true

  useEffect(() => {
    if (
      !draftReady ||
      navigationAuthorizedRef.current ||
      draftCandidate !== null ||
      activeDraftKey === null ||
      baselineMaterialSignatureRef.current === null
    )
      return
    const reconciliation = activeReconciliationRef.current
    if (!materialDirty && reconciliation === null) {
      try {
        getSessionStorage()?.removeItem(activeDraftKey)
      } catch {
        // A later material edit will retry a full write and surface any error.
      }
      return
    }
    const timer = window.setTimeout(() => {
      writeActiveDraft(reconciliation)
    }, 250)
    return () => window.clearTimeout(timer)
    // The serialized payload is represented by materialSignature + step; the
    // helpers intentionally stay out of deps to avoid writes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeDraftKey,
    draftCandidate,
    draftReady,
    materialDirty,
    materialSignature,
    outcomeUnknown,
    step,
  ])

  const canSubmit =
    stepModeReady &&
    sourceReady &&
    stepContentReady &&
    collabReady &&
    relaunchReady &&
    !relaunchError &&
    !submitPending &&
    outcomeUnknown === null
  const canStartNow = canSubmit && immediateGitIdentityReady
  // RFC-159: upload files can't be persisted into a schedule's JSON payload.
  // RFC-218 (impl-gate P2-7): agent path<ext> ports are upload inputs too —
  // scheduled fires are JSON-only, so scheduling them is refused server-side;
  // don't advertise a Save-scheduled that can only 422.
  const scheduleUnsupported =
    (kind === 'workflow' || kind === 'agent') && (hasUploadInput || hasUploads)
  const pageTitle = isEdit
    ? t('taskWizard.titleEdit')
    : search.schedule === true
      ? t('taskWizard.titleScheduled')
      : t('taskWizard.title')

  if (missingCapabilityPermission !== null) {
    return (
      <TaskCreationContractFrame
        title={pageTitle}
        sourceId={kind}
        blockingContent={
          <ErrorBanner
            error={
              new ApiError(
                403,
                'permission-required',
                `missing permission: ${missingCapabilityPermission}`,
                { requiredPermission: missingCapabilityPermission },
              )
            }
            testid="wizard-capability-error"
          />
        }
      />
    )
  }

  // An edit draft seeds exactly once. Before that barrier, loading/error are
  // full-page initial states; after it, a background refetch failure must not
  // replace (or re-seed) the user's draft.
  if (isEdit && !seededRef.current && !scheduleQ.isError)
    return (
      <TaskCreationContractFrame
        title={pageTitle}
        sourceId={kind}
        blockingContent={<LoadingState />}
      />
    )
  if (isEdit && !seededRef.current && scheduleQ.isError) {
    return (
      <TaskCreationContractFrame
        title={pageTitle}
        sourceId={kind}
        blockingContent={
          <ErrorBanner error={scheduleQ.error} onRetry={() => void scheduleQ.refetch()} />
        }
      />
    )
  }

  const steps = [
    { key: 'mode', title: t('taskWizard.stepMode') },
    { key: 'space', title: t('taskWizard.stepSpace') },
    { key: 'content', title: t('taskWizard.stepContent') },
    { key: 'confirm', title: t('taskWizard.stepConfirm') },
  ]

  const summaryEdit = (target: number) => (
    <button
      type="button"
      className="btn btn--xs"
      onClick={() => onNavigate(target)}
      data-testid={`wizard-summary-edit-${target}`}
    >
      {t('taskWizard.edit')}
    </button>
  )

  const draftRecoveryKindLabel =
    draftCandidate?.values.kind === 'workflow'
      ? t('taskWizard.kindWorkflow')
      : draftCandidate?.values.kind === 'workgroup'
        ? t('taskWizard.kindWorkgroup')
        : t('taskWizard.kindAgent')
  const draftRecoveryObject =
    draftCandidate?.values.kind === 'workflow'
      ? draftCandidate.values.workflowId
      : draftCandidate?.values.kind === 'workgroup'
        ? draftCandidate.values.workgroupId
        : (draftCandidate?.values.agentId ?? '')
  const draftRecoveryTaskName =
    draftCandidate?.values.taskName.trim() ||
    draftCandidate?.values.goal.trim() ||
    draftCandidate?.values.description.trim().slice(0, 160) ||
    ''
  const draftRecoverySavedAt =
    draftCandidate === null
      ? ''
      : new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(draftCandidate.savedAt))

  return (
    <TaskCreationContractFrame
      title={pageTitle}
      sourceId={kind}
      feedback={
        <FeedbackStack variant="section">
          {requiresCurrentGitIdentity && !immediateGitIdentityReady && (
            <NoticeBanner
              tone="warning"
              size="compact"
              title={t('taskWizard.gitCommitIdentityMissingTitle')}
              action={
                <Link
                  to="/account"
                  search={{ section: 'codePush' }}
                  className="btn btn--sm"
                  data-testid="wizard-git-identity-fix"
                >
                  {t('taskWizard.gitCommitIdentityFix')}
                </Link>
              }
              testid="wizard-git-identity-missing"
            >
              {t('taskWizard.gitCommitIdentityMissingBody')}
            </NoticeBanner>
          )}

          {draftWarning !== null && (
            <NoticeBanner tone="warning" size="compact" testid="wizard-draft-warning">
              {t(draftWarning)}
            </NoticeBanner>
          )}

          {persistenceError !== null && materialDirty && (
            <ErrorBanner
              error={persistenceError}
              message={t('taskWizard.draftWriteFailed')}
              testid="wizard-draft-write-error"
            />
          )}

          {draftReadError !== null && (
            <ErrorBanner
              error={draftReadError}
              message={t('taskWizard.draftReadFailed')}
              onRetry={() => {
                initializedDraftKeyRef.current = null
                setDraftReadError(null)
                setDraftReadAttempt((attempt) => attempt + 1)
              }}
              retryLabel={t('taskWizard.draftReadRetry')}
              testid="wizard-draft-read-error"
            />
          )}

          {(repoUrlReentryRequired ||
            inputReentryKeys.length > 0 ||
            uploadReselectKeys.length > 0) && (
            <NoticeBanner
              tone="warning"
              size="compact"
              title={t('taskWizard.draftReentryTitle')}
              testid="wizard-draft-reentry"
            >
              {t('taskWizard.draftReentryBody', {
                inputs: inputReentryKeys.length,
                uploads: uploadReselectKeys.length,
                repo: repoUrlReentryRequired ? 1 : 0,
              })}
            </NoticeBanner>
          )}

          {outcomeUnknown !== null && (
            <NoticeBanner
              tone="warning"
              title={t('taskWizard.outcomeUnknownTitle')}
              action={
                <div className="form-actions">
                  <a
                    className="btn btn--sm"
                    href={outcomeUnknown.operation === 'create-task' ? '/tasks' : '/scheduled'}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="wizard-reconcile-inventory"
                  >
                    {t('taskWizard.outcomeUnknownInspect')}
                  </a>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => {
                      activeReconciliationRef.current = null
                      setOutcomeUnknown(null)
                      start.reset()
                      saveConfig.reset()
                      createSchedule.reset()
                      writeActiveDraft(null)
                    }}
                    data-testid="wizard-reconcile-finish"
                  >
                    {t('taskWizard.outcomeUnknownFinish')}
                  </button>
                </div>
              }
              testid="wizard-outcome-unknown"
            >
              {t('taskWizard.outcomeUnknownBody', {
                name: outcomeUnknown.taskName || t('taskWizard.unnamedTask'),
                time: new Date(outcomeUnknown.startedAt).toLocaleString(),
              })}
            </NoticeBanner>
          )}

          {isEdit && scheduleQ.isError && (
            <div data-testid="wizard-schedule-stale-error">
              <ErrorBanner error={scheduleQ.error} onRetry={() => void scheduleQ.refetch()} />
            </div>
          )}

          {seedFailed && (
            <NoticeBanner tone="warning" size="compact" className="info-box--muted">
              <span data-testid="wizard-seed-degraded">{t('taskWizard.degradedBanner')}</span>
            </NoticeBanner>
          )}

          {relaunchError && (
            <div data-testid="wizard-relaunch-error">
              <ErrorBanner
                error={relaunchErrorQ?.error}
                onRetry={() => void relaunchErrorQ?.refetch()}
              />
            </div>
          )}

          {kind === 'workflow' && activeWorkflowVersionMismatch !== null && (
            <div data-testid="wizard-workflow-version-mismatch">
              <NoticeBanner
                tone="warning"
                title={t('taskWizard.workflowVersionMismatchTitle')}
                action={
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void recoverWorkflowVersion()}
                    data-testid="wizard-workflow-version-recover"
                  >
                    {t(
                      search.workflowVersion !== undefined
                        ? 'taskWizard.workflowVersionReturnToEditor'
                        : 'taskWizard.workflowVersionUseLatest',
                    )}
                  </button>
                }
              >
                {t('taskWizard.workflowVersionMismatchBody', {
                  expected: activeWorkflowVersionMismatch.expected,
                  current: activeWorkflowVersionMismatch.current,
                })}
              </NoticeBanner>
            </div>
          )}

          {startWorkflowVersionMismatch && (
            <div data-testid="wizard-workflow-submit-version-error">
              <ErrorBanner
                error={start.error}
                message={t('taskWizard.workflowLaunchVersionMismatchBody')}
                action={
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void recoverWorkflowVersion()}
                    data-testid="wizard-workflow-submit-version-recover"
                  >
                    {t(
                      search.workflowVersion !== undefined
                        ? 'taskWizard.workflowVersionReturnToEditor'
                        : 'taskWizard.workflowVersionUseLatest',
                    )}
                  </button>
                }
              />
            </div>
          )}

          {kind === 'workflow' &&
            ((search.schedule === true && canCreateScheduledTasks) || isEdit) && (
              <div data-testid="wizard-scheduled-workflow-policy">
                <NoticeBanner
                  tone="info"
                  size="compact"
                  title={t('taskWizard.scheduledWorkflowLatestTitle')}
                >
                  {t('taskWizard.scheduledWorkflowLatestBody')}
                </NoticeBanner>
              </div>
            )}

          {/* RFC-203 PR-2 实现门 P1：workflow/agent 启动失败改走富横幅——launch 的
            workflow-invalid 带 details.issues（节点/边定位），字符串壳会把它们
            全部丢掉，只剩一句「工作流内容不合法」。放在版本冲突横幅的同一正文
            区（同类失败的既有先例）；workgroup 分支保留 footer 的专用友好文案
            （workgroupLaunchErrorMessage）。 */}
          {outcomeUnknown === null &&
            kind !== 'workgroup' &&
            ((start.error !== null && start.error !== undefined && !startWorkflowVersionMismatch) ||
              (saveConfig.error !== null && saveConfig.error !== undefined)) && (
              <div data-testid="wizard-submit-error">
                <ErrorBanner
                  error={workflowTaskCreationDisplayError(start.error ?? saveConfig.error)}
                />
              </div>
            )}
        </FeedbackStack>
      }
      onSourceChange={selectCreationKind}
      availableSourceIds={
        !isEdit && !isRelaunch && search.schedule !== true ? undefined : props.availableSourceIds
      }
      sourceSelectionDisabled={isEdit}
      sourceSelectionHint={
        isEdit ? <div className="muted">{t('taskWizard.kindLocked')}</div> : undefined
      }
      materialDisabled={materialLocked}
      busy={submitPending}
      steps={steps}
      currentStep={step}
      maxReachable={maxVisited}
      onNavigate={onNavigate}
      nextEnabled={nextEnabled}
      navigationDisabled={submitPending}
      finalActions={
        <>
          {isEdit ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={runSaveConfig}
              disabled={!canSubmit}
              data-testid="wizard-save-config"
            >
              {saveConfig.isPending ? t('scheduled.saving') : t('taskWizard.saveConfig')}
            </button>
          ) : search.schedule === true && canCreateScheduledTasks ? (
            <>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setSaveScheduledOpen(true)}
                disabled={!canSubmit || scheduleUnsupported}
                title={scheduleUnsupported ? t('scheduled.uploadUnsupported') : undefined}
                data-testid="wizard-save-scheduled"
              >
                {t('taskWizard.saveScheduled')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={runStart}
                disabled={!canStartNow}
                data-testid="wizard-launch"
                data-tour="task-submit"
              >
                {start.isPending ? t('launch.starting') : t('taskWizard.launch')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--primary"
                onClick={runStart}
                disabled={!canStartNow}
                data-testid="wizard-launch"
                data-tour="task-submit"
              >
                {start.isPending ? t('launch.starting') : t('taskWizard.launch')}
              </button>
              {canCreateScheduledTasks && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setSaveScheduledOpen(true)}
                  disabled={!canSubmit || scheduleUnsupported}
                  title={scheduleUnsupported ? t('scheduled.uploadUnsupported') : undefined}
                  data-testid="wizard-save-scheduled"
                >
                  {t('taskWizard.saveScheduled')}
                </button>
              )}
            </>
          )}
          {start.isPending && space.kind === 'remote' && (
            <span className="muted" data-testid="wizard-cloning-hint">
              {t('launch.repoSource.cloningHint')}
            </span>
          )}
          {isEdit && collabLookup.isError && (
            <span className="form-actions__error" data-testid="wizard-collab-load-error">
              {t('scheduled.collabLoadError')}
            </span>
          )}
          {outcomeUnknown === null &&
            kind === 'workgroup' &&
            ((start.error !== null && start.error !== undefined) ||
              (saveConfig.error !== null && saveConfig.error !== undefined)) && (
              <span className="form-actions__error" data-testid="wizard-submit-error">
                {workgroupLaunchErrorMessage(start.error ?? saveConfig.error, t)}
              </span>
            )}
        </>
      }
      stepContent={
        <>
          {step === STEP_MODE && (
            <div className="form-grid">
              <TaskCreationResourcePicker
                label={objectFieldLabel}
                value={selectedObject}
                onChange={changeSelectedObject}
                options={objectOptions}
                loading={activeInventoryLoading}
                error={activeInventoryError ? activeInventoryQ.error : null}
                onRetry={() => void activeInventoryQ.refetch()}
                placeholder={t('taskWizard.objectPlaceholder')}
                emptyText={t('taskWizard.objectEmpty')}
                testId={`wizard-object-${kind}`}
              />
            </div>
          )}

          {step === STEP_SPACE && (
            <div className="form-grid">
              {spaceUnresolved && (
                <div
                  className="info-box info-box--muted"
                  role="alert"
                  data-testid="wizard-space-unresolved"
                >
                  {t('taskWizard.spaceUnresolvedNotice')}
                </div>
              )}
              <Field label={t('taskWizard.spaceLabel')} group>
                <ChoiceCards<'remote' | 'scratch'>
                  // RFC-248: 组空间在「仓库」这一档里表达（用户视角就是从仓库
                  // 列表里选了个带标签的条目），不单开一张卡。
                  value={space.kind === 'group' || space.kind === 'replay' ? 'remote' : space.kind}
                  onChange={(next) => {
                    if (next === space.kind) return
                    setSpace(defaultWizardSpace(next))
                    setSpaceUnresolved(false)
                    if (!isEdit) saveSpaceKindPref(next)
                  }}
                  ariaLabel={t('taskWizard.spaceLabel')}
                  testidPrefix="wizard-space"
                  options={[
                    {
                      value: 'scratch',
                      label: t('taskWizard.spaceScratch'),
                      description: t('taskWizard.spaceScratchDesc'),
                      icon: <ScratchIcon />,
                    },
                    {
                      value: 'remote',
                      label: t('taskWizard.spaceRemote'),
                      description: t('taskWizard.spaceRemoteDesc'),
                      icon: <RemoteIcon />,
                    },
                  ]}
                />
              </Field>
              {space.kind === 'replay' ? (
                // RFC-248 H9: 重放空间——展示来源任务并允许改回普通选择。布局本身
                // 是**冻结**的，不在这里编辑（要改布局就换成一个组）。
                <div className="info-box" data-testid="wizard-space-replay">
                  <div className="wizard-space-group__head">
                    <StatusChip kind="info" size="sm">
                      {t('taskWizard.spaceReplayChip')}
                    </StatusChip>
                    <code>{space.sourceTaskId}</code>
                    <button
                      type="button"
                      className="btn btn--sm"
                      data-testid="wizard-space-replay-change"
                      onClick={() => setSpace(defaultWizardSpace('remote'))}
                    >
                      {t('taskWizard.spaceGroupChange')}
                    </button>
                  </div>
                  <div className="muted">{t('taskWizard.spaceReplayHint')}</div>
                </div>
              ) : space.kind === 'group' || space.kind === 'remote' ? (
                <RepoSourceList
                  // RFC-249: repo and group are two values of the same picker,
                  // not two mutually replacing cards. Keeping row key 0 mounted
                  // removes the visual jump and makes switching reversible in
                  // the exact control where the choice was made.
                  repos={space.kind === 'remote' ? space.repos : [defaultRepoSource()]}
                  onChange={(repos) => setSpace({ kind: 'remote', repos })}
                  selectedGroupId={space.kind === 'group' ? space.groupId : undefined}
                  catalogEnabled={canReadRepos}
                  onSelectGroup={
                    canReadRepos ? (groupId) => setSpace({ kind: 'group', groupId }) : undefined
                  }
                  selectedGroupDetails={
                    space.kind === 'group' ? (
                      <section className="wizard-space-layout" data-testid="wizard-space-group">
                        <div className="wizard-space-layout__head">
                          <strong>{t('taskWizard.spaceGroupLayoutTitle')}</strong>
                          {selectedGroup !== undefined && (
                            <span className="muted">
                              {t('taskWizard.spaceGroupRepoCount', {
                                count: selectedGroup.flatRepoCount,
                              })}
                            </span>
                          )}
                        </div>
                        {/* RFC-248（实现门 P2）：启动前展示完整挂载布局。 */}
                        <QueryState
                          query={groupLayout}
                          data={readableGroupLayout?.nodes ?? readableGroupLayout?.repos ?? []}
                          emptyText={t('repoGroups.layout.empty')}
                          testid="wizard-space-group-layout-state"
                        >
                          {() => (
                            <RepoLayoutTree
                              nodes={readableGroupLayout?.nodes ?? []}
                              repos={readableGroupLayout?.repos ?? []}
                              testidPrefix="wizard-space-group-layout"
                              compact
                            />
                          )}
                        </QueryState>
                      </section>
                    ) : undefined
                  }
                  maxCount={1}
                />
              ) : (
                <div className="muted" data-testid="wizard-scratch-hint">
                  {t('taskWizard.spaceScratchHint')}
                </div>
              )}
            </div>
          )}

          {step === STEP_CONTENT && (
            <div className="form-grid">
              <Field
                label={t('launch.fieldTaskName')}
                required
                hint={t('launch.fieldTaskNameHint')}
              >
                <TextInput
                  value={taskName}
                  onChange={setTaskName}
                  required
                  maxLength={255}
                  data-testid="wizard-task-name"
                />
              </Field>

              {/* RFC-218 P1-5: never render a form shape before the agent row is
                known — an unloaded list is indistinguishable from "zero-port".
                Impl-gate P2-8: a SUCCESSFUL load without a matching row is
                not-found (stale/deleted/invisible deep link), not "loading" —
                say so, recoverable by re-picking on step 1. */}
              {kind === 'agent' &&
                !agentDataReady &&
                (agentsQ.isError ? (
                  <div data-testid="wizard-agent-load-error">
                    <ErrorBanner error={agentsQ.error} onRetry={() => void agentsQ.refetch()} />
                  </div>
                ) : agentsQ.isSuccess ? (
                  <ErrorBanner
                    error={null}
                    message={t('taskWizard.agentNotFound', { name: agentName })}
                    testid="wizard-agent-not-found"
                  />
                ) : (
                  <LoadingState />
                ))}
              {kind === 'agent' && agentDataReady && (
                <>
                  {!agentPorted && (
                    <Field
                      label={t('taskWizard.contentDescription')}
                      required
                      hint={t('taskWizard.contentDescriptionHint')}
                    >
                      <TextArea
                        value={description}
                        onChange={setDescription}
                        rows={8}
                        maxLength={65536}
                        data-testid="wizard-description"
                      />
                    </Field>
                  )}
                  {agentPorted && agentBlockers.length > 0 && (
                    <NoticeBanner tone="error" size="compact" testid="wizard-agent-blockers">
                      {t('taskWizard.agentPortsBlocked')}
                      <ul>
                        {agentBlockers.map((b) => (
                          <li key={`${b.kind}-${b.port}`}>
                            {b.kind === 'signal-port'
                              ? t('taskWizard.agentPortBlockedSignal', { port: b.port })
                              : t('taskWizard.agentPortBlockedName', { port: b.port })}
                          </li>
                        ))}
                      </ul>
                    </NoticeBanner>
                  )}
                  {/* 用户 2026-07-11：反问开关是核心行为选择，不藏进高级折叠。 */}
                  <Switch
                    checked={allowClarify}
                    onChange={setAllowClarify}
                    label={t('taskWizard.allowClarify')}
                    hint={t('taskWizard.allowClarifyHint')}
                  />
                </>
              )}

              {kind === 'workgroup' && (
                <Field
                  label={t('workgroups.launch.fieldGoal')}
                  required
                  hint={t('workgroups.launch.fieldGoalHint')}
                >
                  <TextArea
                    value={goal}
                    onChange={setGoal}
                    rows={8}
                    maxLength={65536}
                    data-testid="wizard-goal"
                  />
                </Field>
              )}

              {kind === 'workflow' && workflowQ.isLoading && <LoadingState />}
              {kind === 'workflow' && workflowQ.error !== null && workflowQ.error !== undefined && (
                <div data-testid="wizard-workflow-load-error">
                  <ErrorBanner error={workflowQ.error} onRetry={() => void workflowQ.refetch()} />
                </div>
              )}
              {kind === 'workflow' && workflowQ.data !== undefined && inputDefs.length === 0 && (
                <div className="muted">{t('launch.noInputs')}</div>
              )}
              {/* RFC-218: one field-render path for authored workflow inputs AND
                agent-port derived defs (the defs source is the ternary above). */}
              {(kind === 'workflow' || (kind === 'agent' && agentDataReady)) &&
                inputDefs.map((def) => (
                  <Field
                    key={def.key}
                    label={def.label}
                    required={def.required === true}
                    hint={def.description ?? portKindHint(def, t)}
                    error={
                      uploadDuplicate !== null &&
                      (uploadDuplicate.first.inputKey === def.key ||
                        uploadDuplicate.second.inputKey === def.key)
                        ? t('launch.upload.duplicateName', {
                            name: uploadDuplicate.second.filename,
                          })
                        : undefined
                    }
                  >
                    {def.kind === 'upload' ? (
                      <UploadPicker
                        def={def}
                        files={uploads[def.key] ?? []}
                        onChange={(next) => setUploads((prev) => ({ ...prev, [def.key]: next }))}
                      />
                    ) : (
                      <DynamicInput
                        def={def}
                        repoPath={
                          space.kind === 'remote'
                            ? resolveUrlRepoPath(
                                space.repos[0] ?? { kind: 'url', repoUrl: '', ref: '' },
                                readableCachedRepos,
                              )
                            : ''
                        }
                        sourceKind="url"
                        value={inputs[def.key] ?? ''}
                        onChange={(v) => setInputs((prev) => ({ ...prev, [def.key]: v }))}
                      />
                    )}
                  </Field>
                ))}

              <TaskCreationAdvancedSettings
                values={advancedValues}
                capabilities={advancedCapabilities}
                validation={advancedValidation}
                actorUserId={
                  canSearchUsers && actor.data?.source !== 'daemon'
                    ? actor.data?.user.id
                    : undefined
                }
                onCollaboratorsChange={setCollaborators}
                onWorkingBranchChange={setWorkingBranch}
                onAutoCommitPushChange={(value) => {
                  setAutoCommitPush(value)
                  saveAutoCommitPushPref(value)
                }}
                onMaxDurationMinChange={setMaxDurationMin}
                onMaxTotalTokensChange={setMaxTotalTokens}
              />
            </div>
          )}

          {step === STEP_CONFIRM && (
            <dl className="wizard-summary" data-testid="wizard-summary">
              <div className="wizard-summary__row">
                <dt>{t('taskWizard.kindLabel')}</dt>
                <dd data-testid="wizard-summary-kind">
                  {kind === 'workflow'
                    ? t('taskWizard.kindWorkflow')
                    : kind === 'agent'
                      ? t('taskWizard.kindAgent')
                      : t('taskWizard.kindWorkgroup')}
                  {' · '}
                  {selectedObjectLabel}
                  {!isEdit && summaryEdit(STEP_MODE)}
                </dd>
              </div>
              <div className="wizard-summary__row">
                <dt>{t('taskWizard.spaceLabel')}</dt>
                <dd data-testid="wizard-summary-space">
                  {space.kind === 'scratch'
                    ? t('taskWizard.spaceScratch')
                    : space.kind === 'replay'
                      ? t('taskWizard.spaceReplaySummary', { taskId: space.sourceTaskId })
                      : space.kind === 'group'
                        ? t('taskWizard.spaceGroupSummary', {
                            name:
                              readableRepoGroups.find((group) => group.id === space.groupId)
                                ?.name ?? space.groupId,
                          })
                        : space.repos
                            .map((r) => `${r.repoUrl}${r.ref ? ` @ ${r.ref}` : ''}`)
                            .join(', ')}
                  {summaryEdit(STEP_SPACE)}
                </dd>
              </div>
              <div className="wizard-summary__row">
                <dt>{t('launch.fieldTaskName')}</dt>
                <dd data-testid="wizard-summary-name">
                  {taskName.trim() || '—'}
                  {summaryEdit(STEP_CONTENT)}
                </dd>
              </div>
              <div className="wizard-summary__row">
                <dt>{t('taskWizard.stepContent')}</dt>
                <dd data-testid="wizard-summary-content">
                  {kind === 'workflow' || (kind === 'agent' && agentPorted) ? (
                    inputDefs.length === 0 ? (
                      kind === 'workflow' ? (
                        t('launch.noInputs')
                      ) : (
                        '—'
                      )
                    ) : (
                      <ul className="wizard-summary__inputs">
                        {inputDefs.map((def) => (
                          <li key={def.key}>
                            <span className="muted">{def.key}: </span>
                            {def.kind === 'upload'
                              ? (uploads[def.key] ?? []).map((f) => f.name).join(', ') || '—'
                              : truncate(inputs[def.key] ?? '')}
                          </li>
                        ))}
                      </ul>
                    )
                  ) : (
                    truncate(kind === 'agent' ? description : goal)
                  )}
                </dd>
              </div>
              <div className="wizard-summary__row">
                <dt>{t('taskWizard.gitCommitIdentity')}</dt>
                <dd data-testid="wizard-summary-git-identity">
                  {resolvesIdentityAtScheduleFire
                    ? t('taskWizard.gitCommitIdentityScheduleOwner')
                    : gitCommitIdentity !== null
                      ? `${gitCommitIdentity.name} <${gitCommitIdentity.email}>`
                      : actor.data?.source === 'daemon'
                        ? t('taskWizard.gitCommitIdentityInternal')
                        : t('taskWizard.gitCommitIdentityMissing')}
                </dd>
              </div>
              {(buildTaskCreationAdvancedSummary({
                values: advancedValues,
                capabilities: advancedCapabilities,
                t,
              }).length > 0 ||
                (kind === 'agent' && allowClarify)) && (
                <div className="wizard-summary__row">
                  <dt>{t('taskWizard.advanced')}</dt>
                  <dd data-testid="wizard-summary-advanced">
                    {[
                      ...buildTaskCreationAdvancedSummary({
                        values: advancedValues,
                        capabilities: advancedCapabilities,
                        t,
                      }),
                      kind === 'agent' && allowClarify ? t('taskWizard.clarifyOn') : null,
                    ]
                      .filter((s): s is string => s !== null)
                      .join(' · ')}
                    {summaryEdit(STEP_CONTENT)}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </>
      }
    >
      {!isEdit && canCreateScheduledTasks && (
        <ScheduleDialog
          open={saveScheduledOpen}
          onClose={() => {
            createSchedule.reset()
            setSaveScheduledOpen(false)
          }}
          buildLaunchPayload={scheduledEnvelope}
          launchKind={kind}
          defaultName={taskName.trim()}
          onCreate={runCreateSchedule}
          createPending={createSchedule.isPending}
          createError={createSchedule.error ?? persistenceError}
        />
      )}

      <Dialog
        open={draftCandidate !== null}
        onClose={() => {}}
        title={t('taskWizard.draftRecoveryTitle')}
        size="sm"
        dismissDisabled
        closeOnEsc={false}
        closeOnOverlayClick={false}
        initialFocusRef={restoreButtonRef}
        data-testid="wizard-draft-recovery"
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={discardRecoveryDraft}
              data-testid="wizard-draft-discard"
            >
              {t(
                draftCandidate?.reconciliation === undefined
                  ? 'taskWizard.draftDiscard'
                  : 'taskWizard.draftDiscardUnknown',
              )}
            </button>
            <button
              ref={restoreButtonRef}
              type="button"
              className="btn btn--primary"
              onClick={restoreDraft}
              data-testid="wizard-draft-restore"
            >
              {t(
                draftCandidate?.reconciliation === undefined
                  ? 'taskWizard.draftRestore'
                  : 'taskWizard.draftRestoreUnknown',
              )}
            </button>
          </>
        }
      >
        <p>
          {t(
            draftCandidate?.reconciliation === undefined
              ? 'taskWizard.draftRecoveryBody'
              : 'taskWizard.draftRecoveryUnknownBody',
          )}
        </p>
        {draftCandidate !== null ? (
          <dl className="wizard-summary wizard-draft-recovery__summary">
            <div className="wizard-summary__row">
              <dt>{t('taskWizard.kindLabel')}</dt>
              <dd>{draftRecoveryKindLabel}</dd>
            </div>
            <div className="wizard-summary__row">
              <dt>{t('taskWizard.draftRecoveryObject')}</dt>
              <dd>{draftRecoveryObject.trim() || t('taskWizard.draftRecoveryNotSelected')}</dd>
            </div>
            <div className="wizard-summary__row">
              <dt>{t('taskWizard.draftRecoveryTaskName')}</dt>
              <dd>{draftRecoveryTaskName || t('taskWizard.draftRecoveryNotNamed')}</dd>
            </div>
            <div className="wizard-summary__row">
              <dt>{t('taskWizard.draftRecoverySavedAt')}</dt>
              <dd>{draftRecoverySavedAt}</dd>
            </div>
          </dl>
        ) : null}
        {draftCandidate !== null &&
          draftCandidate.baselineFingerprint !== baselineFingerprintRef.current && (
            <NoticeBanner tone="warning" size="compact">
              {t('taskWizard.draftSourceChanged')}
            </NoticeBanner>
          )}
      </Dialog>

      <UnsavedChangesGuard
        dirtyRef={dirtyRef}
        busyRef={busyRef}
        busySinceRef={busySinceRef}
        onForceLeave={() => {
          submissionAbortRef.current?.abort()
          submissionAbortRef.current = null
          submissionOperationRef.current = null
          busyRef.current = false
          busySinceRef.current = null
        }}
        onDiscard={() => {
          if (busyRef.current) return false
          clearActiveDraft(true)
          setOutcomeUnknown(null)
          return true
        }}
        copyKeys={{
          title: 'taskWizard.unsavedTitle',
          body:
            outcomeUnknown === null ? 'taskWizard.unsavedBody' : 'taskWizard.unsavedUnknownBody',
          busyBody: 'taskWizard.unsavedBusyBody',
          stay: 'taskWizard.unsavedStay',
          discard: 'taskWizard.unsavedDiscard',
          forceLeave: 'taskWizard.unsavedForceLeave',
          forceLeaveWarning: 'taskWizard.unsavedForceLeaveWarning',
        }}
      />
    </TaskCreationContractFrame>
  )
}

function ScratchIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="4 3" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  )
}

function RemoteIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="12" r="2.2" />
      <path d="M7 8.2v7.6M9 17l6-4M9 7l6 4" />
    </svg>
  )
}

/**
 * RFC-218 (impl-gate P2-9): for an agent-port field with no author
 * description, surface the declared kind when it isn't a plain text shape —
 * a fallback composite kind (e.g. `list<list<string>>`) renders as a raw
 * textarea, and the user deserves to know what shape the agent expects.
 */
function portKindHint(
  def: { description?: string } & Record<string, unknown>,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | undefined {
  const agentKind = typeof def.agentKind === 'string' ? def.agentKind : undefined
  if (agentKind === undefined || agentKind === 'string' || agentKind === 'markdown')
    return undefined
  return t('taskWizard.portKindHint', { kind: agentKind })
}

function truncate(s: string): string {
  const v = s.trim()
  return v.length > 120 ? `${v.slice(0, 120)}…` : v || '—'
}

function isWorkflowVersionMismatchError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && error.status === 409 && error.code === 'workflow-version-mismatch'
  )
}

/**
 * A rejected workflow launch carries the complete validation result so editor
 * surfaces can explain both blockers and advisory warnings. In the task
 * creation wizard, however, only error-severity issues explain why Create was
 * refused; showing warnings here makes non-blocking guidance look like more
 * required work. Keep the original error contract and remove only explicitly
 * non-blocking issues from this one presentation surface.
 */
function workflowTaskCreationDisplayError(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.code !== 'workflow-invalid') return error
  if (typeof error.details !== 'object' || error.details === null || Array.isArray(error.details)) {
    return error
  }

  const details = error.details as Record<string, unknown>
  if (!Array.isArray(details.issues)) return error
  const blockingIssues = details.issues.filter((issue) => {
    if (typeof issue !== 'object' || issue === null || Array.isArray(issue)) return true
    return (issue as Record<string, unknown>).severity !== 'warning'
  })
  if (blockingIssues.length === details.issues.length) return error

  return new ApiError(error.status, error.code, error.message, {
    ...details,
    issues: blockingIssues,
  })
}
