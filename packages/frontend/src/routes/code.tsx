// RFC-304 T32/T33 — the `/code` minimal surface.
//
// Two tabs, which is the whole of PR-5: configure which capabilities a
// repository runs, and watch what they have been doing.
//
// ## Why readiness is rendered as an action, not a badge
//
// A cell that says `misconfigured` and stops has moved the problem rather than
// solved it — somebody now has to work out which of five prerequisites is
// missing and where it lives. The backend already pairs each missing piece with
// the route that fixes it (`repairActions`), so this page renders links, not a
// red label. The design names "configured, silent, and no way to tell why" as
// the most common reason a platform like this gets abandoned.
//
// ## Why the switch stays on when the cell is not ready
//
// Enabling with prerequisites missing is legitimate — people configure in
// whatever order suits them. What the page must never do is show a switch that
// reads "on" beside a capability that will never run, with no explanation. So
// the row says "on, and still needs X".

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { Switch } from '@/components/Form'
import { TabPanels } from '@/components/split/TabPanels'
import { TabBar } from '@/components/TabBar'
import { Route as RootRoute } from './__root'

export type CodeTab = 'matrix' | 'activity'

interface CodeSearch extends Record<string, unknown> {
  tab?: CodeTab
  repo?: string
}

function isCodeTab(value: unknown): value is CodeTab {
  return value === 'matrix' || value === 'activity'
}

/** Unknown values are dropped rather than rendered — same rule as /webhooks. */
export function validateCodeSearch(search: Record<string, unknown>): CodeSearch {
  const { tab: _tab, repo: _repo, ...adjacent } = search
  return {
    ...adjacent,
    ...(isCodeTab(search.tab) ? { tab: search.tab } : {}),
    ...(typeof search.repo === 'string' && search.repo !== '' ? { repo: search.repo } : {}),
  }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code',
  validateSearch: validateCodeSearch,
  component: CodePage,
})

interface RepairAction {
  code: string
  label: string
  route: string
}

interface MatrixRow {
  repoId: string
  capability: string
  enabled: boolean
  readiness: 'disabled' | 'misconfigured' | 'ready'
  issues: Array<{ code: string; detail: string }>
  repairActions: RepairAction[]
  bindingId: string | null
}

interface StageRow {
  stageName: string
  stageSeq: number
  kind: string
  status: string
  error: string | null
}

interface RoundRow {
  roundId: string
  roundSeq: number
  status: string
  outcome: string | null
  baselineSha: string | null
  stages: StageRow[]
}

interface WorkItemRow {
  workItemId: string
  capability: string
  anchorKind: string
  anchorId: string
  status: string
  epoch: number
  rounds: RoundRow[]
}

/**
 * Readiness → chip colour.
 *
 * `disabled` is NEUTRAL, not a warning: switched off is a choice, and painting
 * it the same as a fault trains people to ignore the colour that means "this
 * is broken".
 */
function readinessKind(readiness: MatrixRow['readiness']): 'success' | 'warn' | 'neutral' {
  if (readiness === 'ready') return 'success'
  return readiness === 'misconfigured' ? 'warn' : 'neutral'
}

function roundKind(status: string): 'success' | 'warn' | 'danger' | 'info' {
  if (status === 'published') return 'success'
  if (status === 'failed' || status === 'ended-without-outcome') return 'danger'
  if (status === 'settling' || status === 'superseded') return 'warn'
  return 'info'
}

function stageKind(status: string): 'success' | 'danger' | 'info' | 'neutral' {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'skipped' || status === 'inherited') return 'neutral'
  return 'info'
}

function CodePage() {
  const { t } = useTranslation()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tab: CodeTab = search.tab ?? 'matrix'

  return (
    <div className="page">
      <PageHeader title={t('code.title')} meta={t('code.subtitle')} />
      <TabBar<CodeTab>
        tabs={[
          { key: 'matrix', label: t('code.tab.matrix') },
          { key: 'activity', label: t('code.tab.activity') },
        ]}
        active={tab}
        ariaLabel={t('code.title')}
        idPrefix="code"
        onSelect={(key) => {
          void navigate({ search: (prev: CodeSearch) => ({ ...prev, tab: key }) })
        }}
      />
      {/* `TabPanels` with the SAME idPrefix, not a bare ternary: that pairing is
          what wires `aria-controls` on each tab to the panel it opens. A hand-
          rolled conditional renders the right content and leaves a screen reader
          with tabs that control nothing. */}
      <TabPanels<CodeTab>
        active={tab}
        idPrefix="code"
        panels={[
          { key: 'matrix', testid: 'code-panel-matrix', content: <MatrixPanel /> },
          { key: 'activity', testid: 'code-panel-activity', content: <ActivityPanel /> },
        ]}
      />
    </div>
  )
}

