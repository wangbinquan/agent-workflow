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

import { useQuery } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { TabPanels } from '@/components/split/TabPanels'
import { TabBar } from '@/components/TabBar'
import { CapabilityFlow, type StageRunStatus } from '@/components/code/CapabilityFlow'
import { readGraph, type CapabilityGraphResponse } from '@/components/code/graphResponse'
import { Route as RootRoute } from './__root'

// RFC-309 T14 — the standalone Flow tab is gone. It asked two questions before
// it could show anything (which capability, then which configuration), and both
// are answered by opening a template: `/code/templates/$id` IS the flow.
export type CodeTab = 'activity' | 'metrics'

interface CodeSearch extends Record<string, unknown> {
  tab?: CodeTab
  repo?: string
}

function isCodeTab(value: unknown): value is CodeTab {
  return value === 'activity' || value === 'metrics'
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
  /** RFC-307 — which contract version ran, so the flow can flag a stale picture. */
  stageContractVer: number
  baselineSha: string | null
  stages: StageRow[]
}

function useCapabilityGraph(capability: string | null) {
  return useQuery({
    queryKey: ['code-capability-graph', capability],
    queryFn: () =>
      api.get<CapabilityGraphResponse>(
        `/api/code/capabilities/${encodeURIComponent(capability ?? '')}/graph`,
      ),
    enabled: capability !== null && capability !== '',
    // The contract is compiled into the binary — it cannot change under a
    // running daemon, so refetching it is pure waste.
    staleTime: Infinity,
  })
}

interface WorkItemRow {
  workItemId: string
  capability: string
  anchorKind: string
  anchorId: string
  status: string
  epoch: number
  rounds: RoundRow[]
  /** T66 — rounds beyond the ones sent. Always present, zero included. */
  roundsHidden: number
}

/**
 * Readiness → chip colour.
 *
 * `disabled` is NEUTRAL, not a warning: switched off is a choice, and painting
 * it the same as a fault trains people to ignore the colour that means "this
 * is broken".
 */

function roundKind(status: string): 'success' | 'warn' | 'danger' | 'info' {
  if (status === 'published') return 'success'
  if (status === 'failed' || status === 'ended-without-outcome') return 'danger'
  if (status === 'settling' || status === 'superseded') return 'warn'
  return 'info'
}

/**
 * One model call, as the third level shows it.
 *
 * `rerunSeq` and `attemptSeq` are kept separate all the way to the screen; see
 * `StageAttempts` for why collapsing them loses the distinction.
 */
interface AttemptRow {
  attemptId: string
  stageName: string
  shardKey: string
  rerunSeq: number
  attemptSeq: number
  status: string
  validationOutcome: string | null
  sessionRef: string | null
  nodeRunId: string | null
  startedAt: number
  endedAt: number | null
}

function attemptKind(status: string): 'success' | 'danger' | 'warn' | 'info' {
  if (status === 'validated') return 'success'
  if (status === 'failed') return 'danger'
  // `interrupted` is not a failure of the call — the daemon went away
  // underneath it. Painting it red sends someone looking at the prompt.
  if (status === 'interrupted') return 'warn'
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
  const tab: CodeTab = search.tab ?? 'activity'

  return (
    <div className="page">
      <PageHeader
        title={t('code.title')}
        meta={t('code.subtitle')}
        actions={
          <>
            <Link
              to="/code/config/$kind"
              params={{ kind: 'employees' }}
              className="btn btn--sm"
              data-testid="code-config-link"
            >
              {t('code.config.title')}
            </Link>
            <Link to="/code/missions" className="btn btn--sm" data-testid="code-missions-link">
              {t('code.missions.title')}
            </Link>
            <Link
              to="/code/assignments"
              className="btn btn--sm"
              data-testid="code-assignments-link"
            >
              {t('code.assignments.title')}
            </Link>
            <Link to="/code/policies" className="btn btn--sm" data-testid="code-policies-link">
              {t('code.policies.title')}
            </Link>
          </>
        }
      />
      <TabBar<CodeTab>
        tabs={[
          { key: 'activity', label: t('code.tab.activity') },
          { key: 'metrics', label: t('code.tab.metrics') },
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
          { key: 'activity', testid: 'code-panel-activity', content: <ActivityPanel /> },
          { key: 'metrics', testid: 'code-panel-metrics', content: <MetricsPanel /> },
        ]}
      />
    </div>
  )
}
/**
 * All three levels of the state machine (T33/T55/T56): the work item, one
 * round at a time, and — for an AI stage — the individual model calls.
 */
