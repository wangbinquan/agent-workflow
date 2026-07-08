// RFC-017: Skill source folders panel on the /skills list page.
//
// Pulls `/api/skill-sources` and renders one card per registered parent
// directory. Each card shows label / path / childCount / lastScannedAt + two
// actions: Rescan (POST /:id/rescan) and Remove (DELETE /:id).
//
// Errors from Remove that carry the `skill-source-children-referenced` code
// surface their `blockers` payload as a structured list so the user can fix
// the binding before retrying.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Skill, SkillSkipReport, SkillSourceWithStats } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { LoadingState } from '@/components/LoadingState'
import { useActor } from '@/hooks/useActor'

interface SourcesResponse {
  sources: SkillSourceWithStats[]
}

interface BlockersPayload {
  blockers?: Array<{ skillName: string; byAgent: string }>
}

/**
 * RFC-102: whether the current actor may replace the skill occupying a source
 * same-name conflict. Only name-conflict-* rows are replaceable; admins always
 * can; otherwise BOTH server gates must pass — the actor is the source
 * registrar (route requireSourceRegistrar) AND owns the occupying skill
 * (service requireResourceOwner). Mirroring both client-side avoids enabling a
 * button whose POST is a guaranteed 403. An invisible occupier (a private skill
 * owned by someone else) is absent from `visibleSkills` → false, which is
 * correct (you can't own what you can't see) and never leaks the owner identity.
 */
export function canReplaceConflict(
  report: SkillSkipReport,
  source: SkillSourceWithStats,
  visibleSkills: Skill[],
  currentUserId: string | null,
  isAdmin: boolean,
): boolean {
  if (report.reason !== 'name-conflict-manual' && report.reason !== 'name-conflict-source') {
    return false
  }
  if (isAdmin) return true
  if (currentUserId === null) return false
  // Gate 1 — source registrar (route requireSourceRegistrar rejects others 403).
  if (source.createdBy == null || source.createdBy !== currentUserId) return false
  // Gate 2 — owner of the occupying skill (service requireResourceOwner).
  const occupying = visibleSkills.find((s) => s.name === report.proposedName)
  return occupying !== undefined && occupying.ownerUserId === currentUserId
}

export function SkillSourcesCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<SourcesResponse>({
    queryKey: ['skill-sources'],
    queryFn: ({ signal }) => api.get<SourcesResponse>('/api/skill-sources', undefined, signal),
  })

  const rescan = useMutation({
    mutationFn: (id: string) => api.post(`/api/skill-sources/${id}/rescan`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skill-sources'] })
      void qc.invalidateQueries({ queryKey: ['skills'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/skill-sources/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skill-sources'] })
      void qc.invalidateQueries({ queryKey: ['skills'] })
    },
  })

  // RFC-102: replace a same-name conflict with this source's version. canReplace
  // is derived client-side from the visible skills + current actor (no extra
  // endpoint, no owner-identity leak); the backend re-checks write permission.
  const { data: me } = useActor()
  const currentUserId = me?.user?.id ?? null
  const isAdmin = me?.user?.role === 'admin'

  const skillsList = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: ({ signal }) => api.get<Skill[]>('/api/skills', undefined, signal),
  })
  const visibleSkills = Array.isArray(skillsList.data) ? skillsList.data : []

  const replace = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.post(`/api/skill-sources/${id}/conflicts/replace`, { name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skill-sources'] })
      void qc.invalidateQueries({ queryKey: ['skills'] })
    },
  })

  const sources = data?.sources ?? []
  return (
    <section className="skill-sources" aria-label={t('skills.sourcesTitle')}>
      <h2 className="skill-sources__title">{t('skills.sourcesTitle')}</h2>
      {isLoading && <LoadingState size="compact" />}
      {error !== null && error !== undefined && (
        <div className="form-actions__error">{describeError(error, t)}</div>
      )}
      {!isLoading && sources.length === 0 && (
        <div className="muted">{t('skills.sourcesEmpty')}</div>
      )}
      <ul className="skill-sources__list">
        {sources.map((s) => (
          <li key={s.id} id={`source-${s.id}`} className="skill-sources__item">
            <div className="skill-sources__head">
              <strong className="skill-sources__label">{s.label}</strong>
              <span className="skill-sources__count">
                {t('skills.sourceChildCount', { n: s.childCount })}
              </span>
            </div>
            <code className="skill-sources__path">{s.path}</code>
            <div className="skill-sources__meta">
              {s.lastScannedAt === null
                ? t('skills.sourceNeverScanned')
                : t('skills.sourceLastScannedAt', {
                    when: new Date(s.lastScannedAt).toLocaleString(),
                  })}
            </div>
            {s.skipped.length > 0 && (
              <details className="skill-sources__skipped">
                <summary>{t('skills.sourceSkippedBanner', { n: s.skipped.length })}</summary>
                <ul>
                  {s.skipped.map((sk, idx: number) => {
                    const replaceable =
                      (sk.reason === 'name-conflict-manual' ||
                        sk.reason === 'name-conflict-source') &&
                      sk.proposedName !== undefined
                    const allowed = canReplaceConflict(sk, s, visibleSkills, currentUserId, isAdmin)
                    return (
                      <li key={idx}>
                        <code>{sk.proposedName ?? sk.childPath}</code> — {sk.reason}
                        {replaceable && (
                          <button
                            type="button"
                            className="btn btn--xs"
                            disabled={!allowed || replace.isPending}
                            title={allowed ? undefined : t('skills.sourceConflictNoPermission')}
                            onClick={() => replace.mutate({ id: s.id, name: sk.proposedName! })}
                            data-testid={`source-conflict-replace-${sk.proposedName}`}
                          >
                            {t('skills.sourceConflictReplace')}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
                {replace.error !== null && replace.error !== undefined && (
                  <div className="form-actions__error">{describeError(replace.error, t)}</div>
                )}
              </details>
            )}
            <div className="skill-sources__actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => rescan.mutate(s.id)}
                disabled={rescan.isPending}
              >
                {t('skills.sourceRescan')}
              </button>
              <ConfirmButton
                label={t('skills.sourceRemove')}
                confirmLabel={t('skills.sourceRemoveConfirmTitle', { label: s.label })}
                onConfirm={() => remove.mutate(s.id)}
                variant="danger"
                disabled={remove.isPending}
                size="sm"
              />
            </div>
            {remove.error !== null && remove.error !== undefined && (
              <BlockerBanner err={remove.error} t={t} />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function BlockerBanner({
  err,
  t,
}: {
  err: unknown
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  if (!(err instanceof ApiError)) return <div className="form-actions__error">{String(err)}</div>
  if (err.code !== 'skill-source-children-referenced') {
    return <div className="form-actions__error">{describeError(err, t)}</div>
  }
  const blockers = (err.details as BlockersPayload | undefined)?.blockers ?? []
  return (
    <div className="form-actions__error" role="alert">
      <div>{t('skills.sourceRemoveConfirmBlocked')}</div>
      <ul>
        {blockers.map((b, i) => (
          <li key={i}>
            <code>{b.skillName}</code> ← <code>{b.byAgent}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}

function describeError(e: unknown, t: (key: string) => string): string {
  if (e instanceof ApiError) return `${t('errors.fallback')}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
