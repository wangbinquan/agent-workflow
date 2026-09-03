// RFC-101 PR-A — skill version history panel: list past versions, diff any
// version against current, and restore (forward-only). Reuses the shared
// DiffViewer / Dialog / ConfirmButton / Empty+Loading primitives.
//
// RFC-353 T10 —— 每个「融合」版本可以展开，看这一版到底吃进了哪些知识。
// 展开区复用 `OperationsExpandButton` 与 `.data-table__expand*` 那套既有原语
// （与事件中心的投递详情、仓库组同一形态），不自写 chrome。
// 来源数据来自 `GET /api/skills/:id/provenance`：**整份一次取回**，不按行请求——
// 版本行本来就不多，逐行取会在展开三四行时打出四五个并发请求，且每次折叠再展开又重来。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  SkillContent,
  SkillProvenance,
  SkillVersion,
  SkillVersionDiff,
  SkillVersionSource,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { DiffViewer } from '@/components/DiffViewer'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { LoadingState } from '@/components/LoadingState'
import { OperationsExpandButton } from '@/components/operations/OperationsExpandButton'
import { TableViewport } from '@/components/TableViewport'

const SOURCE_KEY: Record<SkillVersionSource, string> = {
  initial: 'skills.versionSourceInitial',
  editor: 'skills.versionSourceEditor',
  fusion: 'skills.versionSourceFusion',
  restore: 'skills.versionSourceRestore',
  import: 'skills.versionSourceImport',
}