function ActivityPanel() {
  const { t } = useTranslation()
  // T66 — the list asks for a few rounds per item; opening one asks for the
  // window. Widening is per work item rather than global: twenty rounds across
  // twenty items is the response size the bound exists to prevent, and one
  // person reading one merge request should not enlarge everybody else's.
  const [widened, setWidened] = useState<string | null>(null)
  const items = useQuery({
    queryKey: ['code-work-items', widened],
    queryFn: () =>
      api.get<{ items: WorkItemRow[]; nextCursor: string | null }>(
        widened === null ? '/api/code/work-items' : '/api/code/work-items?rounds=20',
      ),
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
            <WorkItemRounds
              item={item}
              {...(widened === null ? { onShowMore: () => setWidened(item.workItemId) } : {})}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * T56 — one round shown at a time, with a switcher for the others.
 *
 * The previous version rendered every projected round inline. That reads fine
 * with two and becomes unusable with more: the round somebody actually came to
 * look at is the newest, and it was buried under the history of the ones before
 * it. Selecting also makes "compare this round with the last one" a deliberate
 * act rather than a scrolling exercise.
 *
 * The newest round is selected by default because that is the one in flight.
 */
function WorkItemRounds({
  item,
  onShowMore,
}: {
  item: WorkItemRow
  /** Widens the request to the full round window; absent once already widened. */
  onShowMore?: () => void
}): ReactElement | null {
  const { t } = useTranslation()
  // Rounds arrive newest first, which is also the order the switcher shows
  // them — most recent on the left, where the eye starts.
  const [selected, setSelected] = useState<string>(item.rounds[0]?.roundId ?? '')
  const round = item.rounds.find((r) => r.roundId === selected) ?? item.rounds[0]

  if (round === undefined) return null

  return (
    <div className="page__section">
      {/* One round is not a choice; a switcher with a single option is chrome
          that implies there is history when there is none. */}
      {item.rounds.length > 1 && (
        <Segmented<string>
          value={round.roundId}
          onChange={setSelected}
          ariaLabel={t('code.roundPicker')}
          testidPrefix={`code-round-picker-${item.workItemId}`}
          options={item.rounds.map((r) => ({
            value: r.roundId,
            label: t('code.round', { seq: r.roundSeq }),
          }))}
        />
      )}

      <div className="page__header--row">
        <span>{t('code.round', { seq: round.roundSeq })}</span>
        <StatusChip kind={roundKind(round.status)}>{round.status}</StatusChip>
      </div>

      {/* T66 — say what is not shown, and name the number.
          A switcher listing three rounds on a merge request with eighty is a
          truncated list that looks complete; "showing recent rounds" is the
          phrasing that lets a reader believe they have seen everything, so this
          states the count instead. */}
      {item.roundsHidden > 0 && (
        <p className="page__section" data-testid={`code-rounds-hidden-${item.workItemId}`}>
          {t('code.roundsHidden', { count: item.roundsHidden })}{' '}
          {onShowMore !== undefined && (
            <button type="button" className="btn btn--xs" onClick={onShowMore}>
              {t('code.roundsShowMore')}
            </button>
          )}
        </p>
      )}

      {/* RFC-307 — the same picture the template view draws, with this round's
          state on it. Kept ABOVE the list rather than replacing it: the graph
          answers "where did this get to and what feeds what", the list carries
          the error text and the per-stage model calls, and neither does the
          other's job well. */}
      <RoundFlow item={item} round={round} />

      <ol data-testid={`code-stages-${round.roundId}`}>
        {round.stages.map((stage) => (
          <li key={stage.stageName}>
            <span>{stage.stageName}</span>{' '}
            <StatusChip kind={stageKind(stage.status)} size="sm">
              {stage.status}
            </StatusChip>
            {/* A failed stage without its reason forces a log dig. */}
            {stage.error !== null && <span> — {stage.error}</span>}
            {stage.kind === 'ai' && <StageAttempts roundId={round.roundId} stage={stage} />}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * RFC-307 — one round's progress, on the capability's own flow.
 *
 * Two things it deliberately does NOT do:
 *
 *   · it does not derive the picture from the round. Drawing only the stages
 *     that have rows would make a round in flight look like a three-step
 *     capability, and a round that failed at step two look like it was always
 *     going to stop there. The sequence comes from the contract and is always
 *     whole; only the colour is partial.
 *   · it does not quietly drop a stage it cannot place. A round that ran an
 *     older contract can name stages this picture has no node for, and hiding
 *     them would make an old round look like it skipped work it actually did —
 *     so the version mismatch is stated instead.
 */
function RoundFlow({ item, round }: { item: WorkItemRow; round: RoundRow }): ReactElement | null {
  const { t } = useTranslation()
  const graph = useCapabilityGraph(item.capability)

  const statuses = useMemo(() => {
    const out: Record<string, { status: StageRunStatus; error?: string | null }> = {}
    for (const stage of round.stages) {
      out[stage.stageName] = {
        status: asStageRunStatus(stage.status),
        error: stage.error,
      }
    }
    return out
  }, [round.stages])

  // Read through `readGraph` rather than testing for the `reason` arm: "not the
  // no-contract answer" is not the same as "a graph arrived", and reading
  // `.nodes` off anything else throws inside render.
  const answer = readGraph(graph.data)
  if (answer.kind !== 'graph') return null

  const drawn = new Set(answer.nodes.map((n) => n.name))
  const unplaceable = round.stages.filter((s) => !drawn.has(s.stageName))
  const stale = round.stageContractVer !== answer.stageContractVer

  return (
    <div className="page__section" data-testid={`code-flow-${round.roundId}`}>
      {(stale || unplaceable.length > 0) && (
        <p className="page__section" data-testid={`code-flow-stale-${round.roundId}`}>
          {t('capabilityFlow.staleContract', {
            ran: round.stageContractVer,
            current: answer.stageContractVer,
          })}
          {unplaceable.length > 0 && ` (${unplaceable.map((s) => s.stageName).join(', ')})`}
        </p>
      )}
      {/* Namespaced per round: the Flow tab stays mounted behind this one
          (RFC-169), and every round rendered here adds another whole sequence
          to the document. Unprefixed anchors would collide across all of them. */}
      <CapabilityFlow
        nodes={answer.nodes}
        edges={answer.edges}
        statuses={statuses}
        testidPrefix={`round-stage-${round.roundId}`}
      />
    </div>
  )
}

/**
 * The stage statuses the flow knows how to colour.
 *
 * Anything else lands on `pending` rather than being passed through: the card
 * reads `data-status` straight into a CSS selector, so an unrecognised value
 * would silently render as the neutral default anyway — this makes that the
 * stated behaviour instead of an accident.
 */
function asStageRunStatus(status: string): StageRunStatus {
  return status === 'running' ||
    status === 'done' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'skipped'
    ? status
    : 'pending'
}

/**
 * T55 — the model calls behind one AI stage.
 *
 * Collapsed by default and fetched only when opened. Two reasons, and the
 * second is the one that matters: attempts are the widest rows in the model, so
 * loading them with the list makes every visit pay for a level almost nobody
 * opens; and a stage that succeeded first time has nothing here worth the
 * vertical space.
 *
 * What it exists to answer is "why did this take three tries?" — which was
 * previously answerable only by opening a runtime transcript, if you knew that
 * was where to look.
 */
function StageAttempts({ roundId, stage }: { roundId: string; stage: StageRow }): ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const attempts = useQuery({
    queryKey: ['code-round-attempts', roundId],
    queryFn: () =>
      api.get<{ attempts: AttemptRow[] }>(
        `/api/code/rounds/${encodeURIComponent(roundId)}/attempts`,
      ),
    enabled: open,
  })

  const mine = (attempts.data?.attempts ?? []).filter((a) => a.stageName === stage.stageName)

  return (
    <div>
      <button
        type="button"
        className="btn btn--xs"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={`code-attempts-toggle-${roundId}-${stage.stageName}`}
      >
        {open ? t('code.attempts.hide') : t('code.attempts.show')}
      </button>

      {open && attempts.isPending && <LoadingState />}
      {open && attempts.isError && (
        <ErrorBanner error={attempts.error} onRetry={() => void attempts.refetch()} />
      )}
      {open && attempts.isSuccess && mine.length === 0 && (
        <EmptyState title={t('code.attempts.none')} />
      )}
      {open && mine.length > 0 && (
        <ol data-testid={`code-attempts-${roundId}-${stage.stageName}`}>
          {mine.map((a) => (
            <li key={a.attemptId}>
              {/* The two counters are shown separately because they mean
                  different things: a same-session retry told the model what was
                  wrong, a fresh-session re-run did not. One combined number
                  loses the distinction the retry design rests on. */}
              <span>
                {t('code.attempts.label', { rerun: a.rerunSeq + 1, attempt: a.attemptSeq + 1 })}
              </span>{' '}
              {a.shardKey !== '' && <span>· {a.shardKey} </span>}
              <StatusChip kind={attemptKind(a.status)} size="sm">
                {a.status}
              </StatusChip>
              {/* Verbatim: "named an undeclared port" and "the JSON did not
                  parse" lead to different fixes. */}
              {a.validationOutcome !== null && <span> — {a.validationOutcome}</span>}
              {a.nodeRunId !== null && (
                <a
                  className="btn btn--xs"
                  href={`/tasks?nodeRun=${encodeURIComponent(a.nodeRunId)}`}
                >
                  {t('code.attempts.openTask')}
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

interface AdoptionRow {
  capability: string
  published: number
  adopted: number
  quietFix: number
  disagreed: number
  outstanding: number
}

interface RunRow {
  capability: string
  rounds: number
  published: number
  failed: number
  awaiting: number
  incomplete: number
}

/**
 * T58 — what the platform has achieved, and what it cost.
 *
 * The four adoption columns are four on purpose. The backend refuses to compute
 * a single rate because `resolved` and `code changed` disagree in exactly the
 * informative cases, and this page must not quietly re-add the number the
 * projection declined to produce: a reviewer clearing their queue would read as
 * total success with nothing fixed.
 *
 * `disagreed` in particular is not a failure to hide. A person looked at a
 * finding and said no — that is the signal that tells a team to retune the
 * reviewer rather than mute it.
 */
function MetricsPanel(): ReactElement {
  const { t } = useTranslation()
  const metrics = useQuery({
    queryKey: ['code-metrics'],
    queryFn: () =>
      api.get<{ windowMs: number; adoption: AdoptionRow[]; runs: RunRow[] }>('/api/code/metrics'),
  })

  if (metrics.isPending) return <LoadingState />
  if (metrics.isError) {
    return <ErrorBanner error={metrics.error} onRetry={() => void metrics.refetch()} />
  }

  const adoption = metrics.data?.adoption ?? []
  const runs = metrics.data?.runs ?? []
  const days = Math.round((metrics.data?.windowMs ?? 0) / 86_400_000)

  if (adoption.length === 0 && runs.length === 0) {
    return <EmptyState title={t('code.metrics.empty')} description={t('code.metrics.emptyHint')} />
  }

  return (
    <section className="page__section">
      {/* Without the window, "12 published" means nothing and a reader who
          assumes all-time reads a quiet month as a broken capability. */}
      <p>{t('code.metrics.window', { days })}</p>

      <h3>{t('code.metrics.adoptionTitle')}</h3>
      {/* Six numeric columns overflow a narrow viewport, and a page that
          scrolls sideways as a whole loses the row labels first. `TableViewport`
          owns the scroll container and the overflow-edge affordance so the
          table scrolls inside itself and stays keyboard-reachable. */}
      <TableViewport label={t('code.metrics.adoptionTitle')}>
        <table data-testid="code-metrics-adoption">
          <thead>
            <tr>
              <th scope="col">{t('code.metrics.capability')}</th>
              <th scope="col">{t('code.metrics.published')}</th>
              <th scope="col">{t('code.metrics.adopted')}</th>
              <th scope="col">{t('code.metrics.quietFix')}</th>
              <th scope="col">{t('code.metrics.disagreed')}</th>
              <th scope="col">{t('code.metrics.outstanding')}</th>
            </tr>
          </thead>
          <tbody>
            {adoption.map((row) => (
              <tr key={row.capability} data-testid={`code-metrics-adoption-${row.capability}`}>
                <td>{row.capability}</td>
                <td>{row.published}</td>
                <td>{row.adopted}</td>
                <td>{row.quietFix}</td>
                <td>{row.disagreed}</td>
                <td>{row.outstanding}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableViewport>

      <h3>{t('code.metrics.runsTitle')}</h3>
      <TableViewport label={t('code.metrics.runsTitle')}>
        <table data-testid="code-metrics-runs">
          <thead>
            <tr>
              <th scope="col">{t('code.metrics.capability')}</th>
              <th scope="col">{t('code.metrics.rounds')}</th>
              <th scope="col">{t('code.metrics.roundsPublished')}</th>
              <th scope="col">{t('code.metrics.roundsFailed')}</th>
              <th scope="col">{t('code.metrics.roundsAwaiting')}</th>
              <th scope="col">{t('code.metrics.roundsIncomplete')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((row) => (
              <tr key={row.capability} data-testid={`code-metrics-runs-${row.capability}`}>
                <td>{row.capability}</td>
                <td>{row.rounds}</td>
                <td>{row.published}</td>
                <td>{row.failed}</td>
                <td>{row.awaiting}</td>
                <td>{row.incomplete}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableViewport>
    </section>
  )
}

/**
 * T63 — one capability change, applied to many repositories.
 *
 * The design rejected inheritance, so this is not "set it at the org level": it
 * is an explicit write to each named cell, and the matrix goes on answering
 * "why is this repository doing that?" locally. Which is exactly why preview
 * and revert are here rather than promised later — a bulk edit is a real edit,
 * a few hundred of them.
 *
 * Repository ids as chips rather than a server-side selector: a selector puts
 * "which repositories did this actually match?" back out of the author's reach,
 * and that question is what preview exists to answer.
 */
