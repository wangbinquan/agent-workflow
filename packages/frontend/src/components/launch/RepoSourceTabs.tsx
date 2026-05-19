// RFC-024 — segmented "Local path" / "Remote URL" picker that sits where the
// single repoPath field used to live. Keeps the visual hierarchy small:
// header bar + just the active mode's controls below.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { CachedRepo, RecentRepo, RepoRefsResponse } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, TextInput } from '@/components/Form'
import { validateRepoUrl, type RepoSource } from '@/lib/launch-repo-source'

export interface RepoSourceTabsProps {
  source: RepoSource
  onChange: (next: RepoSource) => void
}

export function RepoSourceTabs({ source, onChange }: RepoSourceTabsProps) {
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
      onChange({ kind: 'path', repoPath: '', baseBranch: '' })
    } else {
      onChange({ kind: 'url', repoUrl: '', ref: '' })
    }
  }

  return (
    <div className="repo-source-tabs">
      <div className="tabs tabs--segment" role="tablist" aria-label={t('launch.repoSource.bar')}>
        <button
          type="button"
          role="tab"
          aria-selected={source.kind === 'path'}
          data-testid="repo-source-tab-path"
          className={`tabs__tab ${source.kind === 'path' ? 'tabs__tab--active' : ''}`}
          onClick={() => switchTo('path')}
        >
          {t('launch.repoSource.path')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={source.kind === 'url'}
          data-testid="repo-source-tab-url"
          className={`tabs__tab ${source.kind === 'url' ? 'tabs__tab--active' : ''}`}
          onClick={() => switchTo('url')}
        >
          {t('launch.repoSource.url')}
        </button>
      </div>

      {source.kind === 'path' ? (
        <>
          <Field label={t('launch.fieldRepo')} required hint={t('launch.fieldRepoHint')}>
            <select
              className="form-input"
              data-testid="repo-source-path-select"
              value={source.repoPath}
              onChange={(e) =>
                onChange({
                  kind: 'path',
                  repoPath: e.target.value,
                  baseBranch:
                    (recent.data ?? []).find((r) => r.path === e.target.value)?.defaultBranch ??
                    source.baseBranch,
                })
              }
            >
              <option value="">{t('launch.pickRepoPlaceholder')}</option>
              {(recent.data ?? []).map((r) => (
                <option key={r.path} value={r.path}>
                  {r.path} {r.defaultBranch ? `(${r.defaultBranch})` : ''}
                </option>
              ))}
            </select>
            <TextInput
              value={source.repoPath}
              onChange={(v) => onChange({ ...source, repoPath: v })}
              placeholder={t('launch.pasteRepoPath')}
            />
          </Field>
          <Field label={t('launch.fieldBaseBranch')} required hint={t('launch.baseBranchHint')}>
            {refs.data !== undefined ? (
              <select
                className="form-input"
                value={source.baseBranch}
                onChange={(e) => onChange({ ...source, baseBranch: e.target.value })}
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
                value={source.baseBranch}
                onChange={(v) => onChange({ ...source, baseBranch: v })}
                placeholder={t('launch.baseBranchPlaceholder')}
              />
            )}
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
              <select
                className="form-input"
                data-testid="repo-source-recent-urls"
                value={
                  cached.data.items.some((it) => it.url === source.repoUrl) ? source.repoUrl : ''
                }
                onChange={(e) => {
                  if (e.target.value !== '') {
                    onChange({ kind: 'url', repoUrl: e.target.value, ref: source.ref })
                  }
                }}
              >
                <option value="">{t('launch.repoSource.recentUrlsPlaceholder')}</option>
                {cached.data.items.map((it) => (
                  <option key={it.id} value={it.url}>
                    {it.urlRedacted}
                  </option>
                ))}
              </select>
            )}
            <TextInput
              value={source.repoUrl}
              onChange={(v) => onChange({ ...source, repoUrl: v })}
              placeholder={t('launch.repoSource.urlPlaceholder')}
            />
            {validateRepoUrl(source.repoUrl) === 'invalid' && (
              <div className="form-input__error" data-testid="repo-source-url-error">
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
        </>
      )}
    </div>
  )
}
