// RFC-165 (T12) — /tasks/new: the unified 4-step task-creation wizard.
//
//   ① 执行方式 + 对象   (workflow / single agent / workgroup + which one)
//   ② 执行空间          (remote URL repos ⊕ scratch temp space)
//   ③ 名称 + 任务内容    (+ advanced fold: collaborators / git identity /
//                        branch & auto-push / limits / allowClarify)
//   ④ 只读确认          (summary with per-step "modify" backlinks; primary
//                        launch + secondary save-as-scheduled — swapped when
//                        `?schedule=1`)
//
// Deep links (`?kind=agent&agent=auditor`) pre-fill Step 1 and land on Step 2
// (D9). `?editScheduled=<id>` turns the wizard into the schedule's config
// editor: kind + object lock, every field seeds from the stored payload
// (kind-aware, RFC-159 absorbed), and Step 4's single button PUTs the rebuilt
// payload back.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  CachedRepo,
  ScheduledTask,
  Task,
  UserPublic,
  Workflow,
  Workgroup,
} from '@agent-workflow/shared'
import { isLooseValidBranchName, workgroupLaunchReadiness } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, NumberInput, Switch, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { ScheduleDialog } from '@/components/ScheduleDialog'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { Stepper } from '@/components/Stepper'
import { UserPicker } from '@/components/UserPicker'
import { DynamicInput } from '@/components/launch/DynamicInput'
import { RepoSourceList, type MultiRepoBlockedReason } from '@/components/launch/RepoSourceList'
import { UploadPicker } from '@/components/launch/UploadPicker'
import { useActor } from '@/hooks/useActor'
import { useUserLookup } from '@/hooks/useUserLookup'
import { describeApiError } from '@/i18n'
import { resolveUrlRepoPath, validateRepoUrl } from '@/lib/launch-repo-source'
import {
  buildAgentStartBody,
  buildScheduledEnvelope,
  buildWorkflowStartBody,
  buildWorkflowStartFormData,
  buildWorkgroupStartBody,
  defaultWizardSpace,
  loadAutoCommitPushPref,
  loadSpaceKindPref,
  payloadToWizardSeed,
  saveAutoCommitPushPref,
  saveSpaceKindPref,
  type WizardKind,
} from '@/lib/task-wizard'
import { workgroupLaunchErrorMessage } from '@/lib/workgroup-launch'
import { Route as RootRoute } from './__root'

interface TaskWizardSearch {
  kind?: WizardKind
  /** Deep-link object refs — one per kind (workflow id / agent name / group name). */
  workflow?: string
  agent?: string
  workgroup?: string
  /** `?schedule=1` — scheduled mode: save-as-scheduled becomes the primary action. */
  schedule?: boolean
  /** RFC-159 absorbed — edit an existing schedule's launch config. */
  editScheduled?: string
}

export const TaskWizardRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/new',
  component: TaskWizardPage,
  validateSearch: (raw: Record<string, unknown>): TaskWizardSearch => {
    const out: TaskWizardSearch = {}
    if (raw.kind === 'workflow' || raw.kind === 'agent' || raw.kind === 'workgroup')
      out.kind = raw.kind
    for (const k of ['workflow', 'agent', 'workgroup', 'editScheduled'] as const) {
      const v = raw[k]
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    if (raw.schedule === true || raw.schedule === 1 || raw.schedule === '1') out.schedule = true
    return out
  },
})

const STEP_MODE = 0
const STEP_SPACE = 1
const STEP_CONTENT = 2
const STEP_CONFIRM = 3