function MatrixPanel() {
  const { t } = useTranslation()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const [repoDraft, setRepoDraft] = useState(search.repo ?? '')
  const repoId = search.repo ?? ''

  const matrix = useQuery({
    queryKey: ['code-matrix', repoId],
    queryFn: () => api.get<{ rows: MatrixRow[] }>(`/api/code/matrix/${encodeURIComponent(repoId)}`),
    // Nothing to ask for without a repository; an empty request would 404 on a
    // path with an empty segment and read as a broken page.
    enabled: repoId !== '',
  })

  const toggle = useMutation({
    mutationFn: (row: { capability: string; enabled: boolean }) =>
      api.put<{ row: MatrixRow }>(`/api/code/matrix/${encodeURIComponent(repoId)}`, row),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['code-matrix', repoId] }),
  })

  return (
    <section className="page__section">
      <form
        className="page__header--row"
        onSubmit={(e) => {
          e.preventDefault()
          void navigate({ search: (prev: CodeSearch) => ({ ...prev, repo: repoDraft }) })
        }}
      >
        <Field label={t('code.repoLabel')} hint={t('code.repoHint')}>
          <TextInput
            value={repoDraft}
            onChange={setRepoDraft}
            placeholder="group/project"
            aria-label={t('code.repoLabel')}
          />
        </Field>
        <button type="submit" className="btn btn--primary btn--sm">
          {t('code.load')}
        </button>
      </form>

      {repoId === '' ? (
        <EmptyState title={t('code.pickRepo')} />
      ) : matrix.isPending ? (
        <LoadingState />
      ) : matrix.isError ? (
        <ErrorBanner error={matrix.error} onRetry={() => void matrix.refetch()} />
      ) : (matrix.data?.rows.length ?? 0) === 0 ? (
        <EmptyState title={t('code.noCapabilities')} />
      ) : (
        <ul className="page__section" data-testid="code-matrix">
          {matrix.data?.rows.map((row) => (
            <li key={row.capability} className="card">
              <div className="page__header--row">
                <strong>{row.capability}</strong>
                <StatusChip kind={readinessKind(row.readiness)}>
                  {t(`code.readiness.${row.readiness}`)}
                </StatusChip>
                <Switch
                  checked={row.enabled}
                  onChange={(enabled) => toggle.mutate({ capability: row.capability, enabled })}
                  label={t('code.enabled')}
                  data-testid={`code-toggle-${row.capability}`}
                />
              </div>

              {/* The point of the page: what is missing, and where to fix it. */}
              {row.issues.length > 0 && (
                <ul data-testid={`code-issues-${row.capability}`}>
                  {row.issues.map((issue, index) => (
                    <li key={issue.code + String(index)}>
                      <span>{issue.detail}</span>{' '}
                      {row.repairActions[index] !== undefined && (
                        <a className="btn btn--xs" href={row.repairActions[index].route}>
                          {row.repairActions[index].label}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {toggle.isError && <ErrorBanner error={toggle.error} />}
    </section>
  )
}

/**
 * The state machine's first two levels (T33): the work item, and its rounds
 * expanded into stages.
 *
 * Deeper levels (per-shard attempts) are deliberately absent — they are
 * per-round detail, and the backend projection does not carry them so the
 * common request does not pay for the rare one.
 */
function ActivityPanel() {
  const { t } = useTranslation()
  const items = useQuery({
    queryKey: ['code-work-items'],
    queryFn: () =>
      api.get<{ items: WorkItemRow[]; nextCursor: string | null }>('/api/code/work-items'),
  })

  if (items.isPending) return <LoadingState />
  if (items.isError) return <ErrorBanner error={items.error} onRetry={() => void items.refetch()} />
  if ((items.data?.items.length ?? 0) === 0) {
    return <EmptyState title={t('code.noActivity')} description={t('code.noActivityHint')} />
  }

  return (
    <section className="page__section">
      <ul data-testid="code-work-items">
        {items.data?.items.map((item) => (
          <li key={item.workItemId} className="card">
            <div className="page__header--row">
              <strong>
                {item.capability} · {item.anchorKind} {item.anchorId}
              </strong>
              <StatusChip kind="info">{item.status}</StatusChip>
            </div>

            {item.rounds.map((round) => (
              <div key={round.roundId} className="page__section">
                <div className="page__header--row">
                  <span>{t('code.round', { seq: round.roundSeq })}</span>
                  <StatusChip kind={roundKind(round.status)}>{round.status}</StatusChip>
                </div>
                <ol data-testid={`code-stages-${round.roundId}`}>
                  {round.stages.map((stage) => (
                    <li key={stage.stageName}>
                      <span>{stage.stageName}</span>{' '}
                      <StatusChip kind={stageKind(stage.status)} size="sm">
                        {stage.status}
                      </StatusChip>
                      {/* A failed stage without its reason forces a log dig. */}
                      {stage.error !== null && <span> — {stage.error}</span>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  )
}