export function SkillVersionHistory({
  skillId,
  currentVersion,
  onRestored,
  busy = false,
  onRestoreStart,
  onPendingChange,
  canRestore = true,
}: {
  skillId: string
  currentVersion: number
  /** RFC-169: called after a successful restore so the detail page can rebase
   *  the content editor onto the restored version (restoreEpoch remount). */
  onRestored?: () => void
  /** RFC-169: another version operation (save / file write) is in flight —
   *  disable restore for simple mutual exclusion. */
  busy?: boolean
  /** Synchronous pre-mutation hook used by the route-level navigation guard. */
  onRestoreStart?: () => void
  /** RFC-169: report restore-in-flight so the detail can disable Save too. */
  onPendingChange?: (pending: boolean) => void
  /** Read-only viewers may compare revisions without mutating history. */
  canRestore?: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const enc = encodeURIComponent(skillId)

  const versions = useQuery<SkillVersion[]>({
    queryKey: ['skills', skillId, 'versions'],
    queryFn: ({ signal }) => api.get(`/api/skills/${enc}/versions`, undefined, signal),
  })

  // RFC-353 T10：展开的版本号（一次只展开一行，和事件中心的投递详情同一交互）。
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  // 只在用户第一次展开时才去取——技能详情页的默认视图不该为一个折叠区多打一次请求。
  const provenance = useQuery<SkillProvenance>({
    queryKey: ['skills', skillId, 'provenance'],
    enabled: expandedVersion !== null,
    queryFn: ({ signal }) => api.get(`/api/skills/${enc}/provenance`, undefined, signal),
  })
  const fusedByVersion = new Map(
    (provenance.data?.versions ?? []).map((v) => [v.versionIndex, v.memories]),
  )

  const [diffFrom, setDiffFrom] = useState<number | null>(null)
  const diff = useQuery<SkillVersionDiff>({
    queryKey: ['skills', skillId, 'versions', 'diff', diffFrom, currentVersion],
    enabled: diffFrom !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/api/skills/${enc}/versions/diff`,
        { from: String(diffFrom), to: String(currentVersion) },
        signal,
      ),
  })

  const restore = useMutation({
    mutationFn: (v: number) => {
      // RFC-170 F3 (G2-7): echo the canonical token so a save/file-write landing
      // since the history loaded → 409 (not a silent overwrite of a newer edit).
      const tok = qc.getQueryData<SkillContent>(['skills', skillId, 'content'])?.token
      return api.post(
        `/api/skills/${enc}/versions/${v}/restore`,
        tok !== undefined ? { expectedToken: tok } : {},
      )
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills', skillId] })
      // Reloads content → the canonical token advances to the restored generation.
      void qc.invalidateQueries({ queryKey: ['skills', skillId, 'content'] })
      void qc.invalidateQueries({ queryKey: ['skills', skillId, 'versions'] })
      void qc.invalidateQueries({ queryKey: ['skill-files', skillId] })
      void qc.invalidateQueries({ queryKey: ['skills'] })
      onRestored?.()
    },
    onError: () => {
      // A 409 (stale token) refetches the canonical token so a retry is fresh.
      void qc.invalidateQueries({ queryKey: ['skills', skillId, 'content'] })
    },
  })

  useEffect(() => {
    onPendingChange?.(restore.isPending)
  }, [restore.isPending, onPendingChange])

  return (
    <section className="page__section">
      <h2>{t('skills.versionsSection')}</h2>
      {versions.data === undefined && versions.isLoading ? (
        <LoadingState size="compact" />
      ) : versions.data === undefined ? (
        <ErrorBanner error={versions.error} onRetry={() => void versions.refetch()} />
      ) : versions.data.length === 0 ? (
        <EmptyState size="compact" title={t('skills.versionsEmpty')} />
      ) : (
        <>
          <FeedbackStack variant="section">
            {versions.error !== null && versions.error !== undefined && (
              <ErrorBanner error={versions.error} onRetry={() => void versions.refetch()} />
            )}
            {restore.error !== null && restore.error !== undefined && (
              <ErrorBanner error={restore.error} />
            )}
          </FeedbackStack>
          <TableViewport label={t('skills.versionsSection')} minWidth="lg">
            <table className="data-table data-table--compact">
              <tbody>
                {versions.data.flatMap((v) => {
                  const isCurrent = v.versionIndex === currentVersion
                  // 只有融合版本有来源可展开——其余来源（编辑 / 导入 / 回滚 / 初始）不吃记忆，
                  // 给它们一个永远空的展开箭头只会让人以为数据丢了。
                  const expandable = v.source === 'fusion'
                  const expanded = expandable && expandedVersion === v.versionIndex
                  const detailsId = `skill-version-provenance-${v.versionIndex}`
                  return [
                    <tr key={v.id}>
                      <td className="data-table__expand">
                        {expandable && (
                          <OperationsExpandButton
                            expanded={expanded}
                            controls={detailsId}
                            label={
                              expanded
                                ? t('skills.provenanceCollapse', { n: v.versionIndex })
                                : t('skills.provenanceExpand', { n: v.versionIndex })
                            }
                            testid={`skill-version-provenance-toggle-${v.versionIndex}`}
                            onToggle={() => setExpandedVersion(expanded ? null : v.versionIndex)}
                          />
                        )}
                      </td>
                      <td>
                        <strong>{t('skills.versionLabel', { n: v.versionIndex })}</strong>{' '}
                        <span className={`chip chip--tight chip--${v.source}`}>
                          {t(SOURCE_KEY[v.source])}
                        </span>
                        {isCurrent && (
                          <span className="chip chip--tight chip--managed">
                            {t('skills.versionCurrent')}
                          </span>
                        )}
                      </td>
                      <td className="muted">
                        {v.source === 'restore' && v.restoredFromVersion !== null
                          ? t('skills.versionRestoredFrom', { n: v.restoredFromVersion })
                          : (v.summary ?? '')}
                      </td>
                      <td className="muted">
                        {new Date(v.createdAt).toLocaleString()}
                        {v.authorUserId
                          ? ` · ${t('skills.versionBy', { who: v.authorUserId })}`
                          : ''}
                      </td>
                      <td className="page__actions">
                        {!isCurrent && (
                          <>
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => setDiffFrom(v.versionIndex)}
                            >
                              {t('skills.versionCompare')}
                            </button>
                            {canRestore && (
                              <ConfirmButton
                                size="sm"
                                label={t('skills.versionRestore')}
                                confirmLabel={t('skills.versionRestoreConfirm', {
                                  n: v.versionIndex,
                                })}
                                onConfirm={() => {
                                  onRestoreStart?.()
                                  restore.mutate(v.versionIndex)
                                }}
                                disabled={restore.isPending || busy}
                              />
                            )}
                          </>
                        )}
                      </td>
                    </tr>,
                    ...(expanded
                      ? [
                          <tr
                            key={`${v.id}-provenance`}
                            id={detailsId}
                            className="data-table__expanded-row"
                          >
                            <td colSpan={5} className="skill-provenance">
                              {provenance.data === undefined && provenance.isLoading ? (
                                <LoadingState size="compact" />
                              ) : provenance.data === undefined ? (
                                <ErrorBanner
                                  error={provenance.error}
                                  onRetry={() => void provenance.refetch()}
                                />
                              ) : (fusedByVersion.get(v.versionIndex) ?? []).length === 0 ? (
                                <EmptyState size="compact" title={t('skills.provenanceEmpty')} />
                              ) : (
                                <>
                                  <p className="skill-provenance__caption muted">
                                    {t('skills.provenanceCaption', { n: v.versionIndex })}
                                  </p>
                                  <ul className="skill-provenance__list">
                                    {(fusedByVersion.get(v.versionIndex) ?? []).map((m) => (
                                      <li key={m.id} className="skill-provenance__item">
                                        <span
                                          className={`memory-row__scope memory-row__scope--${m.scopeType}`}
                                        >
                                          {t(`memory.scope.${m.scopeType}`)}
                                        </span>
                                        <span className="skill-provenance__title">{m.title}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </>
                              )}
                            </td>
                          </tr>,
                        ]
                      : []),
                  ]
                })}
              </tbody>
            </table>
          </TableViewport>
        </>
      )}

      <Dialog
        open={diffFrom !== null}
        onClose={() => setDiffFrom(null)}
        title={t('skills.versionDiffTitle', { from: diffFrom ?? 0, to: currentVersion })}
        size="lg"
      >
        {diff.data === undefined && diff.isLoading ? (
          <LoadingState size="compact" />
        ) : diff.data === undefined ? (
          <ErrorBanner error={diff.error} onRetry={() => void diff.refetch()} />
        ) : (
          <>
            {diff.error !== null && diff.error !== undefined && (
              <ErrorBanner error={diff.error} onRetry={() => void diff.refetch()} />
            )}
            <DiffViewer diff={diff.data.diff} />
          </>
        )}
      </Dialog>
    </section>
  )
}
