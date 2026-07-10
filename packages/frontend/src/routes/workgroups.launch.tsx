// RFC-164 PR-4 — /workgroups/launch?name=<group>: start a workgroup task.
//
// A slimmed-down sibling of /workflows/$id/launch: task name + goal (the
// group's mission statement) are the two required fields; the repo source
// picker, collaborator picker, git identity, working-branch/auto-push and
// limit fields all reuse the workflow launcher's pieces. The outgoing body is
// composed by lib/workgroup-launch's buildWorkgroupLaunchBody (field-by-field
// tested — 防 RFC-125 型静默丢字段), and the endpoint's three 422 codes map to
// friendly copy via workgroupLaunchErrorMessage.

import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Task, UserPublic, Workgroup } from '@agent-workflow/shared'
import { isLooseValidBranchName, workgroupLaunchReadiness } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, NumberInput, TextArea, TextInput, Switch } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { RepoSourceList } from '@/components/launch/RepoSourceList'
import { UserPicker } from '@/components/UserPicker'
import { useActor } from '@/hooks/useActor'
import { describeApiError } from '@/i18n'
import { defaultRepoSource, validateRepoUrl, type RepoSource } from '@/lib/launch-repo-source'
import { buildWorkgroupLaunchBody, workgroupLaunchErrorMessage } from '@/lib/workgroup-launch'
import { loadAutoCommitPushPref, saveAutoCommitPushPref } from '@/routes/workflows.launch'
import { Route as RootRoute } from './__root'

interface WorkgroupLaunchSearch {
  /** Workgroup name (the resource key — /api/workgroups/:name). */
  name: string
}

export const LaunchRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups/launch',
  component: WorkgroupLaunchPage,
  validateSearch: (raw: Record<string, unknown>): WorkgroupLaunchSearch => ({
    name: typeof raw.name === 'string' ? raw.name : '',
  }),
})