function TaskWizardPage() {
  const { t } = useTranslation()
  const search = TaskWizardRoute.useSearch()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const actor = useActor()
  const isEdit = search.editScheduled !== undefined

  // --- Step 1 state: execution kind + object -------------------------------
  const deepObject =
    search.kind === 'workflow'
      ? search.workflow
      : search.kind === 'agent'
        ? search.agent
        : search.kind === 'workgroup'
          ? search.workgroup
          : undefined
  const [kind, setKind] = useState<WizardKind>(search.kind ?? 'workflow')
  const [workflowId, setWorkflowId] = useState(
    search.kind === 'workflow' ? (search.workflow ?? '') : '',
  )
  const [agentName, setAgentName] = useState(search.kind === 'agent' ? (search.agent ?? '') : '')
  const [workgroupName, setWorkgroupName] = useState(
    search.kind === 'workgroup' ? (search.workgroup ?? '') : '',
  )

  // --- Step 2 state: execution space (D9: default remote, remember last) ---
  const [space, setSpace] = useState(() =>
    defaultWizardSpace(isEdit ? 'remote' : loadSpaceKindPref()),
  )

  // --- Step 3 state: name + content + advanced fold -------------------------
  const [taskName, setTaskName] = useState('')
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState<Record<string, File[]>>({})
  const [description, setDescription] = useState('')
  const [goal, setGoal] = useState('')
  const [allowClarify, setAllowClarify] = useState(true)
  const [collaborators, setCollaborators] = useState<UserPublic[]>([])
  const [gitUserName, setGitUserName] = useState('')
  const [gitUserEmail, setGitUserEmail] = useState('')
  const [workingBranch, setWorkingBranch] = useState('')
  const [autoCommitPush, setAutoCommitPush] = useState(loadAutoCommitPushPref())
  const [maxDurationMin, setMaxDurationMin] = useState<number | undefined>(undefined)
  const [maxTotalTokens, setMaxTotalTokens] = useState<number | undefined>(undefined)

  // --- Wizard chrome: current step + reachable frontier ---------------------
  const deepLinked = search.kind !== undefined && deepObject !== undefined && !isEdit
  const [step, setStep] = useState(deepLinked ? STEP_SPACE : STEP_MODE)
  const [maxVisited, setMaxVisited] = useState(deepLinked ? STEP_SPACE : STEP_MODE)
  const [saveScheduledOpen, setSaveScheduledOpen] = useState(false)

  // --- Object lists (Step 1) -------------------------------------------------
  const workflowsQ = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => api.get('/api/workflows', undefined, signal),
  })
  const agentsQ = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })
  const workgroupsQ = useQuery<Workgroup[]>({
    queryKey: ['workgroups'],
    queryFn: ({ signal }) => api.get('/api/workgroups', undefined, signal),
  })

  // Selected workflow detail — the wizard needs `definition.inputs` for Step 3.
  const workflowQ = useQuery<Workflow>({
    queryKey: ['workflows', workflowId],
    queryFn: ({ signal }) =>
      api.get(`/api/workflows/${encodeURIComponent(workflowId)}`, undefined, signal),
    enabled: kind === 'workflow' && workflowId !== '',
  })

  // RFC-110: matched cached clone for the files/git input pickers.
  const cachedRepos = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })

  // --- editScheduled: load + seed (kind-aware, one-shot) ---------------------
  const scheduleQ = useQuery<ScheduledTask>({
    queryKey: ['scheduled-tasks', 'detail', search.editScheduled],
    queryFn: ({ signal }) =>
      api.get(
        `/api/scheduled-tasks/${encodeURIComponent(search.editScheduled ?? '')}`,
        undefined,
        signal,
      ),
    enabled: isEdit,
  })
  const seededRef = useRef(false)
  const seedCollabIds = useRef<string[]>([])
  const [seedFailed, setSeedFailed] = useState(false)
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
    setWorkflowId(seed.workflowId ?? '')
    setAgentName(seed.agentName ?? '')
    setWorkgroupName(seed.workgroupName ?? '')
    setSpace(seed.space)
    setTaskName(seed.taskName)
    setInputs(seed.inputs)
    setDescription(seed.description)
    setGoal(seed.goal)
    setAllowClarify(seed.allowClarify)
    setGitUserName(seed.gitUserName)
    setGitUserEmail(seed.gitUserEmail)
    setWorkingBranch(seed.workingBranch)
    setAutoCommitPush(seed.autoCommitPush)
    setMaxDurationMin(
      seed.maxDurationMs !== undefined ? Math.round(seed.maxDurationMs / 60_000) : undefined,
    )
    setMaxTotalTokens(seed.maxTotalTokens)
    seedCollabIds.current = seed.collaboratorUserIds
    // Everything is pre-filled — open every step so the user can jump straight
    // to what they want to change (or to Confirm to just re-save).
    setStep(STEP_SPACE)
    setMaxVisited(STEP_CONFIRM)
  }, [isEdit, scheduleQ.data])

  // Collaborator ids → UserPublic chips (second async hop, RFC-159 pattern).
  const collabLookup = useUserLookup(seedCollabIds.current)
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

  // Seed the inputs map from the selected workflow's declared keys (merge:
  // stale keys drop, new keys start blank, user-typed values survive).
  useEffect(() => {
    if (kind !== 'workflow' || workflowQ.data === undefined) return
    const defs = workflowQ.data.definition.inputs ?? []
    setInputs((prev) => {
      const seeded: Record<string, string> = {}
      for (const i of defs) {
        seeded[i.key] = prev[i.key] ?? ''
      }
      return seeded
    })
  }, [kind, workflowQ.data])

  // --- Step 1 filtering (launchability projection) ---------------------------
  const workflowOptions = (workflowsQ.data ?? [])
    .filter((w) => w.builtin !== true)
    .map((w) => ({ value: w.id, label: w.name }))
  const agentOptions = (agentsQ.data ?? [])
    .filter((a) => a.builtin !== true)
    .map((a) => ({ value: a.name, label: a.name }))
  const workgroupOptions = (workgroupsQ.data ?? []).map((g) => {
    const readiness = workgroupLaunchReadiness(g)
    return {
      value: g.name,
      label: g.name,
      ...(readiness.ready
        ? {}
        : { disabled: true, description: t('taskWizard.workgroupNotReady') }),
    }
  })

  const selectedObject =
    kind === 'workflow' ? workflowId : kind === 'agent' ? agentName : workgroupName
  const selectedObjectLabel =
    kind === 'workflow'
      ? (workflowOptions.find((o) => o.value === workflowId)?.label ??
        workflowQ.data?.name ??
        workflowId)
      : selectedObject

  // --- Gating ---------------------------------------------------------------
  const inputDefs = kind === 'workflow' ? (workflowQ.data?.definition.inputs ?? []) : []
  const missingRequired = inputDefs.some((def) => {
    if (def.kind === 'upload') {
      const list = uploads[def.key] ?? []
      const rec = def as Record<string, unknown>
      const minCount = typeof rec.minCount === 'number' ? rec.minCount : 0
      if (def.required === true && list.length === 0) return true
      return list.length < minCount
    }
    return def.required === true && (inputs[def.key] ?? '').trim() === ''
  })
  const hasUploads = Object.values(uploads).some((arr) => arr.length > 0)
  const hasUploadInput = inputDefs.some((d) => d.kind === 'upload')
  const hasWrapperGitNode =
    kind === 'workflow' &&
    (workflowQ.data?.definition.nodes ?? []).some((n) => n.kind === 'wrapper-git')
  const multiRepoBlockedReason: MultiRepoBlockedReason | null =
    kind === 'workflow' && space.kind === 'remote' && space.repos.length > 1
      ? hasWrapperGitNode
        ? 'wrapper-git'
        : hasUploadInput
          ? 'upload'
          : null
      : null

  const stepModeReady = selectedObject !== ''
  const sourceReady =
    space.kind === 'scratch' || space.repos.every((r) => validateRepoUrl(r.repoUrl) === null)
  const nameReady = taskName.trim().length > 0
  const contentReady =
    kind === 'workflow'
      ? !missingRequired
      : kind === 'agent'
        ? description.trim().length > 0
        : goal.trim().length > 0
  const gitNameTrim = gitUserName.trim()
  const gitEmailTrim = gitUserEmail.trim()
  const gitBoth = gitNameTrim !== '' && gitEmailTrim !== ''
  const gitNeither = gitNameTrim === '' && gitEmailTrim === ''
  const gitPairingError = !gitBoth && !gitNeither
  const gitEmailFormatError = gitEmailTrim !== '' && !/^[^\s@]+@[^\s@]+$/.test(gitEmailTrim)
  const gitIdentityOk = gitNeither || (gitBoth && !gitEmailFormatError)
  const workingBranchTrim = workingBranch.trim()
  const workingBranchError =
    space.kind === 'remote' &&
    workingBranchTrim !== '' &&
    !isLooseValidBranchName(workingBranchTrim)
  const stepContentReady = nameReady && contentReady && gitIdentityOk && !workingBranchError
  // RFC-159 P2: editing a schedule with collaborators must wait for the id →
  // UserPublic lookup, else Save rebuilds the body with an empty set.
  const collabReady = !isEdit || seedCollabIds.current.length === 0 || collabLookup.isSuccess

  const nextEnabled =
    step === STEP_MODE ? stepModeReady : step === STEP_SPACE ? sourceReady : stepContentReady

  const onNavigate = (i: number) => {
    setStep(i)
    setMaxVisited((mv) => Math.max(mv, i))
  }

  // --- Submission -------------------------------------------------------------
  const collectAdvanced = () => ({
    ...(collaborators.length > 0 ? { collaboratorUserIds: collaborators.map((u) => u.id) } : {}),
    ...(gitBoth ? { gitUserName: gitNameTrim, gitUserEmail: gitEmailTrim } : {}),
    ...(workingBranchTrim !== '' ? { workingBranch: workingBranchTrim } : {}),
    ...(autoCommitPush ? { autoCommitPush: true } : {}),
    ...(maxDurationMin !== undefined && maxDurationMin > 0
      ? { maxDurationMs: Math.round(maxDurationMin * 60_000) }
      : {}),
    ...(maxTotalTokens !== undefined && maxTotalTokens > 0 ? { maxTotalTokens } : {}),
  })

  const buildImmediateBody = (): Record<string, unknown> => {
    if (kind === 'agent') {
      return buildAgentStartBody(space, {
        name: taskName.trim(),
        description: description.trim(),
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

  const start = useMutation({
    mutationFn: () => {
      if (kind === 'agent') {
        return api.post<Task>(
          `/api/agents/${encodeURIComponent(agentName)}/tasks`,
          buildImmediateBody(),
        )
      }
      if (kind === 'workgroup') {
        return api.post<Task>(
          `/api/workgroups/${encodeURIComponent(workgroupName)}/tasks`,
          buildImmediateBody(),
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
          ),
        )
      }
      return api.post<Task>('/api/tasks', buildImmediateBody())
    },
    onSuccess: (created) => navigate({ to: '/tasks/$id', params: { id: created.id } }),
  })

  const scheduledEnvelope = () =>
    buildScheduledEnvelope(kind, buildImmediateBody(), { agentName, workgroupName })

  const saveConfig = useMutation({
    mutationFn: () =>
      api.put(`/api/scheduled-tasks/${encodeURIComponent(search.editScheduled ?? '')}`, {
        launchPayload: scheduledEnvelope(),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      void navigate({ to: '/scheduled/$id', params: { id: search.editScheduled ?? '' } })
    },
  })

  const submitPending = start.isPending || saveConfig.isPending
  const canSubmit =
    stepModeReady &&
    sourceReady &&
    stepContentReady &&
    multiRepoBlockedReason === null &&
    collabReady &&
    !submitPending
  // RFC-159: upload files can't be persisted into a schedule's JSON payload.
  const scheduleUnsupported = kind === 'workflow' && (hasUploadInput || hasUploads)

  if (isEdit && scheduleQ.isLoading)
    return (
      <div className="page">
        <LoadingState />
      </div>
    )
  if (isEdit && scheduleQ.error !== null && scheduleQ.error !== undefined)
    return <div className="page error-box">{describeApiError(scheduleQ.error)}</div>

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

  return (
    <div className="page" data-testid="task-wizard">
      <header className="page__header">
        <h1>
          {isEdit
            ? t('taskWizard.titleEdit')
            : search.schedule === true
              ? t('taskWizard.titleScheduled')
              : t('taskWizard.title')}
        </h1>
      </header>

      {seedFailed && (
        <div className="info-box info-box--muted" role="alert" data-testid="wizard-seed-degraded">
          {t('taskWizard.degradedBanner')}
        </div>
      )}

      <Stepper
        steps={steps}
        current={step}
        maxReachable={maxVisited}
        onNavigate={onNavigate}
        nextEnabled={nextEnabled}
        rootTestid="task-wizard-stepper"
        finalActions={
          <>
            {isEdit ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => saveConfig.mutate()}
                disabled={!canSubmit}
                data-testid="wizard-save-config"
              >
                {saveConfig.isPending ? t('scheduled.saving') : t('taskWizard.saveConfig')}
              </button>
            ) : search.schedule === true ? (
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
                  onClick={() => start.mutate()}
                  disabled={!canSubmit}
                  data-testid="wizard-launch"
                >
                  {start.isPending ? t('launch.starting') : t('taskWizard.launch')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => start.mutate()}
                  disabled={!canSubmit}
                  data-testid="wizard-launch"
                >
                  {start.isPending ? t('launch.starting') : t('taskWizard.launch')}
                </button>
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
              </>
            )}
            {start.isPending && space.kind === 'remote' && (
              <span className="muted" data-testid="wizard-cloning-hint">
                {t('launch.repoSource.cloningHint')}
              </span>
            )}
            {(start.error !== null && start.error !== undefined) ||
            (saveConfig.error !== null && saveConfig.error !== undefined) ? (
              <span className="form-actions__error" data-testid="wizard-submit-error">
                {kind === 'workgroup'
                  ? workgroupLaunchErrorMessage(start.error ?? saveConfig.error, t)
                  : describeApiError(start.error ?? saveConfig.error)}
              </span>
            ) : null}
          </>
        }
      >
        {step === STEP_MODE && (
          <div className="form-grid">
            <Field label={t('taskWizard.kindLabel')} group>
              <Segmented<WizardKind>
                value={kind}
                onChange={(next) => {
                  if (next === kind) return
                  setKind(next)
                  // Changing the kind resets the object (and the object-scoped
                  // content the user may have typed stays — it only goes on the
                  // wire for the active kind).
                  setWorkflowId('')
                  setAgentName('')
                  setWorkgroupName('')
                }}
                disabled={isEdit}
                ariaLabel={t('taskWizard.kindLabel')}
                testidPrefix="wizard-kind"
                options={[
                  { value: 'workflow', label: t('taskWizard.kindWorkflow') },
                  { value: 'agent', label: t('taskWizard.kindAgent') },
                  { value: 'workgroup', label: t('taskWizard.kindWorkgroup') },
                ]}
              />
            </Field>
            {isEdit && <div className="muted">{t('taskWizard.kindLocked')}</div>}

            <Field
              label={
                kind === 'workflow'
                  ? t('taskWizard.objectWorkflow')
                  : kind === 'agent'
                    ? t('taskWizard.objectAgent')
                    : t('taskWizard.objectWorkgroup')
              }
              required
              hint={
                kind === 'workflow'
                  ? t('taskWizard.kindHintWorkflow')
                  : kind === 'agent'
                    ? t('taskWizard.kindHintAgent')
                    : t('taskWizard.kindHintWorkgroup')
              }
            >
              {(kind === 'workflow' && workflowOptions.length === 0) ||
              (kind === 'agent' && agentOptions.length === 0) ||
              (kind === 'workgroup' && workgroupOptions.length === 0) ? (
                <div className="muted" data-testid="wizard-object-empty">
                  {t('taskWizard.objectEmpty')}
                </div>
              ) : kind === 'workflow' ? (
                <Select
                  value={workflowId}
                  onChange={setWorkflowId}
                  options={workflowOptions}
                  disabled={isEdit}
                  placeholder={t('taskWizard.objectPlaceholder')}
                  data-testid="wizard-object-workflow"
                />
              ) : kind === 'agent' ? (
                <Select
                  value={agentName}
                  onChange={setAgentName}
                  options={agentOptions}
                  disabled={isEdit}
                  placeholder={t('taskWizard.objectPlaceholder')}
                  data-testid="wizard-object-agent"
                />
              ) : (
                <Select
                  value={workgroupName}
                  onChange={setWorkgroupName}
                  options={workgroupOptions}
                  disabled={isEdit}
                  placeholder={t('taskWizard.objectPlaceholder')}
                  data-testid="wizard-object-workgroup"
                />
              )}
            </Field>
          </div>
        )}

        {step === STEP_SPACE && (
          <div className="form-grid">
            <Field label={t('taskWizard.spaceLabel')} group>
              <Segmented<'remote' | 'scratch'>
                value={space.kind}
                onChange={(next) => {
                  if (next === space.kind) return
                  setSpace(defaultWizardSpace(next))
                  if (!isEdit) saveSpaceKindPref(next)
                }}
                ariaLabel={t('taskWizard.spaceLabel')}
                testidPrefix="wizard-space"
                options={[
                  { value: 'remote', label: t('taskWizard.spaceRemote') },
                  { value: 'scratch', label: t('taskWizard.spaceScratch') },
                ]}
              />
            </Field>
            {space.kind === 'remote' ? (
              <RepoSourceList
                repos={space.repos}
                onChange={(repos) => setSpace({ kind: 'remote', repos })}
                multiRepoBlockedReason={multiRepoBlockedReason}
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
            <Field label={t('launch.fieldTaskName')} required hint={t('launch.fieldTaskNameHint')}>
              <TextInput
                value={taskName}
                onChange={setTaskName}
                required
                maxLength={255}
                data-testid="wizard-task-name"
              />
            </Field>

            {kind === 'agent' && (
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
            {kind === 'workflow' && !workflowQ.isLoading && inputDefs.length === 0 && (
              <div className="muted">{t('launch.noInputs')}</div>
            )}
            {kind === 'workflow' &&
              inputDefs.map((def) => (
                <Field
                  key={def.key}
                  label={`${def.label} (${def.key})`}
                  required={def.required === true}
                  hint={def.description}
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
                              cachedRepos.data?.items ?? [],
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

            <details className="launch-collapsible" data-testid="wizard-advanced">
              <summary>{t('taskWizard.advanced')}</summary>
              <div className="launch-collapsible__body">
                {kind === 'agent' && (
                  <Switch
                    checked={allowClarify}
                    onChange={setAllowClarify}
                    label={t('taskWizard.allowClarify')}
                    hint={t('taskWizard.allowClarifyHint')}
                  />
                )}
                {actor.data !== null &&
                  actor.data !== undefined &&
                  actor.data.source !== 'daemon' && (
                    <Field label={t('members.users')} hint={t('members.hint')}>
                      <UserPicker
                        value={collaborators}
                        onChange={setCollaborators}
                        excludeIds={[actor.data.user.id]}
                        testidPrefix="wizard-collaborators"
                      />
                    </Field>
                  )}
                {space.kind === 'remote' && (
                  <>
                    <Field
                      label={t('launch.workingBranch.label')}
                      hint={
                        workingBranchError
                          ? t('launch.workingBranch.invalid')
                          : t('launch.workingBranch.hint')
                      }
                    >
                      <TextInput
                        value={workingBranch}
                        onChange={setWorkingBranch}
                        maxLength={255}
                        placeholder={t('launch.workingBranch.placeholder')}
                        data-testid="wizard-working-branch"
                      />
                    </Field>
                    {workingBranchError && (
                      <div className="error-text" role="alert" data-testid="wizard-branch-error">
                        {t('launch.workingBranch.invalid')}
                      </div>
                    )}
                    <Switch
                      checked={autoCommitPush}
                      onChange={(v) => {
                        setAutoCommitPush(v)
                        saveAutoCommitPushPref(v)
                      }}
                      label={t('launch.autoCommitPush.label')}
                      hint={t('launch.autoCommitPush.hint')}
                    />
                  </>
                )}
                <Field label={t('launch.gitIdentity.name')} hint={t('launch.gitIdentity.hint')}>
                  <TextInput
                    value={gitUserName}
                    onChange={setGitUserName}
                    maxLength={255}
                    data-testid="wizard-git-user-name"
                  />
                </Field>
                <Field
                  label={t('launch.gitIdentity.email')}
                  {...(gitEmailFormatError ? { hint: t('launch.gitIdentity.emailInvalid') } : {})}
                >
                  <TextInput
                    value={gitUserEmail}
                    onChange={setGitUserEmail}
                    maxLength={255}
                    data-testid="wizard-git-user-email"
                  />
                </Field>
                {gitPairingError && (
                  <div className="error-text" role="alert" data-testid="wizard-git-pair-error">
                    {t('launch.gitIdentity.pairingError')}
                  </div>
                )}
                <Field
                  label={t('taskWizard.maxDurationMin')}
                  hint={t('taskWizard.maxDurationMinHint')}
                >
                  <NumberInput
                    value={maxDurationMin}
                    onChange={setMaxDurationMin}
                    min={1}
                    step={1}
                    data-testid="wizard-max-duration"
                  />
                </Field>
                <Field
                  label={t('taskWizard.maxTotalTokens')}
                  hint={t('taskWizard.maxTotalTokensHint')}
                >
                  <NumberInput
                    value={maxTotalTokens}
                    onChange={setMaxTotalTokens}
                    min={1}
                    step={1}
                    data-testid="wizard-max-tokens"
                  />
                </Field>
              </div>
            </details>
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
                  : space.repos.map((r) => `${r.repoUrl}${r.ref ? ` @ ${r.ref}` : ''}`).join(', ')}
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
                {kind === 'workflow'
                  ? t('taskWizard.summaryInputs', { count: inputDefs.length })
                  : truncate(kind === 'agent' ? description : goal)}
              </dd>
            </div>
            {(collaborators.length > 0 ||
              gitBoth ||
              (space.kind === 'remote' && workingBranchTrim !== '') ||
              (space.kind === 'remote' && autoCommitPush) ||
              maxDurationMin !== undefined ||
              maxTotalTokens !== undefined ||
              (kind === 'agent' && !allowClarify)) && (
              <div className="wizard-summary__row">
                <dt>{t('taskWizard.advanced')}</dt>
                <dd data-testid="wizard-summary-advanced">
                  {[
                    collaborators.length > 0
                      ? t('taskWizard.summaryCollaborators', { count: collaborators.length })
                      : null,
                    gitBoth ? `${gitNameTrim} <${gitEmailTrim}>` : null,
                    space.kind === 'remote' && workingBranchTrim !== '' ? workingBranchTrim : null,
                    space.kind === 'remote' && autoCommitPush
                      ? t('launch.autoCommitPush.label')
                      : null,
                    maxDurationMin !== undefined
                      ? `${t('taskWizard.maxDurationMin')}: ${maxDurationMin}`
                      : null,
                    maxTotalTokens !== undefined
                      ? `${t('taskWizard.maxTotalTokens')}: ${maxTotalTokens}`
                      : null,
                    kind === 'agent' && !allowClarify ? t('taskWizard.clarifyOff') : null,
                  ]
                    .filter((s): s is string => s !== null)
                    .join(' · ')}
                  {summaryEdit(STEP_CONTENT)}
                </dd>
              </div>
            )}
          </dl>
        )}
      </Stepper>

      {!isEdit && (
        <ScheduleDialog
          open={saveScheduledOpen}
          onClose={() => setSaveScheduledOpen(false)}
          buildLaunchPayload={scheduledEnvelope}
          launchKind={kind}
          defaultName={taskName.trim()}
        />
      )}
    </div>
  )
}

function truncate(s: string): string {
  const v = s.trim()
  return v.length > 120 ? `${v.slice(0, 120)}…` : v || '—'
}
