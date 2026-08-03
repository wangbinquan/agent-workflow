// RFC-066 PR-C — multi-repo launcher container. Renders 1..N `RepoSourceRow`
// rows side-by-side with `+ Add repository` / `− Remove` controls and an
// optional banner when the workflow shape forbids multi-repo (wrapper-git
// nodes, multipart upload inputs).
//
// Single-row mode (length 1) is byte-baseline visual against pre-RFC-066:
//   - no `−` button on the lone row
//   - no preview chip
//   - `+ Add` button still visible (clicking it transitions to multi-row)
//
// Multi-row mode (length > 1):
//   - every row gets the `−` button
//   - every row gets a "Will mount as <basename>/" preview chip
//   - `+ Add` disables at MULTI_REPO_MAX
//   - optional banner explains why Start is disabled (wrapper-git / upload)

import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { MULTI_REPO_MAX } from '@agent-workflow/shared'
import { RepoSourceRow } from '@/components/launch/RepoSourceRow'
import {
  computePreviewDirNames,
  defaultRepoSource,
  type RepoSource,
} from '@/lib/launch-repo-source'

export type MultiRepoBlockedReason = 'wrapper-git' | 'upload'

export interface RepoSourceListProps {
  repos: RepoSource[]
  onChange: (next: RepoSource[]) => void
  /**
   * RFC-066: when the active workflow's shape forbids multi-repo, this
   * carries the reason code so the banner can render the right localized
   * explanation. `null` means no gate fired (or repos.length === 1).
   */
  multiRepoBlockedReason?: MultiRepoBlockedReason | null
  /** Override for tests; defaults to MULTI_REPO_MAX (8). */
  maxCount?: number
  /** RFC-248: 透传给每一行——给了就在下拉里同列仓库组。 */
  onSelectGroup?: (groupId: string) => void
  /** RFC-249: selected group remains represented by the first shared row. */
  selectedGroupId?: string
  selectedGroupDetails?: ReactNode
}

export function RepoSourceList({
  repos,
  onChange,
  multiRepoBlockedReason,
  maxCount,
  onSelectGroup,
  selectedGroupId,
  selectedGroupDetails,
}: RepoSourceListProps) {
  const { t } = useTranslation()
  const max = maxCount ?? MULTI_REPO_MAX
  const previewNames = computePreviewDirNames(repos)
  const isMulti = repos.length > 1

  const updateAt = (i: number, next: RepoSource) => {
    onChange(repos.map((r, j) => (j === i ? next : r)))
  }
  const removeAt = (i: number) => {
    onChange(repos.filter((_, j) => j !== i))
  }
  const addRow = () => {
    if (repos.length >= max) return
    onChange([...repos, defaultRepoSource()])
  }

  return (
    <div className="repo-source-list" data-testid="repo-source-list">
      {repos.map((src, i) => (
        <RepoSourceRow
          key={i}
          source={src}
          index={i}
          onChange={(next) => updateAt(i, next)}
          showRemove={isMulti}
          onRemove={() => removeAt(i)}
          previewDirName={isMulti ? (previewNames[i] ?? null) : null}
          {...(onSelectGroup !== undefined && i === 0 ? { onSelectGroup } : {})}
          {...(selectedGroupId !== undefined && i === 0
            ? { selectedGroupId, details: selectedGroupDetails }
            : {})}
        />
      ))}
      {/* RFC-248: 只在还允许多行时渲染「+ 添加仓库」。组模式（onSelectGroup
          已给）下多仓只能由仓库组表达——留着加行按钮会让用户拼出一个
          builder 只取首行的空间，那是静默降级。 */}
      {max > 1 && (
        <div className="repo-source-list__actions">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="repo-source-add"
            disabled={repos.length >= max}
            onClick={addRow}
            aria-label={t('launch.repoSource.add')}
          >
            {t('launch.repoSource.add')}
          </button>
          {repos.length >= max && (
            <span className="muted repo-source-list__max-hint" data-testid="repo-source-max-hint">
              {t('launch.repoSource.maxReached', { max })}
            </span>
          )}
        </div>
      )}
      {multiRepoBlockedReason !== null && multiRepoBlockedReason !== undefined && isMulti && (
        <div
          className="repo-source-list__banner error-text"
          role="alert"
          data-testid="repo-source-multi-banner"
        >
          {t(`launch.repoSource.multiRepoBlocked.${multiRepoBlockedReason}`)}
        </div>
      )}
    </div>
  )
}