function WorkgroupLaunchPage() {
  const { t } = useTranslation()
  const { name } = LaunchRoute.useSearch()
  const navigate = useNavigate()

  const group = useQuery<Workgroup>({
    queryKey: ['workgroups', name],
    queryFn: ({ signal }) =>
      api.get(`/api/workgroups/${encodeURIComponent(name)}`, undefined, signal),
    enabled: name !== '',
  })
  const [taskName, setTaskName] = useState('')
  const [goal, setGoal] = useState('')
  const [collaborators, setCollaborators] = useState<UserPublic[]>([])
  const actor = useActor()
  const [repos, setRepos] = useState<RepoSource[]>([defaultRepoSource()])
  // Advanced fold — same semantics as the workflow launcher.
  const [workingBranch, setWorkingBranch] = useState('')
  const [autoCommitPush, setAutoCommitPush] = useState(loadAutoCommitPushPref())
  const [gitUserName, setGitUserName] = useState('')
  const [gitUserEmail, setGitUserEmail] = useState('')
  // Limits (RFC-164 launch body): minutes in the UI → ms on the wire.
  const [maxDurationMin, setMaxDurationMin] = useState<number | undefined>(undefined)
  const [maxTotalTokens, setMaxTotalTokens] = useState<number | undefined>(undefined)

  const start = useMutation({
    mutationFn: () => {
      const trimGitName = gitUserName.trim()
      const trimGitEmail = gitUserEmail.trim()
      const trimWorkingBranch = workingBranch.trim()
      const body = buildWorkgroupLaunchBody(repos, {
        name: taskName.trim(),
        goal: goal.trim(),
        ...(collaborators.length > 0
          ? { collaboratorUserIds: collaborators.map((u) => u.id) }
          : {}),
        ...(trimGitName !== '' && trimGitEmail !== ''
          ? { gitUserName: trimGitName, gitUserEmail: trimGitEmail }
          : {}),
        ...(trimWorkingBranch !== '' ? { workingBranch: trimWorkingBranch } : {}),
        ...(autoCommitPush ? { autoCommitPush: true } : {}),
        ...(maxDurationMin !== undefined && maxDurationMin > 0
          ? { maxDurationMs: Math.round(maxDurationMin * 60_000) }
          : {}),
        ...(maxTotalTokens !== undefined && maxTotalTokens > 0 ? { maxTotalTokens } : {}),
      })
      return api.post<Task>(`/api/workgroups/${encodeURIComponent(name)}/tasks`, body)
    },
    onSuccess: (tk) => navigate({ to: '/tasks/$id', params: { id: tk.id } }),
  })

  if (name === '') {
    return <div className="page error-box">{t('workgroups.launch.missingGroup')}</div>
  }
  if (group.isLoading)
    return (
      <div className="page">
        <LoadingState />
      </div>
    )
  if (group.error !== null && group.error !== undefined)
    return <div className="page error-box">{describeApiError(group.error)}</div>
  if (group.data === undefined) return null

  // Client-side mirror of the launch endpoint's readiness gate (shared
  // oracle) — the 422 mapping below stays as the net for races.
  const readiness = workgroupLaunchReadiness(group.data)

  const nameReady = taskName.trim().length > 0
  const goalReady = goal.trim().length > 0
  const sourceReady = repos.every((r) => validateRepoUrl(r.repoUrl) === null)
  const gitNameTrim = gitUserName.trim()
  const gitEmailTrim = gitUserEmail.trim()
  const gitBoth = gitNameTrim !== '' && gitEmailTrim !== ''
  const gitNeither = gitNameTrim === '' && gitEmailTrim === ''
  const gitPairingError = !gitBoth && !gitNeither
  const gitEmailFormatError = gitEmailTrim !== '' && !/^[^\s@]+@[^\s@]+$/.test(gitEmailTrim)
  const gitIdentityOk = gitNeither || (gitBoth && !gitEmailFormatError)
  const workingBranchTrim = workingBranch.trim()
  const workingBranchError = workingBranchTrim !== '' && !isLooseValidBranchName(workingBranchTrim)
  const canSubmit =
    readiness.ready &&
    nameReady &&
    goalReady &&
    sourceReady &&
    gitIdentityOk &&
    !workingBranchError &&
    !start.isPending

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('workgroups.launch.title', { name })}</h1>
        </div>
        <Link
          to="/workgroups/$name"
          params={{ name }}
          className="btn btn--sm"
          data-testid="workgroup-launch-back"
        >
          {t('workgroups.launch.backToGroup')}
        </Link>
      </header>

      {!readiness.ready && (
        <div
          className="info-box info-box--muted workgroup-readiness"
          role="status"
          data-testid="workgroup-launch-readiness-banner"
        >
          {readiness.reasons.map((reason) => (
            <span key={reason}>
              {reason === 'no-agent-member'
                ? t('workgroups.readiness.noAgentMember')
                : t('workgroups.readiness.leaderMissing')}
            </span>
          ))}
        </div>
      )}
      <div className="form-grid">
        <Field label={t('launch.fieldTaskName')} required hint={t('launch.fieldTaskNameHint')}>
          <TextInput
            value={taskName}
            onChange={setTaskName}
            required
            maxLength={255}
            data-testid="workgroup-launch-task-name"
          />
        </Field>

        <Field
          label={t('workgroups.launch.fieldGoal')}
          required
          hint={t('workgroups.launch.fieldGoalHint')}
        >
          <TextArea
            value={goal}
            onChange={setGoal}
            rows={6}
            maxLength={65536}
            data-testid="workgroup-launch-goal"
          />
        </Field>

        {actor.data !== null && actor.data !== undefined && actor.data.source !== 'daemon' && (
          <Field label={t('members.users')} hint={t('members.hint')}>
            <UserPicker
              value={collaborators}
              onChange={setCollaborators}
              excludeIds={[actor.data.user.id]}
              testidPrefix="workgroup-launch-collaborators"
            />
          </Field>
        )}

        <RepoSourceList repos={repos} onChange={setRepos} multiRepoBlockedReason={null} />

        {/* Advanced fold: working branch / auto commit&push / git identity / limits. */}
        <details className="launch-collapsible" data-testid="workgroup-launch-advanced">
          <summary>{t('workgroups.launch.advanced')}</summary>
          <div className="launch-collapsible__body">
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
                data-testid="workgroup-launch-working-branch"
              />
            </Field>
            {workingBranchError && (
              <div className="error-text" role="alert" data-testid="workgroup-launch-branch-error">
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
            <Field label={t('launch.gitIdentity.name')} hint={t('launch.gitIdentity.hint')}>
              <TextInput
                value={gitUserName}
                onChange={setGitUserName}
                maxLength={255}
                data-testid="workgroup-launch-git-user-name"
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
                data-testid="workgroup-launch-git-user-email"
              />
            </Field>
            {gitPairingError && (
              <div
                className="error-text"
                role="alert"
                data-testid="workgroup-launch-git-pair-error"
              >
                {t('launch.gitIdentity.pairingError')}
              </div>
            )}
            <Field
              label={t('workgroups.launch.maxDurationMin')}
              hint={t('workgroups.launch.maxDurationMinHint')}
            >
              <NumberInput
                value={maxDurationMin}
                onChange={setMaxDurationMin}
                min={1}
                step={1}
                data-testid="workgroup-launch-max-duration"
              />
            </Field>
            <Field
              label={t('workgroups.launch.maxTotalTokens')}
              hint={t('workgroups.launch.maxTotalTokensHint')}
            >
              <NumberInput
                value={maxTotalTokens}
                onChange={setMaxTotalTokens}
                min={1}
                step={1}
                data-testid="workgroup-launch-max-tokens"
              />
            </Field>
          </div>
        </details>
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => start.mutate()}
          disabled={!canSubmit}
          data-testid="workgroup-launch-submit"
        >
          {start.isPending ? t('launch.starting') : t('workgroups.launch.start')}
        </button>
        {start.error !== null && start.error !== undefined && (
          <span className="form-actions__error" data-testid="workgroup-launch-error">
            {workgroupLaunchErrorMessage(start.error, t)}
          </span>
        )}
      </div>
    </div>
  )
}
