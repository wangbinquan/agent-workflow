// RFC-066 PR-C — per-repo row inside the launch form. Carved out of
// `RepoSourceTabs.tsx` so the new `<RepoSourceList>` container can stamp
// N rows side-by-side with `+ Add repository` / `− Remove` controls.
//
// The body markup, a11y attributes, and field wiring are byte-baseline
// against pre-RFC-066 — `<RepoSourceTabs>` continues to call this with
// `showRemove=false, previewDirName=null` for single-repo callers, so
// existing fixtures (launch-repo-source.test.ts, repo-source-tabs-field-
// parity.test.ts, tabs-retrofit-grep.test.ts) keep matching without
// modification.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { CachedRepo, RecentRepo, RepoRefsResponse } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, Switch, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { validateRepoUrl, type RepoSource } from '@/lib/launch-repo-source'

// RFC-068: persist the user's "fetch before launch" preference so it survives
// page reloads. Keyed locally (not in user settings) since remote access
// reachability varies per repo.
export const FETCH_BEFORE_LAUNCH_LS_KEY = 'agent-workflow.launcher.pathFetch'
export function loadFetchBeforeLaunchPref(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(FETCH_BEFORE_LAUNCH_LS_KEY) === '1'
  } catch {
    return false
  }
}
export function saveFetchBeforeLaunchPref(v: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(FETCH_BEFORE_LAUNCH_LS_KEY, v ? '1' : '0')
  } catch {
    /* noop */
  }
}

export interface RepoSourceRowProps {
  source: RepoSource
  onChange: (next: RepoSource) => void
  /** RFC-066: when true, render the "− Remove" button. Always false in
   *  single-row mode (the only row cannot be removed). */
  showRemove?: boolean
  onRemove?: () => void
  /**
   * RFC-066: when set, render a small "Will mount as <name>/" preview chip
   * so the user can see how the basename + auto-suffix collision rules
   * will name this repo's sub-worktree inside the parent multi-repo dir.
   * Null in single-repo mode (the worktree IS the repo, no parent dir).
   */
  previewDirName?: string | null
  /** RFC-066: zero-based position; used for stable test selectors only. */
  index?: number
}

