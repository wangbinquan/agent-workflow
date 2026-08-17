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
import { createRoute, Link } from '@tanstack/react-router'
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { ChipsInput } from '@/components/ChipsInput'
import { Dialog } from '@/components/Dialog'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { ResourcePackageExportButton } from '@/components/ResourcePackageExportButton'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { Switch } from '@/components/Form'
import { TabPanels } from '@/components/split/TabPanels'
import { TabBar } from '@/components/TabBar'
import { CapabilityFlow, type StageRunStatus } from '@/components/code/CapabilityFlow'
import { readGraph, type CapabilityGraphResponse } from '@/components/code/graphResponse'
import { Route as RootRoute } from './__root'

// RFC-309 T14 — the standalone Flow tab is gone. It asked two questions before
// it could show anything (which capability, then which configuration), and both
// are answered by opening a template: `/code/templates/$id` IS the flow.
export type CodeTab = 'matrix' | 'activity' | 'metrics' | 'templates'

interface CodeSearch extends Record<string, unknown> {
  tab?: CodeTab
  repo?: string
}

function isCodeTab(value: unknown): value is CodeTab {
  return value === 'matrix' || value === 'activity' || value === 'metrics' || value === 'templates'
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
  templateId: string | null
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
  const tab: CodeTab = search.tab ?? 'matrix'

  return (
    <div className="page">
      <PageHeader title={t('code.title')} meta={t('code.subtitle')} />
      <TabBar<CodeTab>
        tabs={[
          { key: 'matrix', label: t('code.tab.matrix') },
          { key: 'activity', label: t('code.tab.activity') },
          { key: 'metrics', label: t('code.tab.metrics') },
          { key: 'templates', label: t('code.tab.templates') },
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
          { key: 'metrics', testid: 'code-panel-metrics', content: <MetricsPanel /> },
          { key: 'templates', testid: 'code-panel-templates', content: <TemplatesPanel /> },
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
  const [bulkOpen, setBulkOpen] = useState(false)
  const repoId = search.repo ?? ''

  const matrix = useQuery({
    queryKey: ['code-matrix', repoId],
    queryFn: () => api.get<{ rows: MatrixRow[] }>(`/api/code/matrix/${encodeURIComponent(repoId)}`),
    // Nothing to ask for without a repository; an empty request would 404 on a
    // path with an empty segment and read as a broken page.
    enabled: repoId !== '',
  })

  // The templates a capability can be pointed at. Without this the page could
  // switch a capability ON and never give it one — which is what it did: the
  // cell then sits `misconfigured` forever with no way forward from the UI.
  const templates = useQuery({
    queryKey: ['capability-templates'],
    queryFn: () => api.get<TemplateRow[]>('/api/capability-templates'),
  })

  const toggle = useMutation({
    mutationFn: (row: { capability: string; enabled: boolean; templateId?: string | null }) =>
      api.put<{ row: MatrixRow }>(`/api/code/matrix/${encodeURIComponent(repoId)}`, row),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['code-matrix', repoId] }),
  })

  // A template belongs to exactly one capability. Showing every template would
  // invite pointing `ci-fix` at a review template, which the round would only
  // discover at its first AI stage.
  //
  // RFC-309 makes this a direct field read; it used to be a join through the
  // framework, because the capability lived on the layer the binding pointed at
  // rather than on the binding itself.
  const templatesFor = (capability: string): TemplateRow[] =>
    (templates.data ?? []).filter((t) => t.capability === capability)

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
        {/* T63 — the same change across many repositories. Beside the single-repo
            form on purpose: it is the same edit, and separating them into
            different places invites two ways to configure a cell. */}
        <button
          type="button"
          className="btn btn--sm"
          data-testid="code-bulk-open"
          onClick={() => setBulkOpen(true)}
        >
          {t('code.bulk.open')}
        </button>
      </form>

      <BulkEnableDialog open={bulkOpen} onClose={() => setBulkOpen(false)} />

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
                <strong>{t(`code.capability.${row.capability}`)}</strong>
                <StatusChip kind={readinessKind(row.readiness)}>
                  {t(`code.readiness.${row.readiness}`)}
                </StatusChip>
                <Switch
                  checked={row.enabled}
                  onChange={(enabled) =>
                    toggle.mutate({
                      capability: row.capability,
                      enabled,
                      // Carried on every write: the server takes the cell as
                      // sent, so omitting it on a toggle would silently clear a
                      // template somebody had chosen.
                      templateId: row.templateId,
                    })
                  }
                  label={t('code.enabled')}
                  data-testid={`code-toggle-${row.capability}`}
                />
              </div>

              {/* Which template this repository runs. Empty is not a neutral
                  default — a capability with no template cannot become `ready`,
                  so the empty option says so rather than looking like a
                  legitimate choice. */}
              <Field label={t('code.templateLabel')} hint={t('code.templateHint')}>
                <Select<string>
                  value={row.templateId ?? ''}
                  options={[
                    { value: '', label: t('code.templateNone') },
                    ...templatesFor(row.capability).map((b) => ({ value: b.id, label: b.name })),
                  ]}
                  onChange={(templateId) =>
                    toggle.mutate({
                      capability: row.capability,
                      enabled: row.enabled,
                      templateId: templateId === '' ? null : templateId,
                    })
                  }
                  ariaLabel={t('code.templateLabel')}
                  data-testid={`code-template-pick-${row.capability}`}
                />
              </Field>

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

interface UpstreamLinkWire {
  upstreamId: string
  upstreamVersion: number
  baseDigest: string
}

interface TemplateRow {
  id: string
  name: string
  description: string | null
  capability: string
  scriptsRedacted: boolean
  paramSchema: Array<{ name: string; kind: string; required?: boolean }>
  paramDefaults: Record<string, unknown>
  agentBySlot: Record<string, string>
  params: Record<string, unknown>
  stageContractVer: number
  ownerUserId: string | null
  visibility: 'private' | 'public'
  builtin: boolean
  aclRevision: number
  upstream: UpstreamLinkWire | null
  updatedAt: number
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
function BulkEnableDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // Self-contained: the dialog asks for what it renders rather than having the
  // matrix panel thread three lists through. Both are cached by the same query
  // keys the rest of the page uses, so this costs nothing extra.
  const capabilities = useQuery({
    queryKey: ['code-capabilities'],
    queryFn: () => api.get<{ items: CapabilityCatalogRow[] }>('/api/code/capabilities'),
  })
  const templates = useQuery({
    queryKey: ['capability-templates'],
    queryFn: () => api.get<TemplateRow[]>('/api/capability-templates'),
  })
  const [repoIds, setRepoIds] = useState<string[]>([])
  const [capability, setCapability] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [preview, setPreview] = useState<BulkPreviewResponse | null>(null)
  const [undo, setUndo] = useState<readonly CellChangeRow[] | null>(null)

  const call = useMutation({
    mutationFn: (input: { preview: boolean; changes?: readonly CellChangeRow[] }) =>
      api.post<BulkPreviewResponse>('/api/code/matrix/bulk', {
        repoIds: input.changes?.map((c) => c.repoId) ?? repoIds,
        capability,
        // A revert re-applies the recorded `before`; every change in one batch
        // shares it, so the first entry carries the whole answer.
        enabled: input.changes?.[0]?.after.enabled ?? enabled,
        templateId: input.changes?.[0]?.after.templateId ?? (templateId === '' ? null : templateId),
        preview: input.preview,
      }),
    onSuccess: (data, input) => {
      setPreview(data)
      if (!input.preview) {
        setUndo(data.undo ?? null)
        void queryClient.invalidateQueries({ queryKey: ['code-matrix'] })
      }
    },
  })

  const close = (): void => {
    setPreview(null)
    setUndo(null)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('code.bulk.title')}
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={close}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="code-bulk-preview"
            disabled={repoIds.length === 0 || capability === '' || call.isPending}
            onClick={() => call.mutate({ preview: true })}
          >
            {t('code.bulk.preview')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            data-testid="code-bulk-apply"
            // Apply is reachable only AFTER a preview: the author has to have
            // been shown the counts before several hundred cells move.
            disabled={preview === null || call.isPending}
            onClick={() => call.mutate({ preview: false })}
          >
            {t('code.bulk.apply')}
          </button>
        </>
      }
    >
      <Field label={t('code.bulk.repos')} hint={t('code.bulk.reposHint')}>
        <ChipsInput value={repoIds} onChange={setRepoIds} testidPrefix="code-bulk-repo" />
      </Field>
      <Field label={t('code.bulk.capability')} required>
        <Select
          value={capability}
          onChange={setCapability}
          options={(capabilities.data?.items ?? []).map((c) => ({
            value: c.capability,
            label: c.capability,
          }))}
          ariaLabel={t('code.bulk.capability')}
        />
      </Field>
      <Field label={t('code.bulk.template')}>
        <Select
          value={templateId}
          onChange={setTemplateId}
          options={[
            { value: '', label: t('code.templateNone') },
            // Filtered to the chosen capability. Offering every template
            // invites pointing `ci-fix` at a review template — which the round
            // would only discover at its first AI stage, on somebody's merge
            // request.
            // RFC-309 — a direct filter; the capability is a field of the
            // template now rather than of the framework it used to point at.
            ...(templates.data ?? [])
              .filter((t) => capability === '' || t.capability === capability)
              .map((t) => ({ value: t.id, label: t.name })),
          ]}
          ariaLabel={t('code.bulk.template')}
        />
      </Field>
      <Switch checked={enabled} onChange={setEnabled} label={t('code.bulk.enabled')} />

      {call.isError && <ErrorBanner error={call.error} />}

      {preview !== null && (
        <p data-testid="code-bulk-summary">
          {/* The counts, separately. "This will change 12" reads very
              differently from "matched 200, 188 already set" — and the second
              is what tells the author their list is wider than they meant. */}
          {preview.preview.message}
          {preview.failures.length > 0 && (
            <>
              {' '}
              <StatusChip kind="danger" size="sm">
                {t('code.bulk.failures', { count: preview.failures.length })}
              </StatusChip>
            </>
          )}
        </p>
      )}

      {undo !== null && undo.length > 0 && (
        <button
          type="button"
          className="btn btn--sm btn--danger"
          data-testid="code-bulk-undo"
          onClick={() => call.mutate({ preview: false, changes: undo })}
        >
          {t('code.bulk.undo', { count: undo.length })}
        </button>
      )}
    </Dialog>
  )
}

interface CellChangeRow {
  repoId: string
  capability: string
  before: { enabled: boolean; templateId: string | null } | null
  after: { enabled: boolean; templateId: string | null }
}

interface BulkPreviewResponse {
  preview: {
    creates: CellChangeRow[]
    updates: CellChangeRow[]
    noOps: CellChangeRow[]
    message: string
  }
  undo?: readonly CellChangeRow[]
  failures: ReadonlyArray<{ repoId: string; message: string }>
}

/**
 * T57(a) → RFC-309 — the template list.
 *
 * This used to be TWO lists, and the comment here argued for keeping them
 * apart: a framework carried scripts that run as the daemon, a binding
 * carried none, and a merged list with a "layer" column would invite exactly
 * the mental model the split existed to prevent.
 *
 * The user overturned it: 「不需要区分组织模版和小组模版了，就是一套模版，
 * 大家可以复制修改就行了」. What replaced the split is not a weaker rule but a
 * narrower one — the daemon-grade fields carry their own `scripts:author`
 * check, so the list can be one without the permission being one.
 *
 * Copy is the primary action, and after the merge it is how a team gets a
 * template at all: there is no shared department row to point at any more, so
 * "everyone runs the same scripts" is now "everyone copied from the same place
 * and can see when it moves" (T64's upstream link).
 */
function TemplatesPanel(): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const templates = useQuery({
    queryKey: ['capability-templates'],
    queryFn: () => api.get<TemplateRow[]>('/api/capability-templates'),
  })

  const catalog = useQuery({
    queryKey: ['code-capabilities'],
    queryFn: () => api.get<{ items: CapabilityCatalogRow[] }>('/api/code/capabilities'),
  })
  const [newTemplate, setNewTemplate] = useState(false)

  const copy = useMutation({
    mutationFn: (input: { id: string }) =>
      api.post<TemplateRow>(`/api/capability-templates/${encodeURIComponent(input.id)}/copy`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['capability-templates'] }),
  })

  if (templates.isPending) return <LoadingState />
  if (templates.isError) {
    return <ErrorBanner error={templates.error} onRetry={() => void templates.refetch()} />
  }

  return (
    <section className="page__section">
      <NewTemplateDialog
        open={newTemplate}
        onClose={() => setNewTemplate(false)}
        capabilities={catalog.data?.items ?? []}
      />

      <div className="page__header--row">
        <h3>{t('code.templates.title')}</h3>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => setNewTemplate(true)}
          data-testid="code-new-template"
        >
          {t('code.templates.newTemplate')}
        </button>
      </div>
      <p>{t('code.templates.hint')}</p>
      {(templates.data?.length ?? 0) === 0 ? (
        <EmptyState title={t('code.templates.none')} />
      ) : (
        <ul data-testid="code-templates">
          {templates.data?.map((row) => (
            <li key={row.id} className="card" data-testid={`code-template-${row.id}`}>
              <div className="page__header--row">
                {/* RFC-309 T14 — the name IS the way in. The row used to be a
                    read-only summary of JSON entered elsewhere; opening it now
                    shows the sequence this template runs. */}
                <Link
                  to="/code/templates/$id"
                  params={{ id: row.id }}
                  data-testid={`code-template-open-${row.id}`}
                >
                  <strong>{row.name}</strong>
                </Link>
                <StatusChip kind="info" size="sm">
                  {row.capability}
                </StatusChip>
                {row.builtin && (
                  <StatusChip kind="neutral" size="sm">
                    {t('code.templates.builtin')}
                  </StatusChip>
                )}
                {/* Said out loud rather than left as an empty section. A reader
                    who sees no scripts and no explanation concludes the
                    template is broken. */}
                {row.scriptsRedacted && (
                  <StatusChip kind="neutral" size="sm">
                    {t('code.templates.scriptsHidden')}
                  </StatusChip>
                )}
                {/* T57(c) — the upstream state. Shown only for a copy: a
                    template nobody copied has no origin, and a badge saying so
                    on every original would be noise on the common case.
                    RFC-309 makes this the normal case rather than the rare one
                    — copying is now how a team gets a template at all. */}
                {row.upstream !== null && (
                  <StatusChip kind="neutral" size="sm">
                    {t('code.templates.copiedFrom')}
                  </StatusChip>
                )}
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => copy.mutate({ id: row.id })}
                  data-testid={`code-template-copy-${row.id}`}
                >
                  {t('code.templates.copy')}
                </button>
                {/* T57(b) — export. The fence is BOTH values or nothing: an
                    empty fence is not "no protection", it is a 422, and a
                    caller who believes they have what-you-see-is-what-you-get
                    and silently has none is worse off than one who gets an
                    error. */}
                <ResourcePackageExportButton
                  type="capability_template"
                  id={row.id}
                  name={row.name}
                  fence={{
                    expectedUpdatedAt: row.updatedAt,
                    expectedAclRevision: row.aclRevision,
                  }}
                  variant="action"
                />
              </div>
              {row.description !== null && <p>{row.description}</p>}
              {row.paramSchema.length > 0 && (
                <p>
                  {t('code.templates.params', {
                    names: row.paramSchema.map((p) => p.name).join(', '),
                  })}
                </p>
              )}
              {Object.keys(row.agentBySlot).length > 0 && (
                <p>
                  {t('code.templates.slots', {
                    pairs: Object.entries(row.agentBySlot)
                      .map(([slot, agent]) => `${slot} → ${agent}`)
                      .join(', '),
                  })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {copy.isError && <ErrorBanner error={copy.error} />}
    </section>
  )
}

/** What the catalog endpoint says a binding must fill in for a capability. */
interface CapabilityCatalogRow {
  capability: string
  agentSlots: string[]
}

interface AgentRow {
  id: string
  name: string
}

/**
 * Create a template — name, capability, and which agent fills each AI slot.
 *
 * RFC-309 merged the two creation dialogs this replaced. Scripts are still
 * deliberately NOT collected here: they run as the daemon, so authoring one
 * needs `scripts:author` and a proper editor, and a team that only wants
 * "review my merge requests" should never be asked for a script to get started.
 * A template with no scripts is valid for every capability whose contract has
 * no script stage — which today is all of them but `ci-fix`.
 *
 * The slots come from the catalog rather than a list written here: a capability
 * that gains a slot must show it without a frontend change, which is the whole
 * reason that endpoint derives from the stage contracts.
 */
function NewTemplateDialog(props: {
  open: boolean
  onClose: () => void
  capabilities: CapabilityCatalogRow[]
}): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [capability, setCapability] = useState('')
  const [agentBySlot, setAgentBySlot] = useState<Record<string, string>>({})

  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<AgentRow[]>('/api/agents'),
    enabled: props.open,
  })

  const slots = props.capabilities.find((c) => c.capability === capability)?.agentSlots ?? []

  const create = useMutation({
    mutationFn: () =>
      api.post<TemplateRow>('/api/capability-templates', {
        name,
        capability,
        scripts: {},
        hooks: [],
        paramSchema: [],
        paramDefaults: {},
        agentBySlot,
        promptBySlot: {},
        params: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['capability-templates'] })
      setName('')
      setCapability('')
      setAgentBySlot({})
      props.onClose()
    },
  })

  // Every slot filled, not just some: a round whose second AI stage has no
  // agent fails halfway, after it has already taken the merge-request lease.
  const ready = name.trim() !== '' && capability !== '' && slots.every((slot) => agentBySlot[slot])

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('code.templates.newTemplate')}
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={!ready || create.isPending}
            onClick={() => create.mutate()}
            data-testid="code-template-create"
          >
            {t('code.templates.createAction')}
          </button>
        </>
      }
    >
      <Field label={t('code.templates.nameLabel')} required>
        <TextInput value={name} onChange={setName} data-testid="code-template-name" />
      </Field>
      <Field label={t('code.templates.capabilityLabel')} required>
        <Select<string>
          value={capability}
          options={props.capabilities.map((row) => ({
            value: row.capability,
            label: t(`code.capability.${row.capability}`),
          }))}
          onChange={(next) => {
            setCapability(next)
            // Slots belong to the capability; keeping the old picks would carry
            // a reviewer into a ci-fix template under a slot name that no
            // longer exists.
            setAgentBySlot({})
          }}
          placeholder={t('code.templates.capabilityLabel')}
          ariaLabel={t('code.templates.capabilityLabel')}
          data-testid="code-template-capability"
        />
      </Field>
      {slots.map((slot) => (
        <Field key={slot} label={t('code.templates.slotLabel', { slot })} required>
          <Select<string>
            value={agentBySlot[slot] ?? ''}
            options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
            onChange={(agentId) => setAgentBySlot((prev) => ({ ...prev, [slot]: agentId }))}
            placeholder={t('code.templates.slotLabel', { slot })}
            ariaLabel={t('code.templates.slotLabel', { slot })}
            data-testid={`code-template-slot-${slot}`}
          />
        </Field>
      ))}
      {/* RFC-309 T15 / AC-5 — the capability's own sequence, read-only, HERE.
          RFC-307 promised the structure is viewable before anything is
          configured, and deleting the Flow tab would have taken that away: with
          no templates there would be nothing to open. This is also where it is
          most useful — it names the steps whose slots the fields above fill. */}
      {capability !== '' && <CapabilityStructurePreview capability={capability} />}
      {create.isError && <ErrorBanner error={create.error} />}
    </Dialog>
  )
}

/**
 * A capability's stage sequence, drawn read-only.
 *
 * RFC-307 AC-1 says the structure must be viewable with nothing configured, and
 * that acceptance survives RFC-309 removing the Flow tab — this is where it now
 * lives. Read-only on purpose: there is no template yet to write a change to,
 * and offering an editor that saves nowhere is worse than offering none.
 */
function CapabilityStructurePreview({ capability }: { capability: string }): ReactElement {
  const { t } = useTranslation()
  const graph = useCapabilityGraph(capability)
  const answer = readGraph(graph.data)
  if (answer.kind !== 'graph') return <></>
  return (
    <div className="page__section" data-testid="code-capability-structure">
      <p>{t('code.flow.hint')}</p>
      <CapabilityFlow nodes={answer.nodes} edges={answer.edges} height={320} />
    </div>
  )
}
