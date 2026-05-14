// /workflows/$id/launch — minimal task starter.
//
// Stage 1 scope (P-2-10): recent-repo dropdown + base-branch dropdown
// (via /api/repos/refs) + auto-generated text inputs for each workflow.inputs
// entry. Multi-file / git-object / enum pickers ship later.

import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type {
  RecentRepo,
  RepoRefsResponse,
  Task,
  Workflow,
  WorkflowInput,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { Field, TextInput } from '@/components/Form'
import { Route as RootRoute } from './__root'

export const LaunchRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows/$id/launch',
  component: LaunchPage,
})

function LaunchPage() {
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

  if (workflow.isLoading) return <div className="page muted">Loading workflow…</div>
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
          <h1>Launch: {workflow.data.name}</h1>
          <p className="page__hint">
            Pick a repo + base branch, fill the workflow inputs, then start. A worktree at{' '}
            <code>~/.agent-workflow/worktrees/&lt;repo&gt;/&lt;taskId&gt;</code> is created on
            submit.
          </p>
        </div>
        <Link to="/workflows/$id" params={{ id }} className="btn btn--sm">
          ← Back to editor
        </Link>
      </header>

      <div className="form-grid">
        <Field label="Repo" required hint="Pick from recent or paste an absolute path.">
          <select
            className="form-input"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
          >
            <option value="">— pick a repo —</option>
            {(recent.data ?? []).map((r) => (
              <option key={r.path} value={r.path}>
                {r.path} {r.defaultBranch ? `(${r.defaultBranch})` : ''}
              </option>
            ))}
          </select>
          <TextInput
            value={repoPath}
            onChange={setRepoPath}
            placeholder="or paste an absolute repo path"
          />
        </Field>

        <Field
          label="Base branch"
          required
          hint={refs.error !== null ? describeError(refs.error) : 'Used as the worktree origin'}
        >
          {refs.data !== undefined ? (
            <select
              className="form-input"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            >
              <option value="">— pick a branch —</option>
              {refs.data.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          ) : (
            <TextInput value={baseBranch} onChange={setBaseBranch} placeholder="main" />
          )}
        </Field>

        {inputDefs.length === 0 && <div className="muted">This workflow declares no inputs.</div>}

        {inputDefs.map((def) => (
          <Field
            key={def.key}
            label={`${def.label} (${def.key})`}
            required={def.required === true}
            hint={def.description}
          >
            <DynamicInput
              def={def}
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
          {start.isPending ? 'Starting…' : 'Start task'}
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
  value,
  onChange,
}: {
  def: WorkflowInput
  value: string
  onChange: (next: string) => void
}) {
  // Stage 1: text only. P-2-10 stage 2 adds files / enum / git pickers.
  if (def.kind === 'text') {
    // Treat multiline as a hint surfaced via the `multiline` passthrough key.
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
  return (
    <div>
      <TextInput value={value} onChange={onChange} placeholder={`raw ${def.kind} value`} />
      <div className="form-field__hint">
        Stage-2 picker for <code>{def.kind}</code> ships in a follow-up; for now, paste a JSON
        string.
      </div>
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
