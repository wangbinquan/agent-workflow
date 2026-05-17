// Skills list page.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Skill, SkillSourceWithStats } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { SkillSourcesCard } from '@/components/SkillSourcesCard'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/skills',
  component: SkillsPage,
})

function SkillsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: ({ signal }) => api.get('/api/skills', undefined, signal),
  })
  const sourceListQuery = useQuery<{ sources: SkillSourceWithStats[] }>({
    queryKey: ['skill-sources'],
    queryFn: ({ signal }) => api.get('/api/skill-sources', undefined, signal),
  })
  const labelById = new Map<string, string>(
    (sourceListQuery.data?.sources ?? []).map((s) => [s.id, s.label]),
  )

  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/api/skills/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('skills.title')}</h1>
          <p className="page__hint">
            {t('skills.hintBefore')}
            <code>{t('skills.hintManaged')}</code>
            {t('skills.hintMid')}
            <code>{t('skills.hintManagedPath')}</code>
            {t('skills.hintBetween')}
            <code>{t('skills.hintExternal')}</code>
            {t('skills.hintAfter')}
          </p>
        </div>
        <Link to="/skills/new" className="btn btn--primary">
          {t('skills.newButton')}
        </Link>
      </header>

      {isLoading && <LoadingState data-testid="skills-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('skills.emptyList')} data-testid="skills-empty" />
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('skills.colName')}</th>
              <th>{t('skills.colSource')}</th>
              <th>{t('skills.colDescription')}</th>
              <th>{t('skills.colPath')}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td className="data-table__nowrap">
                  <Link to="/skills/$name" params={{ name: s.name }} className="data-table__link">
                    {s.name}
                  </Link>
                  {s.sourceId !== undefined && (
                    <a
                      href={`#source-${s.sourceId}`}
                      className="source-pill"
                      data-testid="source-pill"
                    >
                      {t('skills.sourceFromPill', {
                        label: labelById.get(s.sourceId) ?? s.sourceId,
                      })}
                    </a>
                  )}
                </td>
                <td>
                  <span className={`chip chip--tight chip--${s.sourceKind}`}>{s.sourceKind}</span>
                </td>
                <td className="data-table__muted">{s.description || t('common.emDash')}</td>
                <td className="data-table__muted">
                  <code>{s.managedPath ?? s.externalPath ?? t('common.emDash')}</code>
                </td>
                <td className="data-table__actions">
                  <Link to="/skills/$name" params={{ name: s.name }} className="btn btn--sm">
                    {t('common.open')}
                  </Link>
                  <ConfirmButton
                    label={t('common.delete')}
                    onConfirm={() => del.mutateAsync(s.name)}
                    danger
                    disabled={del.isPending}
                    size="sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SkillSourcesCard />
    </div>
  )
}
