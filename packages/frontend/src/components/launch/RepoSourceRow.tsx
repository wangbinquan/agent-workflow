// RFC-066 PR-C — per-repo row inside the launch form, stamped N times by
// `<RepoSourceList>` with `+ Add repository` / `− Remove` controls.
//
// RFC-165: URL-only. The local-path tab (recent-repos picker, refs lookup,
// fetch-before-launch switch) is retired with the path launch mode itself —
// tasks run in remote workspaces or scratch spaces; `file://` URLs are the
// escape hatch for local repos.

import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CachedRepo } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import type { RepoGroup } from '@agent-workflow/shared'
import { defaultRepoSource, validateRepoUrl, type RepoSource } from '@/lib/launch-repo-source'

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
  /**
   * RFC-248: 给了这个回调，下拉里就会**同时列出仓库组**（带 `（组·N 仓）`
   * 标签）。选中组时调用它——组不是 `RepoSource`，它把整个执行空间切成组空间，
   * 所以走独立通道而不是塞进 `onChange`。不给则完全维持旧行为（只列仓库）。
   */
  onSelectGroup?: (groupId: string) => void
  /** RFC-249: the selected group's compact layout stays inside this same row. */
  details?: ReactNode
  /** Keeps the shared selector selected while the parent space is a repo group. */
  selectedGroupId?: string
  /** Fail-closed switch for the repos:read-protected catalogs. */
  catalogEnabled?: boolean
  /** Caller-owned, already-authorized repository inventory. */
  catalogItems?: ReadonlyArray<{ id: string; label: string }>
  /** Select an existing repository only; no URL or ref editor. */
  catalogOnly?: boolean
  /** Read-only projection used for a pre-bound repository. */
  disabled?: boolean
  fieldLabel?: string
  fieldHint?: string
  fieldPlaceholder?: string
}

/** 下拉里区分「组条目」与「仓库条目」的值前缀（仓库值是裸 ULID）。 */
export const GROUP_OPTION_PREFIX = 'group:'
export const MANUAL_URL_OPTION = 'manual-url'