export function RepoSourceRow({
  source,
  onChange,
  showRemove,
  onRemove,
  previewDirName,
  index,
}: RepoSourceRowProps) {
  const { t } = useTranslation()
  const recent = useQuery<RecentRepo[]>({
    queryKey: ['repos', 'recent'],
    queryFn: ({ signal }) => api.get('/api/repos/recent', undefined, signal),
    enabled: source.kind === 'path',
  })
  const refs = useQuery<RepoRefsResponse>({
    queryKey: ['repos', 'refs', source.kind === 'path' ? source.repoPath : ''],
    queryFn: ({ signal }) =>
      api.get('/api/repos/refs', { path: source.kind === 'path' ? source.repoPath : '' }, signal),
    enabled: source.kind === 'path' && source.repoPath !== '',
  })
  const cached = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
    enabled: source.kind === 'url',
  })

  const switchTo = (kind: 'path' | 'url') => {
    if (kind === source.kind) return
    if (kind === 'path') {
      onChange({
        kind: 'path',
        repoPath: '',
        baseBranch: '',
        fetchBeforeLaunch: loadFetchBeforeLaunchPref(),
      })
    } else {
      onChange({ kind: 'url', repoUrl: '', ref: '' })
    }
  }

  const idxSuffix = typeof index === 'number' ? `-${index}` : ''

  return (
    <div className="repo-source-row" data-testid={`repo-source-row${idxSuffix}`}>
      <div className="repo-source-row__header">
        <div className="tabs tabs--segment" role="tablist" aria-label={t('launch.repoSource.bar')}>
          <button
            type="button"
            role="tab"
            aria-selected={source.kind === 'path'}
            data-testid={`repo-source-tab-path${idxSuffix}`}
            className={`tabs__tab ${source.kind === 'path' ? 'tabs__tab--active' : ''}`}
            onClick={() => switchTo('path')}
          >
            {t('launch.repoSource.path')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source.kind === 'url'}
            data-testid={`repo-source-tab-url${idxSuffix}`}
            className={`tabs__tab ${source.kind === 'url' ? 'tabs__tab--active' : ''}`}
            onClick={() => switchTo('url')}
          >
            {t('launch.repoSource.url')}
          </button>
        </div>
        {showRemove === true && (
          <button
            type="button"
            className="btn btn--sm btn--danger repo-source-row__remove"
            data-testid={`repo-source-remove${idxSuffix}`}
            onClick={onRemove}
            aria-label={t('launch.repoSource.remove')}
          >
            {t('launch.repoSource.remove')}
          </button>
        )}
      </div>

      {previewDirName !== null && previewDirName !== undefined && previewDirName.length > 0 && (
        <div
          className="repo-source-row__preview muted"
          data-testid={`repo-source-preview${idxSuffix}`}
        >
          {t('launch.repoSource.previewDirName', { name: previewDirName })}
        </div>
      )}

      {source.kind === 'path' ? (
        <>
          <Field label={t('launch.fieldRepo')} required hint={t('launch.fieldRepoHint')}>
            <Select<string>
              data-testid={`repo-source-path-select${idxSuffix}`}
              ariaLabel={t('launch.fieldRepo')}
              placeholder={t('launch.pickRepoPlaceholder')}
              value={source.repoPath}
              onChange={(repoPath) =>
                onChange({
                  kind: 'path',
                  repoPath,
                  baseBranch:
                    (recent.data ?? []).find((r) => r.path === repoPath)?.defaultBranch ??
                    source.baseBranch,
                  ...(source.fetchBeforeLaunch !== undefined
                    ? { fetchBeforeLaunch: source.fetchBeforeLaunch }
                    : {}),
                })
              }
              options={[
                { value: '', label: t('launch.pickRepoPlaceholder') },
                ...(recent.data ?? []).map((r) => ({
                  value: r.path,
                  label: r.defaultBranch ? `${r.path} (${r.defaultBranch})` : r.path,
                })),
              ]}
            />
            <TextInput
              value={source.repoPath}
              onChange={(v) => onChange({ ...source, repoPath: v })}
              placeholder={t('launch.pasteRepoPath')}
            />
          </Field>
          <Field label={t('launch.fieldBaseBranch')} required hint={t('launch.baseBranchHint')}>
            {refs.data !== undefined ? (
              <Select<string>
                data-testid={`repo-source-base-branch${idxSuffix}`}
                ariaLabel={t('launch.fieldBaseBranch')}
                placeholder={t('launch.pickBranchPlaceholder')}
                value={source.baseBranch}
                onChange={(baseBranch) => onChange({ ...source, baseBranch })}
                options={[
                  { value: '', label: t('launch.pickBranchPlaceholder') },
                  ...refs.data.branches.map((b) => ({ value: b, label: b })),
                ]}
              />
            ) : (
              <TextInput
                value={source.baseBranch}
                onChange={(v) => onChange({ ...source, baseBranch: v })}
                placeholder={t('launch.baseBranchPlaceholder')}
                data-testid={`repo-source-base-branch${idxSuffix}`}
              />
            )}
          </Field>
          {/* RFC-068: opt-in fetch BEFORE launch, never pull/merge. */}
          <Field label={t('launch.pathFetch.label')}>
            <Switch
              checked={source.fetchBeforeLaunch === true}
              onChange={(v) => {
                saveFetchBeforeLaunchPref(v)
                onChange({ ...source, fetchBeforeLaunch: v })
              }}
              label={t('launch.pathFetch.switchLabel')}
              hint={t('launch.pathFetch.switchHint')}
            />
          </Field>
        </>
      ) : (
        <>
          <Field
            label={t('launch.repoSource.urlField')}
            required
            hint={t('launch.repoSource.urlHint')}
          >
            {cached.data !== undefined && cached.data.items.length > 0 && (
              <Select<string>
                data-testid={`repo-source-recent-urls${idxSuffix}`}
                ariaLabel={t('launch.repoSource.recentUrlsPlaceholder')}
                placeholder={t('launch.repoSource.recentUrlsPlaceholder')}
                value={
                  cached.data.items.some((it) => it.url === source.repoUrl) ? source.repoUrl : ''
                }
                onChange={(url) => {
                  if (url !== '') {
                    onChange({ kind: 'url', repoUrl: url, ref: source.ref })
                  }
                }}
                options={[
                  { value: '', label: t('launch.repoSource.recentUrlsPlaceholder') },
                  ...cached.data.items.map((it) => ({ value: it.url, label: it.urlRedacted })),
                ]}
              />
            )}
            <TextInput
              value={source.repoUrl}
              onChange={(v) => onChange({ ...source, repoUrl: v })}
              placeholder={t('launch.repoSource.urlPlaceholder')}
            />
            {validateRepoUrl(source.repoUrl) === 'invalid' && (
              <div className="form-input__error" data-testid={`repo-source-url-error${idxSuffix}`}>
                {t('launch.repoSource.urlInvalid')}
              </div>
            )}
          </Field>
          <Field label={t('launch.repoSource.refField')} hint={t('launch.repoSource.refHint')}>
            <TextInput
              value={source.ref}
              onChange={(v) => onChange({ ...source, ref: v })}
              placeholder={t('launch.repoSource.refPlaceholder')}
            />
          </Field>
          {/* RFC-068: in URL mode FF is always automatic — make that visible. */}
          <div className="form-field__hint" data-testid={`repo-source-url-auto-sync${idxSuffix}`}>
            {t('launch.repoSource.urlAutoSync')}
          </div>
        </>
      )}
    </div>
  )
}
