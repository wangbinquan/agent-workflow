// Multi-file picker for kind=files inputs (P-2-10 stage 2).
//
// Backing endpoint: /api/repos/files?path=<repoPath> returns the full
// `git ls-files` listing. We filter client-side by a substring filter so
// users can navigate medium-sized repos without paginating.

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { RepoFilesResponse, WorkflowInput } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { TextInput } from '@/components/Form'

interface Props {
  def: WorkflowInput
  repoPath: string
  value: string
  onChange: (next: string) => void
}

/**
 * The packed value is a newline-joined list of repo-relative paths. The
 * runner reads it via promptTemplate `{{port}}` and downstream nodes can
 * split as needed.
 */
export function FilesPicker({ def, repoPath, value, onChange }: Props) {
  const [filter, setFilter] = useState('')
  const all = useQuery<RepoFilesResponse>({
    queryKey: ['repos', 'files', repoPath],
    queryFn: ({ signal }) => api.get('/api/repos/files', { path: repoPath }, signal),
    enabled: repoPath !== '',
  })

  const selected = useMemo(
    () =>
      new Set(
        value
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      ),
    [value],
  )

  const allowedKinds = (def as Record<string, unknown>).accept as
    | 'file'
    | 'dir'
    | 'both'
    | undefined
  const min = (def as Record<string, unknown>).minCount as number | undefined
  const max = (def as Record<string, unknown>).maxCount as number | undefined

  function toggle(path: string) {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else {
      if (max !== undefined && next.size >= max) return
      next.add(path)
    }
    onChange([...next].join('\n'))
  }

  const visible = useMemo(() => {
    const list = all.data?.files ?? []
    const f = filter.trim().toLowerCase()
    return f === '' ? list : list.filter((p) => p.toLowerCase().includes(f))
  }, [all.data, filter])

  if (repoPath === '') {
    return <div className="muted">Pick a repo first to load file paths.</div>
  }
  if (all.isLoading) return <div className="muted">Loading files…</div>
  if (all.error !== null && all.error !== undefined) {
    return <div className="error-box">{describeError(all.error)}</div>
  }

  return (
    <div className="files-picker">
      <div className="files-picker__filter">
        <TextInput value={filter} onChange={setFilter} placeholder="Filter paths…" />
        <span className="muted">
          {selected.size} selected{min !== undefined ? ` / min ${min}` : ''}
          {max !== undefined ? ` / max ${max}` : ''}
          {allowedKinds !== undefined ? ` · kind: ${allowedKinds}` : ''}
        </span>
      </div>
      <ul className="files-picker__list">
        {visible.slice(0, 500).map((p) => (
          <li key={p}>
            <label className="files-picker__row">
              <input type="checkbox" checked={selected.has(p)} onChange={() => toggle(p)} />
              <code>{p}</code>
            </label>
          </li>
        ))}
      </ul>
      {visible.length > 500 && (
        <div className="muted">…and {visible.length - 500} more. Tighten the filter.</div>
      )}
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
