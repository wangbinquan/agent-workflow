// /workflows/$id/launch — minimal task starter.
//
// Stage 1 scope (P-2-10): recent-repo dropdown + base-branch dropdown
// (via /api/repos/refs) + auto-generated text inputs for each workflow.inputs
// entry. Multi-file / git-object / enum pickers ship later.

import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  CachedRepo,
  UserPublic,
  RecentRepo,
  RepoRefsResponse,
  Task,
  Workflow,
  WorkflowInput,
} from '@agent-workflow/shared'
import { isLooseValidBranchName } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { useActor } from '@/hooks/useActor'
import { UserPicker } from '@/components/UserPicker'
import { EnumPicker } from '@/components/launch/EnumPicker'
import { FilesPicker } from '@/components/launch/FilesPicker'
import { GitPicker } from '@/components/launch/GitPicker'
import { UploadPicker } from '@/components/launch/UploadPicker'
import { buildLaunchFormData } from '@/components/launch/buildLaunchFormData'
import { RepoSourceList, type MultiRepoBlockedReason } from '@/components/launch/RepoSourceList'
import { Field, Switch, TextInput } from '@/components/Form'
import {
  buildLaunchBody,
  buildLaunchBodyMultiRepo,
  buildLaunchFormDataV2,
  defaultRepoSource,
  resolveUrlRepoPath,
  validateRepoUrl,
  type RepoSource,
} from '@/lib/launch-repo-source'
import { Route as RootRoute } from './__root'

export const LaunchRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows/$id/launch',
  component: LaunchPage,
})

