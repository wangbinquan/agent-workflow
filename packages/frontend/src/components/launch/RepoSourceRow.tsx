// RFC-066 PR-C — per-repo row inside the launch form, stamped N times by
// `<RepoSourceList>` with `+ Add repository` / `− Remove` controls.
//
// RFC-165: URL-only. The local-path tab (recent-repos picker, refs lookup,
// fetch-before-launch switch) is retired with the path launch mode itself —
// tasks run in remote workspaces or scratch spaces; `file://` URLs are the
// escape hatch for local repos.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { CachedRepo } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { validateRepoUrl, type RepoSource } from '@/lib/launch-repo-source'

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
  const cached = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })

  const idxSuffix = typeof index === 'number' ? `-${index}` : ''

  return (
    <div className="repo-source-row" data-testid={`repo-source-row${idxSuffix}`}>
      {showRemove === true && (
        <div className="repo-source-row__header">
          <button
            type="button"
            className="btn btn--sm btn--danger repo-source-row__remove"
            data-testid={`repo-source-remove${idxSuffix}`}
            onClick={onRemove}
            aria-label={t('launch.repoSource.remove')}
          >
            {t('launch.repoSource.remove')}
          </button>
        </div>
      )}

      {previewDirName !== null && previewDirName !== undefined && previewDirName.length > 0 && (
        <div
          className="repo-source-row__preview muted"
          data-testid={`repo-source-preview${idxSuffix}`}
        >
          {t('launch.repoSource.previewDirName', { name: previewDirName })}
        </div>
      )}

      <Field label={t('launch.repoSource.urlField')} required hint={t('launch.repoSource.urlHint')}>
        {cached.data !== undefined && cached.data.items.length > 0 && (
          <Select<string>
            data-testid={`repo-source-recent-urls${idxSuffix}`}
            ariaLabel={t('launch.repoSource.recentUrlsPlaceholder')}
            placeholder={t('launch.repoSource.recentUrlsPlaceholder')}
            value={cached.data.items.some((it) => it.url === source.repoUrl) ? source.repoUrl : ''}
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
          data-testid={`repo-source-url${idxSuffix}`}
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
          data-testid={`repo-source-ref${idxSuffix}`}
        />
      </Field>
      {/* RFC-068: FF sync is always automatic for remote workspaces — make that visible. */}
      <div className="form-field__hint" data-testid={`repo-source-url-auto-sync${idxSuffix}`}>
        {t('launch.repoSource.urlAutoSync')}
      </div>
    </div>
  )
}
