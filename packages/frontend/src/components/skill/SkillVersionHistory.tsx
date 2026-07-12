// RFC-101 PR-A — skill version history panel: list past versions, diff any
// version against current, and restore (forward-only). Reuses the shared
// DiffViewer / Dialog / ConfirmButton / Empty+Loading primitives.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SkillVersion, SkillVersionDiff, SkillVersionSource } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { DiffViewer } from '@/components/DiffViewer'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'

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
    mutationFn: (v: number) => api.post(`/api/skills/${enc}/versions/${v}/restore`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills', skillName] })
      void qc.invalidateQueries({ queryKey: ['skills', skillName, 'content'] })
      void qc.invalidateQueries({ queryKey: ['skills', skillName, 'versions'] })
      void qc.invalidateQueries({ queryKey: ['skill-files', skillName] })
      void qc.invalidateQueries({ queryKey: ['skills'] })
      onRestored?.()
    },
  })

  useEffect(() => {
    onPendingChange?.(restore.isPending)
  }, [restore.isPending, onPendingChange])

  return (
    <section className="page__section">
      <h2>{t('skills.versionsSection')}</h2>
      {versions.isLoading ? (
        <LoadingState size="compact" />
      ) : (versions.data?.length ?? 0) === 0 ? (
        <EmptyState size="compact" title={t('skills.versionsEmpty')} />
      ) : (
        <table className="table">
          <tbody>
            {versions.data?.map((v) => {
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
                    {v.authorUserId ? ` · ${t('skills.versionBy', { who: v.authorUserId })}` : ''}
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
                          confirmLabel={t('skills.versionRestoreConfirm', { n: v.versionIndex })}
                          onConfirm={() => restore.mutateAsync(v.versionIndex)}
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
      )}

      <Dialog
        open={diffFrom !== null}
        onClose={() => setDiffFrom(null)}
        title={t('skills.versionDiffTitle', { from: diffFrom ?? 0, to: currentVersion })}
        size="lg"
      >
        {diff.isLoading ? (
          <LoadingState size="compact" />
        ) : (
          <DiffViewer diff={diff.data?.diff ?? ''} />
        )}
      </Dialog>
    </section>
  )
}