function LaunchPage() {
  const { t } = useTranslation()
  const { id } = LaunchRoute.useParams()
  const navigate = useNavigate()
  const workflow = useQuery<Workflow>({
    queryKey: ['workflows', id],
    queryFn: ({ signal }) => api.get(`/api/workflows/${encodeURIComponent(id)}`, undefined, signal),
  })
  const recent = useQuery<RecentRepo[]>({
    queryKey: ['repos', 'recent'],
    queryFn: ({ signal }) => api.get('/api/repos/recent', undefined, signal),
  })

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
  // RFC-024 + RFC-066: 1..N repo sources. Single-row state is byte-baseline
  // against pre-RFC-066 (default = one empty path-mode row, recents
  // auto-fills the first row); the `+ Add` button in `<RepoSourceList>`
  // grows the array, the `−` button shrinks it.
  const [repos, setRepos] = useState<RepoSource[]>([defaultRepoSource()])
  const primarySource: RepoSource = repos[0] ?? defaultRepoSource()
  const [inputs, setInputs] = useState<Record<string, string>>({})
  // RFC-020: parallel state for `kind: 'upload'` inputs; key → picked Files.
  const [uploads, setUploads] = useState<Record<string, File[]>>({})

  // Seed inputs map when workflow loads.
  useEffect(() => {
    if (workflow.data === undefined) return
    const seeded: Record<string, string> = {}
    for (const i of workflow.data.definition.inputs ?? []) {
      seeded[i.key] = inputs[i.key] ?? ''
    }
    setInputs(seeded)
    // Auto-pick the most recent repo as default for the FIRST row only —
    // multi-repo mode (length > 1) leaves any added blank rows alone so
    // the user isn't surprised by recent-repo prefill.
    if (
      repos.length === 1 &&
      repos[0]!.kind === 'path' &&
      repos[0]!.repoPath === '' &&
      recent.data !== undefined &&
      recent.data[0] !== undefined
    ) {
      setRepos([
        {
          kind: 'path',
          repoPath: recent.data[0].path,
          baseBranch: recent.data[0].defaultBranch ?? '',
        },
      ])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.data, recent.data])

  const refs = useQuery<RepoRefsResponse>({
    queryKey: ['repos', 'refs', primarySource.kind === 'path' ? primarySource.repoPath : ''],
    queryFn: ({ signal }) =>
      api.get(
        '/api/repos/refs',
        { path: primarySource.kind === 'path' ? primarySource.repoPath : '' },
        signal,
      ),
    enabled: primarySource.kind === 'path' && primarySource.repoPath !== '',
  })

  // RFC-110: cached-repo list (shared queryKey with RepoSourceRow → React Query
  // dedups to one request) so url-mode file/git pickers can resolve the typed
  // URL to an already-cached clone's localPath and enumerate it. A query failure
  // simply yields no matches → pickers fall back to a text input, never blocking.
  const cachedRepos = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
    enabled: primarySource.kind === 'url',
  })
  // The local repoPath the file/git pickers enumerate against: the chosen local
  // path in path mode, or the matched cached clone in url mode ('' when uncached
  // → picker shows a text fallback).
  const effectiveRepoPath = resolveUrlRepoPath(primarySource, cachedRepos.data?.items ?? [])

  const hasUploads = Object.values(uploads).some((arr) => arr.length > 0)
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
        // RFC-125: all UI-launched tasks default to deferred question dispatch —
        // designer-scoped clarify answers park in the task board for manual batch-
        // dispatch (the launch-time on/off toggle was removed).
        deferredQuestionDispatch: true,
      }
      // RFC-066: multi-repo (length > 1) → always JSON post via the v2 body
      // helper. Multi-repo + uploads is gated by T6's `canSubmit` predicate
      // BEFORE reaching this branch; this path is unreachable when uploads
      // and multi-repo coexist. Single-repo (length === 1) keeps the
      // legacy byte-baseline branching against `primarySource`.
      if (repos.length > 1) {
        return api.post<Task>('/api/tasks', buildLaunchBodyMultiRepo(repos, launchCommon))
      }
      const onlySource = primarySource
      if (onlySource.kind === 'path' && (hasUploadKind || hasUploads)) {
        const payload = {
          ...launchCommon,
          repoPath: onlySource.repoPath,
          baseBranch: onlySource.baseBranch,
        }
        return api.postMultipart<Task>('/api/tasks', buildLaunchFormData(payload, uploads))
      }
      if (onlySource.kind === 'url' && (hasUploadKind || hasUploads)) {
        // RFC-107: URL + uploads is now supported. The multipart route resolves
        // the URL into the repo cache before materializing the worktree, then
        // lands the files; buildLaunchFormDataV2 carries repoUrl + ref.
        return api.postMultipart<Task>(
          '/api/tasks',
          buildLaunchFormDataV2(onlySource, launchCommon, uploads),
        )
      }
      return api.post<Task>('/api/tasks', buildLaunchBody(onlySource, launchCommon))
    },
    onSuccess: (t) => navigate({ to: '/tasks/$id', params: { id: t.id } }),
  })

  if (workflow.isLoading) return <div className="page muted">{t('editor.loadingWorkflow')}</div>
  if (workflow.error !== null && workflow.error !== undefined)
    return <div className="page error-box">{describeError(workflow.error)}</div>
  if (workflow.data === undefined) return null

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
  const repoIssue = primarySource.kind === 'path' ? repoLaunchIssue(refs.data ?? null) : null
  // RFC-066: every row must be filled (path mode requires repoPath +
  // baseBranch; url mode requires a parseable URL). The Start button stays
  // disabled until all rows pass their per-row gate.
  const sourceReady = repos.every((r) =>
    r.kind === 'path'
      ? r.repoPath !== '' && r.baseBranch !== ''
      : validateRepoUrl(r.repoUrl) === null,
  )
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
  const canSubmit =
    nameReady &&
    sourceReady &&
    !missingRequired &&
    repoIssue === null &&
    gitIdentityOk &&
    workingBranchOk &&
    // RFC-066: multi-repo + wrapper-git / upload → Start disabled.
    multiRepoBlockedReason === null &&
    !start.isPending

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('launch.title', { name: workflow.data.name })}</h1>
          <p className="page__hint">
            {t('launch.hintBefore')}
            <code>{t('launch.hintCode')}</code>
            {t('launch.hintAfter')}
          </p>
        </div>
        <Link to="/workflows/$id" params={{ id }} className="btn btn--sm">
          {t('launch.backToEditor')}
        </Link>
      </header>

      {repoIssue === 'no-commits' && <div className="error-box">{t('launch.repoNoCommits')}</div>}

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

        {primarySource.kind === 'url' && start.isPending && (
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
          onClick={() => start.mutate()}
          disabled={!canSubmit}
        >
          {start.isPending ? t('launch.starting') : t('launch.start')}
        </button>
        {start.error !== null && start.error !== undefined && (
          <span className="form-actions__error">{describeError(start.error)}</span>
        )}
      </div>
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

/**
 * Pre-launch validation of the chosen repo. Returns a stable issue code
 * the UI uses to render an inline banner AND disable Start.
 *
 * Today the only blocking case is `no-commits`: `git init -b main` alone
 * leaves the unborn `main` ref unresolvable, so `git worktree add` later
 * fails with `cannot resolve base ref 'main'`. We want to refuse the
 * launch up front rather than queue a doomed task.
 *
 * Returns `null` when refs haven't loaded yet OR the repo is launchable —
 * the caller folds the `null` case into its other gating predicates
 * (e.g. missingRequired, repoPath !== '').
 *
 * Exported for unit tests.
 */
export function repoLaunchIssue(refs: { hasCommits: boolean } | null): 'no-commits' | null {
  if (refs === null) return null
  if (refs.hasCommits === false) return 'no-commits'
  return null
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

// RFC-075: remember the auto commit&push toggle across reloads. Kept in
// localStorage (not user settings) — it's a per-machine launch convenience,
// mirroring RFC-068's fetch-before-launch preference.
export const AUTO_COMMIT_PUSH_LS_KEY = 'agent-workflow.launcher.autoCommitPush'
export function loadAutoCommitPushPref(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(AUTO_COMMIT_PUSH_LS_KEY) === '1'
  } catch {
    return false
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
