// RFC-309 T16 — the four states of a copy, and the merge, on screen at last.
//
// RFC-304 built `judgeUpstream` / `resolveThreeWay` / `mergeUnoverridden`, unit
// tested them, and shipped them with no caller. RFC-309 makes them matter: the
// shared department framework is gone, so the only record that two teams run
// the same review is that one copied it from the other, and an upstream fix
// reaches a copy only if somebody is told about it.
//
// ## What this panel refuses to do
//
// It never shows a merge button it cannot honour. Three cases would each
// produce one if the states were collapsed:
//
//   `current`    — nothing to take. A live button here teaches people the
//                  button does nothing, and then they stop pressing it when it
//                  would have mattered.
//   `orphaned`   — the upstream is gone. Every migrated template is in this
//                  state, so this is the common case, not the exotic one.
//   no base      — a copy made before the base snapshot existed. The server
//                  reports every difference as a conflict there, so the merge
//                  would apply nothing; saying why is better than a button
//                  that appears to work and changes nothing.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'

type UpstreamState = 'current' | 'update-available' | 'conflicted' | 'orphaned'

type FieldResolution =
  | { field: string; action: 'unchanged' }
  | { field: string; action: 'take-upstream'; value: unknown }
  | { field: string; action: 'keep-local'; value: unknown }
  | { field: string; action: 'conflict'; upstream: unknown; local: unknown }

interface UpstreamReport {
  link: { upstreamId: string; upstreamVersion: number } | null
  status: { state: UpstreamState; message: string; localOverrides: string[] } | null
  upstreamName: string | null
  fields: FieldResolution[]
  baseRecorded: boolean
}

const STATE_CHIP: Record<UpstreamState, StatusChipKind> = {
  current: 'success',
  'update-available': 'info',
  conflicted: 'warn',
  orphaned: 'neutral',
}

export function TemplateUpstreamPanel({ templateId }: { templateId: string }): React.ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const report = useQuery({
    queryKey: ['capability-template-upstream', templateId],
    queryFn: () => api.get<UpstreamReport>(`/api/capability-templates/${templateId}/upstream`),
  })

  const merge = useMutation({
    mutationFn: () =>
      api.post<{ applied: string[]; keptLocal: string[]; stillConflicted: string[] }>(
        `/api/capability-templates/${templateId}/upstream/merge`,
        {},
      ),
    onSuccess: async () => {
      // Both: the merge changed the template itself AND where it stands
      // relative to upstream. Invalidating only one leaves the page showing a
      // flow from before the merge next to a badge from after it.
      await queryClient.invalidateQueries({ queryKey: ['capability-template', templateId] })
      await queryClient.invalidateQueries({
        queryKey: ['capability-template-upstream', templateId],
      })
    },
  })

  // A failed lookup is SAID, not hidden. Everything else on this page renders
  // from a different query, so silently dropping the panel would show a copy
  // with no origin at all — indistinguishable from an original, which is the
  // one thing this panel exists to tell apart.
  if (report.isError) {
    return (
      <section className="page__section card" data-testid="code-template-upstream-error">
        <ErrorBanner error={report.error} onRetry={() => void report.refetch()} />
      </section>
    )
  }

  // An original has no origin, and that is not worth a section. Rendering an
  // empty panel on the majority of templates would be noise on the common case.
  if (report.data === undefined || report.data.status === null) return <></>

  const { status, fields, upstreamName, baseRecorded } = report.data
  const changed = fields.filter((f) => f.action !== 'unchanged')
  const canMerge =
    status.state === 'update-available' || (status.state === 'conflicted' && baseRecorded)
  const takeable = fields.filter((f) => f.action === 'take-upstream').length

  return (
    <section className="page__section card" data-testid="code-template-upstream">
      <div className="page__header--row">
        <h3>{t('code.upstream.title')}</h3>
        <StatusChip kind={STATE_CHIP[status.state]} size="sm">
          {t(`code.upstream.state.${status.state}`)}
        </StatusChip>
        {upstreamName !== null && (
          <span data-testid="code-upstream-name">
            {t('code.upstream.from', { name: upstreamName })}
          </span>
        )}
      </div>

      <p data-testid="code-upstream-message">{status.message}</p>

      {!baseRecorded && status.state !== 'orphaned' && (
        // Said out loud rather than shown as "everything conflicts": the reader
        // would otherwise conclude their copy diverged wildly, when in fact the
        // platform simply has no record of what it started from.
        <p data-testid="code-upstream-no-base">{t('code.upstream.noBase')}</p>
      )}

      {changed.length > 0 && (
        <ul data-testid="code-upstream-fields">
          {changed.map((f) => (
            <li key={f.field} data-testid={`code-upstream-field-${f.field}`}>
              <StatusChip
                kind={
                  f.action === 'conflict'
                    ? 'warn'
                    : f.action === 'take-upstream'
                      ? 'info'
                      : 'neutral'
                }
                size="sm"
              >
                {t(`code.upstream.action.${f.action}`)}
              </StatusChip>{' '}
              <strong>{f.field}</strong>
            </li>
          ))}
        </ul>
      )}

      {canMerge && (
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            data-testid="code-upstream-merge"
            disabled={merge.isPending || takeable === 0}
            onClick={() => {
              merge.mutate()
            }}
          >
            {t('code.upstream.merge', { count: takeable })}
          </button>
        </div>
      )}

      {merge.isError && <ErrorBanner error={merge.error} />}
      {merge.isSuccess && (
        <p data-testid="code-upstream-merged">
          {t('code.upstream.merged', {
            applied: merge.data.applied.length,
            kept: merge.data.keptLocal.length,
            conflicted: merge.data.stillConflicted.length,
          })}
        </p>
      )}
    </section>
  )
}
