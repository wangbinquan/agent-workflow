// /workflows/$id/launch — minimal task starter.
//
// RFC-165: URL-only repo sources (remote workspace / `file://` escape hatch).
// The recent-repos picker, refs lookup and the local-path launch mode they
// served are retired.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  CachedRepo,
  UserPublic,
  ScheduledTask,
  Task,
  Workflow,
  WorkflowInput,
} from '@agent-workflow/shared'
import { isLooseValidBranchName } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { useActor } from '@/hooks/useActor'
import { useUserLookup } from '@/hooks/useUserLookup'
import { UserPicker } from '@/components/UserPicker'
import { EnumPicker } from '@/components/launch/EnumPicker'
import { FilesPicker } from '@/components/launch/FilesPicker'
import { GitPicker } from '@/components/launch/GitPicker'
import { UploadPicker } from '@/components/launch/UploadPicker'
import { RepoSourceList, type MultiRepoBlockedReason } from '@/components/launch/RepoSourceList'
import { Field, Switch, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import {
  bodyToRepoSources,
  buildLaunchBody,
  buildLaunchBodyMultiRepo,
  buildLaunchFormDataV2,
  defaultRepoSource,
  resolveUrlRepoPath,
  validateRepoUrl,
  type RepoSource,
} from '@/lib/launch-repo-source'
import { ScheduleDialog } from '@/components/ScheduleDialog'
import { Route as RootRoute } from './__root'

/**
 * RFC-159 (edit-config) — optional search param. When `editScheduled` is the id
 * of a scheduled task, the launch form loads that schedule's stored launchPayload,
 * seeds every field from it, and PUTs the rebuilt payload back (edit mode) instead
 * of POSTing a new task (create mode). Absent → the form is the plain launcher.
 */
interface LaunchSearch {
  editScheduled?: string
}

export const LaunchRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows/$id/launch',
  component: LaunchPage,
  validateSearch: (raw: Record<string, unknown>): LaunchSearch => {
    const v = raw.editScheduled
    return typeof v === 'string' && v.length > 0 ? { editScheduled: v } : {}
  },
})

