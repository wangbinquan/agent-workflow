// /workflows/$id/launch — minimal task starter.
//
// Stage 1 scope (P-2-10): recent-repo dropdown + base-branch dropdown
// (via /api/repos/refs) + auto-generated text inputs for each workflow.inputs
// entry. Multi-file / git-object / enum pickers ship later.

import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  RecentRepo,
  RepoRefsResponse,
  Task,
  Workflow,
  WorkflowInput,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { EnumPicker } from '@/components/launch/EnumPicker'
import { FilesPicker } from '@/components/launch/FilesPicker'
import { GitPicker } from '@/components/launch/GitPicker'
import { Field, TextInput } from '@/components/Form'
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

  const [repoPath, setRepoPath] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [inputs, setInputs] = useState<Record<string, string>>({})

  // Seed inputs map when workflow loads.
  useEffect(() => {
    if (workflow.data === undefined) return
    const seeded: Record<string, string> = {}
    for (const i of workflow.data.definition.inputs ?? []) {
      seeded[i.key] = inputs[i.key] ?? ''
    }
    setInputs(seeded)
    // Auto-pick the most recent repo as default.
    if (repoPath === '' && recent.data !== undefined && recent.data[0] !== undefined) {
      setRepoPath(recent.data[0].path)
      setBaseBranch(recent.data[0].defaultBranch ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.data, recent.data])

  const refs = useQuery<RepoRefsResponse>({
    queryKey: ['repos', 'refs', repoPath],
    queryFn: ({ signal }) => api.get('/api/repos/refs', { path: repoPath }, signal),
    enabled: repoPath !== '',
  })

  const start = useMutation({
    mutationFn: () =>
      api.post<Task>('/api/tasks', {
        workflowId: id,
        repoPath,
        baseBranch,
        inputs,
      }),
    onSuccess: (t) => navigate({ to: '/tasks/$id', params: { id: t.id } }),
  })

  if (workflow.isLoading) return <div className="page muted">{t('editor.loadingWorkflow')}</div>
  if (workflow.error !== null && workflow.error !== undefined)
    return <div className="page error-box">{describeError(workflow.error)}</div>
  if (workflow.data === undefined) return null

  const inputDefs = workflow.data.definition.inputs ?? []
  const missingRequired = inputDefs.some(
    (def) => def.required === true && (inputs[def.key] ?? '').trim() === '',
  )
  const canSubmit = repoPath !== '' && baseBranch !== '' && !missingRequired && !start.isPending

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

      <div className="form-grid">
        <Field label={t('launch.fieldRepo')} required hint={t('launch.fieldRepoHint')}>
          <select
            className="form-input"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
          >
            <option value="">{t('launch.pickRepoPlaceholder')}</option>
            {(recent.data ?? []).map((r) => (
              <option key={r.path} value={r.path}>
                {r.path} {r.defaultBranch ? `(${r.defaultBranch})` : ''}
              </option>
            ))}
          </select>
          <TextInput
            value={repoPath}
            onChange={setRepoPath}
            placeholder={t('launch.pasteRepoPath')}
          />
        </Field>

        <Field
          label={t('launch.fieldBaseBranch')}
          required
          hint={refs.error !== null ? describeError(refs.error) : t('launch.baseBranchHint')}
        >
          {refs.data !== undefined ? (
            <select
              className="form-input"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            >
              <option value="">{t('launch.pickBranchPlaceholder')}</option>
              {refs.data.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          ) : (
            <TextInput
              value={baseBranch}
              onChange={setBaseBranch}
              placeholder={t('launch.baseBranchPlaceholder')}
            />
          )}
        </Field>

        {inputDefs.length === 0 && <div className="muted">{t('launch.noInputs')}</div>}

        {inputDefs.map((def) => (
          <Field
            key={def.key}
            label={`${def.label} (${def.key})`}
            required={def.required === true}
            hint={def.description}
          >
            <DynamicInput
              def={def}
              repoPath={repoPath}
              value={inputs[def.key] ?? ''}
              onChange={(v) => setInputs((prev) => ({ ...prev, [def.key]: v }))}
            />
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
  repoPath,
  value,
  onChange,
}: {
  def: WorkflowInput
  repoPath: string
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
    return <FilesPicker def={def} repoPath={repoPath} value={value} onChange={onChange} />
  }
  if (def.kind === 'enum') {
    return <EnumPicker def={def} value={value} onChange={onChange} />
  }
  if (def.kind === 'git') {
    return <GitPicker def={def} repoPath={repoPath} value={value} onChange={onChange} />
  }
  return <TextInput value={value} onChange={onChange} placeholder={`raw ${def.kind} value`} />
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