export function RepoSourceRow({
  source,
  onChange,
  onSelectGroup,
  details,
  selectedGroupId,
  showRemove,
  onRemove,
  previewDirName,
  index,
  catalogEnabled = true,
  catalogItems,
  catalogOnly = false,
  disabled = false,
  fieldLabel,
  fieldHint,
  fieldPlaceholder,
}: RepoSourceRowProps) {
  const { t } = useTranslation()
  // RFC-248: 仓库组与仓库同列在这一个下拉里——用户视角「就是从仓库列表里选
  // 一个」，组只是带标签的一类条目（D-决策原话）。选中组时空间整体切成组空间，
  // 所以这里只往上抛 id，不塞进 RepoSource。
  const groups = useQuery<{ items: RepoGroup[] }>({
    queryKey: ['repo-groups'],
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
    enabled: catalogEnabled && onSelectGroup !== undefined,
  })
  const cached = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
    enabled: catalogEnabled && catalogItems === undefined,
  })
  // `enabled:false` prevents new I/O but React Query may still expose a cache
  // populated by an earlier, more privileged authority snapshot. Shape the
  // read projection as well as the request.
  const cachedItems = catalogEnabled
    ? (catalogItems ??
      cached.data?.items.map((item) => ({ id: item.id, label: item.urlRedacted })) ??
      [])
    : []
  const groupItems = catalogEnabled ? (groups.data?.items ?? []) : []

  const idxSuffix = typeof index === 'number' ? `-${index}` : ''
  const groupSelected = selectedGroupId !== undefined && selectedGroupId !== ''
  const [manualUrl, setManualUrl] = useState(
    () => source.cachedRepoId === undefined && source.repoUrl.trim() !== '',
  )
  const manualUrlActive =
    !groupSelected &&
    (source.cachedRepoId === undefined || source.cachedRepoId === '') &&
    (manualUrl || source.repoUrl.trim() !== '')
  const showUrlInput = !catalogOnly && (onSelectGroup === undefined || manualUrlActive)
  const repositorySelected =
    !groupSelected &&
    (onSelectGroup === undefined ||
      (source.cachedRepoId !== undefined && source.cachedRepoId !== '') ||
      (manualUrlActive && source.repoUrl.trim() !== ''))
  const showSourcePicker = catalogOnly
    ? catalogEnabled && (catalogItems !== undefined || cached.data !== undefined)
    : onSelectGroup !== undefined
      ? catalogEnabled && (cached.data !== undefined || groups.data !== undefined)
      : cachedItems.length > 0

  return (
    <div className="repo-source-row" data-testid={`repo-source-row${idxSuffix}`}>
      {showRemove === true && !disabled && (
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

      <Field
        label={
          fieldLabel ??
          (onSelectGroup === undefined && !catalogOnly
            ? t('launch.repoSource.urlField')
            : t('launch.repoSource.spaceField'))
        }
        required
        hint={
          fieldHint ??
          (onSelectGroup === undefined && !catalogOnly
            ? t('launch.repoSource.urlHint')
            : t('launch.repoSource.spaceHint'))
        }
      >
        {showSourcePicker && (
          <Select<string>
            data-testid={`repo-source-recent-urls${idxSuffix}`}
            ariaLabel={
              onSelectGroup === undefined
                ? t('launch.repoSource.recentUrlsPlaceholder')
                : t('launch.repoSource.spacePlaceholder')
            }
            placeholder={
              fieldPlaceholder ??
              (onSelectGroup === undefined && !catalogOnly
                ? t('launch.repoSource.recentUrlsPlaceholder')
                : t('launch.repoSource.spacePlaceholder'))
            }
            value={
              groupSelected
                ? `${GROUP_OPTION_PREFIX}${selectedGroupId}`
                : manualUrlActive
                  ? MANUAL_URL_OPTION
                  : (source.cachedRepoId ?? '')
            }
            disabled={disabled}
            onChange={(id) => {
              if (id.startsWith(GROUP_OPTION_PREFIX)) {
                setManualUrl(false)
                onSelectGroup?.(id.slice(GROUP_OPTION_PREFIX.length))
                return
              }
              if (id === MANUAL_URL_OPTION) {
                setManualUrl(true)
                onChange(defaultRepoSource())
                return
              }
              if (id === '') {
                // The placeholder is the light-weight way back to the compact,
                // unselected state from either a group or manual URL mode.
                if (groupSelected || manualUrlActive) {
                  setManualUrl(false)
                  onChange(defaultRepoSource())
                }
                return
              }
              if (id !== '') {
                setManualUrl(false)
                // RFC-204: reuse by id — the credentialed URL is never sent to
                // the client, so we carry the id and show the redacted label.
                const hit = cachedItems.find((it) => it.id === id)
                onChange({
                  kind: 'url',
                  repoUrl: hit?.label ?? '',
                  cachedRepoId: id,
                  ref: source.ref,
                })
              }
            }}
            options={[
              {
                value: '',
                label:
                  fieldPlaceholder ??
                  (onSelectGroup === undefined && !catalogOnly
                    ? t('launch.repoSource.recentUrlsPlaceholder')
                    : t('launch.repoSource.spacePlaceholder')),
              },
              ...cachedItems.map((it) => ({
                value: it.id,
                label: it.label,
              })),
              ...(onSelectGroup !== undefined
                ? groupItems.map((g) => ({
                    value: `${GROUP_OPTION_PREFIX}${g.id}`,
                    label: t('launch.repoSource.groupOption', {
                      name: g.name,
                      count: g.flatRepoCount,
                    }),
                  }))
                : []),
              ...(onSelectGroup !== undefined && !catalogOnly
                ? [
                    {
                      value: MANUAL_URL_OPTION,
                      label: t('launch.repoSource.manualUrlOption'),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {!groupSelected && showUrlInput && (
          <>
            <TextInput
              value={source.repoUrl}
              onChange={(v) => onChange({ kind: 'url', repoUrl: v, ref: source.ref })}
              placeholder={t('launch.repoSource.urlPlaceholder')}
              data-testid={`repo-source-url${idxSuffix}`}
              disabled={disabled}
            />
            {validateRepoUrl(source.repoUrl) === 'invalid' && (
              <div className="form-input__error" data-testid={`repo-source-url-error${idxSuffix}`}>
                {t('launch.repoSource.urlInvalid')}
              </div>
            )}
          </>
        )}
      </Field>
      {repositorySelected && !catalogOnly && (
        <>
          <Field label={t('launch.repoSource.refField')} hint={t('launch.repoSource.refHint')}>
            <TextInput
              value={source.ref}
              onChange={(v) => onChange({ ...source, ref: v })}
              placeholder={t('launch.repoSource.refPlaceholder')}
              data-testid={`repo-source-ref${idxSuffix}`}
              disabled={disabled}
            />
          </Field>
          {/* RFC-068: FF sync is always automatic for remote workspaces — make that visible. */}
          <div className="form-field__hint" data-testid={`repo-source-url-auto-sync${idxSuffix}`}>
            {t('launch.repoSource.urlAutoSync')}
          </div>
        </>
      )}
      {groupSelected && details !== undefined && (
        <div className="repo-source-row__details">{details}</div>
      )}
    </div>
  )
}
