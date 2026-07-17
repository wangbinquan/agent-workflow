// Multi-file picker for kind=files inputs (P-2-10 stage 2).
//
// Backing endpoint: /api/repos/files?path=<repoPath> returns the full
// `git ls-files` listing. We filter client-side by a substring filter so
// users can navigate medium-sized repos without paginating.
//
// RFC-110: in URL launch mode the picker enumerates against the matched cached
// clone's localPath (passed in via repoPath by the launcher). When url mode has
// no cache (repoPath === '') or enumeration fails, it falls back to a free-text
// TextArea so the form stays launchable. Selected paths not in the current
// listing are surfaced as removable rows so a stale value can never submit
// silently (Codex RFC-110 design gate P2).

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoFilesResponse, WorkflowInput } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
import { TextArea, TextInput } from '@/components/Form'

interface Props {
  def: WorkflowInput
  repoPath: string
  value: string
  onChange: (next: string) => void
  /**
   * RFC-110: which repo-source mode the launcher is in. In 'url' mode an empty
   * repoPath (uncached URL) or an enumeration error falls back to a text input
   * instead of the path-mode "pick a repo first" / error-box behavior. Defaults
   * to 'path' so every existing caller stays byte-baseline.
   */
  sourceKind?: 'path' | 'url'
}

/**
 * The packed value is a newline-joined list of repo-relative paths. The
 * runner reads it via promptTemplate `{{port}}` and downstream nodes can
 * split as needed.
 */
export function FilesPicker({ def, repoPath, value, onChange, sourceKind = 'path' }: Props) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const urlMode = sourceKind === 'url'
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

  // RFC-110: selected paths NOT in the loaded listing (a stale value carried
  // over from another repo / branch). Surfaced as removable rows below so they
  // can never submit silently. Only meaningful once the listing has loaded.
  const extraSelected = useMemo(() => {
    const fileSet = new Set(all.data?.files ?? [])
    return [...selected].filter((p) => !fileSet.has(p))
  }, [all.data, selected])

  // RFC-110: render a set of selected paths as removable (checked) rows, reusing
  // the main list's row styling. Used both for stale paths not in the listing
  // and to keep the current selection visible while the cached listing loads.
  const selectedRows = (paths: string[], testid: string) => (
    <ul className="files-picker__list" data-testid={testid}>
      {paths.map((p) => (
        <li key={p}>
          <label className="files-picker__row">
            <input type="checkbox" checked onChange={() => toggle(p)} />
            <code>{p}</code>
          </label>
        </li>
      ))}
    </ul>
  )

  // RFC-110: url mode with no cache match OR a failed enumeration → free-text
  // fallback (newline-joined paths, same packed format as the checkbox UI).
  const fallback = (
    <div className="files-picker">
      <TextArea
        value={value}
        onChange={onChange}
        monospace
        data-testid="files-picker-url-fallback"
      />
      <div className="form-field__hint">{t('launch.filesPicker.urlFallbackHint')}</div>
    </div>
  )

  if (repoPath === '') {
    if (urlMode) return fallback
    return <div className="muted">{t('launch.filesPicker.pickRepoFirst')}</div>
  }
  if (all.isLoading) {
    // RFC-110: in url mode keep the current selection visible (removable) while
    // the cached listing loads, so a stale value is never hidden behind the
    // "Loading…" text yet still submittable (design §7 loading→hit visibility).
    if (urlMode && selected.size > 0) {
      return (
        <div className="files-picker">
          <div className="form-field__hint">{t('launch.filesPicker.loading')}</div>
          {selectedRows([...selected], 'files-picker-loading-selected')}
        </div>
      )
    }
    return <div className="muted">{t('launch.filesPicker.loading')}</div>
  }
  if (all.error !== null && all.error !== undefined) {
    if (urlMode) return fallback
    return <div className="error-box">{describeApiError(all.error)}</div>
  }

  return (
    <div className="files-picker">
      {urlMode && (
        <div className="form-field__hint" data-testid="files-picker-cache-hint">
          {t('launch.filesPicker.cacheSnapshotHint')}
        </div>
      )}
      <div className="files-picker__filter">
        <TextInput
          value={filter}
          onChange={setFilter}
          placeholder={t('launch.filesPicker.filterPlaceholder')}
        />
        <span className="muted">
          {t('launch.filesPicker.selectedCount', { n: selected.size })}
          {min !== undefined ? t('launch.filesPicker.minSuffix', { min }) : ''}
          {max !== undefined ? t('launch.filesPicker.maxSuffix', { max }) : ''}
          {allowedKinds !== undefined
            ? t('launch.filesPicker.kindSuffix', { kinds: allowedKinds })
            : ''}
        </span>
      </div>
      {extraSelected.length > 0 && (
        <>
          <div className="form-field__hint">{t('launch.filesPicker.extraSelectedHint')}</div>
          {selectedRows(extraSelected, 'files-picker-extra-selected')}
        </>
      )}
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
        <div className="muted">{t('launch.filesPicker.moreHint', { n: visible.length - 500 })}</div>
      )}
    </div>
  )
}
