// RFC-101 PR-A — skill version history panel: list past versions, diff any
// version against current, and restore (forward-only). Reuses the shared
// DiffViewer / Dialog / ConfirmButton / Empty+Loading primitives.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  SkillContent,
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
import { LoadingState } from '@/components/LoadingState'
import { TableViewport } from '@/components/TableViewport'

const SOURCE_KEY: Record<SkillVersionSource, string> = {
  initial: 'skills.versionSourceInitial',
  editor: 'skills.versionSourceEditor',
  fusion: 'skills.versionSourceFusion',
  restore: 'skills.versionSourceRestore',
}

export function SkillVersionHistory({
  skillName,
  currentVersion,
  onRestored,
  busy = false,
  onRestoreStart,
  onPendingChange,
}: {
  skillName: string
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
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const enc = encodeURIComponent(skillName)

  const versions = useQuery<SkillVersion[]>({
    queryKey: ['skills', skillName, 'versions'],
    queryFn: ({ signal }) => api.get(`/api/skills/${enc}/versions`, undefined, signal),
  })

  const [diffFrom, setDiffFrom] = useState<number | null>(null)
  const diff = useQuery<SkillVersionDiff>({
    queryKey: ['skills', skillName, 'versions', 'diff', diffFrom, currentVersion],
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
      const tok = qc.getQueryData<SkillContent>(['skills', skillName, 'content'])?.token
      return api.post(
        `/api/skills/${enc}/versions/${v}/restore`,
        tok !== undefined ? { expectedToken: tok } : {},
      )
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills', skillName] })
      // Reloads content → the canonical token advances to the restored generation.
      void qc.invalidateQueries({ queryKey: ['skills', skillName, 'content'] })
      void qc.invalidateQueries({ queryKey: ['skills', skillName, 'versions'] })
      void qc.invalidateQueries({ queryKey: ['skill-files', skillName] })
      void qc.invalidateQueries({ queryKey: ['skills'] })
      onRestored?.()
    },
    onError: () => {
      // A 409 (stale token) refetches the canonical token so a retry is fresh.
      void qc.invalidateQueries({ queryKey: ['skills', skillName, 'content'] })
    },
  })

  useEffect(() => {
    onPendingChange?.(restore.isPending)
  }, [restore.isPending, onPendingChange])

  const versionsRetry = (
    <button type="button" className="btn btn--sm" onClick={() => void versions.refetch()}>
      {t('common.retry')}
    </button>
  )
  const diffRetry = (
    <button type="button" className="btn btn--sm" onClick={() => void diff.refetch()}>
      {t('common.retry')}
    </button>
  )

  return (
    <section className="page__section">
      <h2>{t('skills.versionsSection')}</h2>
      {versions.data === undefined && versions.isLoading ? (
        <LoadingState size="compact" />
      ) : versions.data === undefined ? (
        <ErrorBanner error={versions.error} action={versionsRetry} />
      ) : versions.data.length === 0 ? (
        <EmptyState size="compact" title={t('skills.versionsEmpty')} />
      ) : (
        <>
          {versions.error !== null && versions.error !== undefined && (
            <ErrorBanner error={versions.error} action={versionsRetry} />
          )}
          {restore.error !== null && restore.error !== undefined && (
            <ErrorBanner error={restore.error} />
          )}
          <TableViewport label={t('skills.versionsSection')} minWidth="lg">
            <table className="data-table data-table--compact">
              <tbody>
                {versions.data.map((v) => {
                  const isCurrent = v.versionIndex === currentVersion
                  return (
                    <tr key={v.id}>
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
                          </>
                        )}
                      </td>
                    </tr>
                  )
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
          <ErrorBanner error={diff.error} action={diffRetry} />
        ) : (
          <>
            {diff.error !== null && diff.error !== undefined && (
              <ErrorBanner error={diff.error} action={diffRetry} />
            )}
            <DiffViewer diff={diff.data.diff} />
          </>
        )}
      </Dialog>
    </section>
  )
}