function LaunchPage() {
  const { t } = useTranslation()
  const { id } = LaunchRoute.useParams()
  const { editScheduled } = LaunchRoute.useSearch()
  // RFC-159 (edit-config): edit mode edits an existing scheduled task's config
  // rather than launching a new task.
  const isEdit = editScheduled !== undefined
  const navigate = useNavigate()
  const qc = useQueryClient()
  const workflow = useQuery<Workflow>({
    queryKey: ['workflows', id],
    queryFn: ({ signal }) => api.get(`/api/workflows/${encodeURIComponent(id)}`, undefined, signal),
  })
  // RFC-159 (edit-config): load the schedule being edited so we can seed the form
  // from its stored launchPayload. Shares the detail page's queryKey.
  const scheduleQ = useQuery<ScheduledTask>({
    queryKey: ['scheduled-tasks', 'detail', editScheduled],
    queryFn: ({ signal }) =>
      api.get(`/api/scheduled-tasks/${encodeURIComponent(editScheduled ?? '')}`, undefined, signal),
    enabled: isEdit,
  })
  // RFC-159 (edit-config): resolve the stored collaborator ids back to UserPublic
  // rows so they seed the UserPicker as chips (deleted users just drop out).
  const collabLookup = useUserLookup(scheduleQ.data?.launchPayload?.collaboratorUserIds ?? [])

  // RFC-037: user-supplied display name for this task. Required for submit.
  const [taskName, setTaskName] = useState('')
  // RFC-099 (D10) — optional initial task users (launcher = owner automatically).
  const [collaborators, setCollaborators] = useState<UserPublic[]>([])
  const actor = useActor()
  // RFC-067: optional per-task Git commit identity. Both blank → daemon
  // default (legacy behavior). Both set → runner injects GIT_AUTHOR_* /
  // GIT_COMMITTER_*. Half-set → blocked client-side (matches StartTaskSchema
  // XOR superRefine).
  const [gitUserName, setGitUserName] = useState('')
  const [gitUserEmail, setGitUserEmail] = useState('')
  // RFC-075: optional working branch (applies to every repo) + the auto
  // commit&push toggle. Both independent. The toggle's last value is
  // remembered in localStorage; the branch name is task-specific so it isn't.
  const [workingBranch, setWorkingBranch] = useState('')
  const [autoCommitPush, setAutoCommitPush] = useState(loadAutoCommitPushPref())
  // RFC-024 + RFC-066: 1..N repo sources (default = one empty url-mode row);
  // the `+ Add` button in `<RepoSourceList>` grows the array, the `−` button
  // shrinks it.
  const [repos, setRepos] = useState<RepoSource[]>([defaultRepoSource()])
  const primarySource: RepoSource = repos[0] ?? defaultRepoSource()
  const [inputs, setInputs] = useState<Record<string, string>>({})
  // RFC-020: parallel state for `kind: 'upload'` inputs; key → picked Files.
  const [uploads, setUploads] = useState<Record<string, File[]>>({})

  // RFC-159 (edit-config): one-shot guards so async refetches don't clobber the
  // user's in-progress edits after the initial seed.
  const seededRef = useRef(false)
  const collabSeededRef = useRef(false)

  // Seed inputs map when workflow loads.
  useEffect(() => {
    if (workflow.data === undefined) return
    const seeded: Record<string, string> = {}
    for (const i of workflow.data.definition.inputs ?? []) {
      seeded[i.key] = inputs[i.key] ?? ''
    }
    setInputs(seeded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.data])

  // RFC-159 (edit-config): seed every non-collaborator field from the stored
  // launchPayload, once, when BOTH the workflow (for the declared input keys) and
  // the schedule have loaded — so the inputs merge is authoritative no matter which
  // query resolves first. `seededRef` makes it fire exactly once.
  useEffect(() => {
    if (!isEdit) return
    if (workflow.data === undefined || scheduleQ.data === undefined) return
    if (seededRef.current) return
    seededRef.current = true
    const p = scheduleQ.data.launchPayload
    if (p === null) return // RFC-165: degraded row — leave the form blank for repair
    setTaskName(p.name)
    setRepos(bodyToRepoSources(p))
    setWorkingBranch(p.workingBranch ?? '')
    setAutoCommitPush(p.autoCommitPush === true)
    setGitUserName(p.gitUserName ?? '')
    setGitUserEmail(p.gitUserEmail ?? '')
    // Merge the stored inputs over the workflow's declared keys: keys the workflow
    // no longer declares drop out, newly-added keys start blank.
    const merged: Record<string, string> = {}
    for (const def of workflow.data.definition.inputs ?? []) {
      merged[def.key] = p.inputs[def.key] ?? ''
    }
    setInputs(merged)
  }, [isEdit, workflow.data, scheduleQ.data])

  // RFC-159 (edit-config): collaborators need a second async hop (ids →
  // UserPublic), so they seed separately once that lookup resolves.
  useEffect(() => {
    if (!isEdit) return
    if (scheduleQ.data === undefined) return
    if (collabSeededRef.current) return
    const ids = scheduleQ.data.launchPayload?.collaboratorUserIds ?? []
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

  // RFC-110: cached-repo list (shared queryKey with RepoSourceRow → React Query
  // dedups to one request) so the file/git pickers can resolve the typed URL to
  // an already-cached clone's localPath and enumerate it. A query failure
  // simply yields no matches → pickers fall back to a text input, never blocking.
  const cachedRepos = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })
  // The local repoPath the file/git pickers enumerate against: the matched
  // cached clone ('' when uncached → picker shows a text fallback).
  const effectiveRepoPath = resolveUrlRepoPath(primarySource, cachedRepos.data?.items ?? [])

  const hasUploads = Object.values(uploads).some((arr) => arr.length > 0)
  // RFC-159: scheduled tasks replay a JSON body, so workflows with any upload input
  // (whose files can't be persisted) can't be scheduled.
  const [saveScheduledOpen, setSaveScheduledOpen] = useState(false)
  const scheduleUnsupported =
    hasUploads || (workflow.data?.definition.inputs ?? []).some((i) => i.kind === 'upload')
  const buildScheduledLaunchBody = (): unknown => {
    const launchCommon = {
      workflowId: id,
      name: taskName.trim(),
      inputs,
      ...(collaborators.length > 0 ? { collaboratorUserIds: collaborators.map((u) => u.id) } : {}),
      ...(gitUserName.trim() !== '' && gitUserEmail.trim() !== ''
        ? { gitUserName: gitUserName.trim(), gitUserEmail: gitUserEmail.trim() }
        : {}),
      ...(workingBranch.trim() !== '' ? { workingBranch: workingBranch.trim() } : {}),
      ...(autoCommitPush ? { autoCommitPush: true } : {}),
    }
    return repos.length > 1
      ? buildLaunchBodyMultiRepo(repos, launchCommon)
      : buildLaunchBody(primarySource, launchCommon)
  }
  const start = useMutation({
    mutationFn: () => {
      // RFC-020: any kind:'upload' input declared on the workflow drives a
      // multipart submit — even when the user picked zero files, so the
      // backend's upload pipeline runs (it gates min/maxCount centrally).
      const hasUploadKind = (workflow.data?.definition.inputs ?? []).some(
        (i) => i.kind === 'upload',
      )
      // RFC-037: user-supplied display name. Trim before stamping into the
      // body so the frontend doesn't waste a 422 round-trip on stray spaces.
      const name = taskName.trim()
      // RFC-067: trim + pair-check the optional Git commit identity.
      // canSubmit gate already blocks half-set; the trim values feed straight
      // into buildLaunchBody, which omits the keys when blank.
      const trimGitName = gitUserName.trim()
      const trimGitEmail = gitUserEmail.trim()
      // RFC-075: working branch (omit when blank) + auto commit&push (omit
      // when false so legacy bodies stay byte-identical).
      const trimWorkingBranch = workingBranch.trim()
      const launchCommon = {
        workflowId: id,
        name,
        inputs,
        ...(collaborators.length > 0
          ? { collaboratorUserIds: collaborators.map((u) => u.id) }
          : {}),
        ...(trimGitName !== '' && trimGitEmail !== ''
          ? { gitUserName: trimGitName, gitUserEmail: trimGitEmail }
          : {}),
        ...(trimWorkingBranch !== '' ? { workingBranch: trimWorkingBranch } : {}),
        ...(autoCommitPush ? { autoCommitPush: true } : {}),
      }
      // RFC-066: multi-repo (length > 1) → always JSON post via the v2 body
      // helper. Multi-repo + uploads is gated by T6's `canSubmit` predicate
      // BEFORE reaching this branch; this path is unreachable when uploads
      // and multi-repo coexist.
      if (repos.length > 1) {
        return api.post<Task>('/api/tasks', buildLaunchBodyMultiRepo(repos, launchCommon))
      }
      const onlySource = primarySource
      if (hasUploadKind || hasUploads) {
        // RFC-107: URL + uploads. The multipart route resolves the URL into the
        // repo cache before materializing the workspace, then lands the files;
        // buildLaunchFormDataV2 carries repoUrl + ref.
        return api.postMultipart<Task>(
          '/api/tasks',
          buildLaunchFormDataV2(onlySource, launchCommon, uploads),
        )
      }
      return api.post<Task>('/api/tasks', buildLaunchBody(onlySource, launchCommon))
    },
    onSuccess: (t) => navigate({ to: '/tasks/$id', params: { id: t.id } }),
  })
  // RFC-159 (edit-config): PUT the rebuilt launchPayload back onto the schedule.
  // Reuses buildScheduledLaunchBody (the same body helper the save-as-scheduled
  // dialog uses) so the wire shape matches a freshly-created schedule's payload.
  const saveConfig = useMutation({
    mutationFn: () => {
      const rebuilt = buildScheduledLaunchBody() as Record<string, unknown>
      // RFC-159 (edit-config, Codex P2): carry through StartTask fields the launch
      // form does NOT model (currently the per-task runtime / token caps) so editing
      // repo/inputs never silently clears an API-set limit. Keep the list in sync
      // with StartTaskSchema (packages/shared/src/schemas/task.ts).
      const original = (scheduleQ.data?.launchPayload ?? {}) as Record<string, unknown>
      for (const k of ['maxDurationMs', 'maxTotalTokens'] as const) {
        if (rebuilt[k] === undefined && original[k] !== undefined) rebuilt[k] = original[k]
      }
      return api.put(`/api/scheduled-tasks/${encodeURIComponent(editScheduled ?? '')}`, {
        launchPayload: rebuilt,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      void navigate({ to: '/scheduled/$id', params: { id: editScheduled ?? '' } })
    },
  })

  if (workflow.isLoading) return <div className="page muted">{t('editor.loadingWorkflow')}</div>
  if (workflow.error !== null && workflow.error !== undefined)
    return <div className="page error-box">{describeError(workflow.error)}</div>
  if (workflow.data === undefined) return null
  // RFC-159 (edit-config): block the form until the schedule loads so fields don't
  // flash empty then re-seed; surface a load error inline.
  if (isEdit && scheduleQ.isLoading) return <LoadingState />
  if (isEdit && scheduleQ.error !== null && scheduleQ.error !== undefined)
    return <div className="page error-box">{describeError(scheduleQ.error)}</div>

  const inputDefs = workflow.data.definition.inputs ?? []
  const missingRequired = inputDefs.some((def) => {
    if (def.kind === 'upload') {
      const list = uploads[def.key] ?? []
      const rec = def as Record<string, unknown>
      const minCount = typeof rec.minCount === 'number' ? rec.minCount : 0
      if (def.required === true && list.length === 0) return true
      if (list.length < minCount) return true
      return false
    }
    return def.required === true && (inputs[def.key] ?? '').trim() === ''
  })
  // RFC-066: every row must carry a parseable URL. The Start button stays
  // disabled until all rows pass their per-row gate.
  const sourceReady = repos.every((r) => validateRepoUrl(r.repoUrl) === null)
  // RFC-066: multi-repo + wrapper-git / upload combos are explicitly gated
  // BEFORE the Start button. Surface the reason in a banner so the user
  // knows what to fix; canSubmit folds the gate in.
  const hasWrapperGitNode = (workflow.data.definition.nodes ?? []).some(
    (n) => n.kind === 'wrapper-git',
  )
  const hasUploadInput = inputDefs.some((d) => d.kind === 'upload')
  const multiRepoBlockedReason: MultiRepoBlockedReason | null =
    repos.length > 1 ? (hasWrapperGitNode ? 'wrapper-git' : hasUploadInput ? 'upload' : null) : null
  // RFC-037: task name is required; mirror backend trim semantics here so the
  // Start button stays disabled for whitespace-only input.
  const nameReady = taskName.trim().length > 0
  // RFC-067: pair + format check for the optional Git identity. Mirrors
  // StartTaskSchema's superRefine so the user gets immediate feedback
  // instead of a 422 round-trip.
  const gitNameTrim = gitUserName.trim()
  const gitEmailTrim = gitUserEmail.trim()
  const gitBoth = gitNameTrim !== '' && gitEmailTrim !== ''
  const gitNeither = gitNameTrim === '' && gitEmailTrim === ''
  const gitPairingError = !gitBoth && !gitNeither
  const gitEmailFormatError = gitEmailTrim !== '' && !/^[^\s@]+@[^\s@]+$/.test(gitEmailTrim)
  const gitIdentityOk = gitNeither || (gitBoth && !gitEmailFormatError)
  // RFC-075: loose working-branch validation mirrors StartTaskSchema so the
  // user gets immediate feedback instead of a 422. Blank is always fine.
  const workingBranchTrim = workingBranch.trim()
  const workingBranchError = workingBranchTrim !== '' && !isLooseValidBranchName(workingBranchTrim)
  const workingBranchOk = !workingBranchError
  // RFC-159 (edit-config): the primary button is Save (PUT) in edit mode, Start
  // (POST) otherwise; gate on whichever mutation is in flight.
  const submitPending = isEdit ? saveConfig.isPending : start.isPending
  // RFC-159 (edit-config, Codex P2): when editing a schedule that has collaborators,
  // block Save until their id→UserPublic lookup SUCCEEDS. Otherwise a save fired
  // while the lookup is still pending (or after it failed) would rebuild the body
  // with an empty collaborator set and silently drop every collaborator. No ids →
  // nothing to wait for.
  const collabIds = scheduleQ.data?.launchPayload?.collaboratorUserIds ?? []
  const collabReady = !isEdit || collabIds.length === 0 || collabLookup.isSuccess
  const canSubmit =
    nameReady &&
    sourceReady &&
    !missingRequired &&
    gitIdentityOk &&
    workingBranchOk &&
    // RFC-066: multi-repo + wrapper-git / upload → Start disabled.
    multiRepoBlockedReason === null &&
    collabReady &&
    !submitPending

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>
            {isEdit
              ? t('scheduled.editConfigTitle', { name: workflow.data.name })
              : t('launch.title', { name: workflow.data.name })}
          </h1>
        </div>
        {isEdit ? (
          <Link
            to="/scheduled/$id"
            params={{ id: editScheduled ?? '' }}
            className="btn btn--sm"
            data-testid="launch-back-to-schedule"
          >
            {t('scheduled.backToSchedule')}
          </Link>
        ) : (
          <Link to="/workflows/$id" params={{ id }} className="btn btn--sm">
            {t('launch.backToEditor')}
          </Link>
        )}
      </header>

      <div className="form-grid">
        {/* RFC-037: task name is required at launch time — required input first. */}
        <Field label={t('launch.fieldTaskName')} required hint={t('launch.fieldTaskNameHint')}>
          <TextInput
            value={taskName}
            onChange={setTaskName}
            required
            maxLength={255}
            data-testid="launch-task-name"
          />
        </Field>

        {/* RFC-099 (D10): optional initial task users. Hidden in single-user
            (daemon-token) mode — UserPicker search needs real accounts. */}
        {actor.data !== null && actor.data !== undefined && actor.data.source !== 'daemon' && (
          <Field label={t('members.users')} hint={t('members.hint')}>
            <UserPicker
              value={collaborators}
              onChange={setCollaborators}
              excludeIds={[actor.data.user.id]}
              testidPrefix="launch-collaborators"
            />
          </Field>
        )}

        {/* RFC-067: optional per-task Git commit identity. Both blank → daemon
            default (legacy). Both filled → runner injects GIT_AUTHOR_* /
            GIT_COMMITTER_*. Half-filled is blocked client-side + server-side. */}
        <details className="launch-collapsible" data-testid="launch-git-identity">
          <summary>{t('launch.gitIdentity.toggle')}</summary>
          <div className="launch-collapsible__body">
            <Field label={t('launch.gitIdentity.name')} hint={t('launch.gitIdentity.hint')}>
              <TextInput
                value={gitUserName}
                onChange={setGitUserName}
                maxLength={255}
                data-testid="launch-git-user-name"
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
                data-testid="launch-git-user-email"
              />
            </Field>
            {gitPairingError && (
              <div className="error-text" role="alert" data-testid="launch-git-pair-error">
                {t('launch.gitIdentity.pairingError')}
              </div>
            )}
          </div>
        </details>

        <RepoSourceList
          repos={repos}
          onChange={setRepos}
          multiRepoBlockedReason={multiRepoBlockedReason}
        />

        {start.isPending && (
          <div className="muted" data-testid="launch-cloning-hint">
            {t('launch.repoSource.cloningHint')}
          </div>
        )}

        {/* RFC-075: working branch + auto commit&push — two independent Git
            options. Blank working branch → framework isolation branch; the
            toggle defaults off (legacy) and remembers the last choice. */}
        <Field
          label={t('launch.workingBranch.label')}
          hint={
            workingBranchError ? t('launch.workingBranch.invalid') : t('launch.workingBranch.hint')
          }
        >
          <TextInput
            value={workingBranch}
            onChange={setWorkingBranch}
            maxLength={255}
            placeholder={t('launch.workingBranch.placeholder')}
            data-testid="launch-working-branch"
          />
        </Field>
        {workingBranchError && (
          <div className="error-text" role="alert" data-testid="launch-working-branch-error">
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
        {inputDefs.length === 0 && <div className="muted">{t('launch.noInputs')}</div>}

        {inputDefs.map((def) => (
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
                t={t}
                repoPath={effectiveRepoPath}
                sourceKind={primarySource.kind}
                value={inputs[def.key] ?? ''}
                onChange={(v) => setInputs((prev) => ({ ...prev, [def.key]: v }))}
              />
            )}
          </Field>
        ))}
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => (isEdit ? saveConfig.mutate() : start.mutate())}
          disabled={!canSubmit}
          data-testid="launch-submit"
        >
          {isEdit
            ? saveConfig.isPending
              ? t('scheduled.saving')
              : t('scheduled.saveConfig')
            : start.isPending
              ? t('launch.starting')
              : t('launch.start')}
        </button>
        {/* RFC-159: "save as scheduled" only makes sense when creating a new task —
            in edit mode you're already editing an existing schedule. */}
        {!isEdit && (
          <button
            type="button"
            className="btn"
            onClick={() => setSaveScheduledOpen(true)}
            disabled={!canSubmit || scheduleUnsupported}
            title={scheduleUnsupported ? t('scheduled.uploadUnsupported') : undefined}
            data-testid="save-as-scheduled"
          >
            {t('scheduled.saveAsScheduled')}
          </button>
        )}
        {start.error !== null && start.error !== undefined && (
          <span className="form-actions__error">{describeError(start.error)}</span>
        )}
        {saveConfig.error !== null && saveConfig.error !== undefined && (
          <span className="form-actions__error" data-testid="launch-save-config-error">
            {describeError(saveConfig.error)}
          </span>
        )}
        {/* RFC-159 (edit-config, Codex P2): the collaborator lookup failed → Save is
            gated (collabReady=false) so we never drop collaborators; tell the user why. */}
        {isEdit && collabLookup.isError && (
          <span className="form-actions__error" data-testid="launch-collab-load-error">
            {t('scheduled.collabLoadError')}
          </span>
        )}
      </div>
      {!isEdit && (
        <ScheduleDialog
          open={saveScheduledOpen}
          onClose={() => setSaveScheduledOpen(false)}
          buildLaunchPayload={buildScheduledLaunchBody}
          defaultName={taskName.trim()}
        />
      )}
    </div>
  )
}

function DynamicInput({
  def,
  t,
  repoPath,
  sourceKind,
  value,
  onChange,
}: {
  def: WorkflowInput
  t: TFunction
  repoPath: string
  sourceKind: 'path' | 'url'
  value: string
  onChange: (next: string) => void
}) {
  if (def.kind === 'text') {
    const multiline = (def as Record<string, unknown>).multiline === true
    if (multiline) {
      return (
        <textarea
          className="form-input"
          rows={6}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={def.required === true}
        />
      )
    }
    return <TextInput value={value} onChange={onChange} required={def.required === true} />
  }
  if (def.kind === 'files') {
    return (
      <FilesPicker
        def={def}
        repoPath={repoPath}
        sourceKind={sourceKind}
        value={value}
        onChange={onChange}
      />
    )
  }
  if (def.kind === 'enum') {
    return <EnumPicker def={def} value={value} onChange={onChange} />
  }
  if (def.kind === 'git') {
    return (
      <GitPicker
        def={def}
        repoPath={repoPath}
        sourceKind={sourceKind}
        value={value}
        onChange={onChange}
      />
    )
  }
  return (
    <TextInput
      value={value}
      onChange={onChange}
      placeholder={t('launch.rawInputPlaceholder', { kind: def.kind })}
    />
  )
}

/**
 * RFC-004: the launcher form is driven solely by `definition.inputs[]`. The
 * input nodes on the canvas don't show up as form fields by themselves — they
 * route the value at task-run time into the graph. Exporting this trivial
 * accessor pins the contract so a future refactor can't quietly switch the
 * launcher to "scan input nodes" and bypass the inputs[] declaration.
 */
export function launcherFieldDefs(
  def:
    | {
        inputs?: WorkflowInput[]
      }
    | undefined,
): WorkflowInput[] {
  return def?.inputs ?? []
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

// RFC-075: remember the auto commit&push toggle across reloads. Kept in
// localStorage (not user settings) — it's a per-machine launch convenience,
// mirroring RFC-068's fetch-before-launch preference.
//
// Default ON (2026-07): a fresh launcher (no stored preference) starts with the
// toggle enabled; only an explicit opt-out — persisted as '0' when the user
// unchecks it — keeps it off across reloads. Stored '1' (or unset) reads as on.
export const AUTO_COMMIT_PUSH_LS_KEY = 'agent-workflow.launcher.autoCommitPush'
export function loadAutoCommitPushPref(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(AUTO_COMMIT_PUSH_LS_KEY) !== '0'
  } catch {
    return true
  }
}
export function saveAutoCommitPushPref(v: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(AUTO_COMMIT_PUSH_LS_KEY, v ? '1' : '0')
  } catch {
    /* noop */
  }
}
