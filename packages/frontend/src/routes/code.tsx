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
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
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
import { Route as RootRoute } from './__root'

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
  const repoId = search.repo ?? ''

  const matrix = useQuery({
    queryKey: ['code-matrix', repoId],
    queryFn: () => api.get<{ rows: MatrixRow[] }>(`/api/code/matrix/${encodeURIComponent(repoId)}`),
    // Nothing to ask for without a repository; an empty request would 404 on a
    // path with an empty segment and read as a broken page.
    enabled: repoId !== '',
  })

  // The bindings a capability can be pointed at. Without this the page could
  // switch a capability ON and never give it a binding — which is what it did:
  // the cell then sits `misconfigured` forever with no way forward from the UI.
  const bindings = useQuery({
    queryKey: ['capability-bindings'],
    queryFn: () => api.get<BindingRow[]>('/api/capability-bindings'),
  })
  const frameworks = useQuery({
    queryKey: ['capability-frameworks'],
    queryFn: () => api.get<FrameworkRow[]>('/api/capability-frameworks'),
  })

  const toggle = useMutation({
    mutationFn: (row: { capability: string; enabled: boolean; bindingId?: string | null }) =>
      api.put<{ row: MatrixRow }>(`/api/code/matrix/${encodeURIComponent(repoId)}`, row),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['code-matrix', repoId] }),
  })

  // A binding belongs to exactly one capability, through its framework. Showing
  // every binding would invite pointing `ci-fix` at a review binding, which the
  // round would only discover at its first AI stage.
  const capabilityOfFramework = new Map(
    (frameworks.data ?? []).map((f) => [f.id, f.capability] as const),
  )
  const bindingsFor = (capability: string): BindingRow[] =>
    (bindings.data ?? []).filter((b) => capabilityOfFramework.get(b.frameworkId) === capability)

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
                      // binding somebody had chosen.
                      bindingId: row.bindingId,
                    })
                  }
                  label={t('code.enabled')}
                  data-testid={`code-toggle-${row.capability}`}
                />
              </div>

              {/* Which configuration this repository runs. Empty is not a
                  neutral default — a capability with no binding cannot become
                  `ready`, so the empty option says so rather than looking like
                  a legitimate choice. */}
              <Field label={t('code.bindingLabel')} hint={t('code.bindingHint')}>
                <Select<string>
                  value={row.bindingId ?? ''}
                  options={[
                    { value: '', label: t('code.bindingNone') },
                    ...bindingsFor(row.capability).map((b) => ({ value: b.id, label: b.name })),
                  ]}
                  onChange={(bindingId) =>
                    toggle.mutate({
                      capability: row.capability,
                      enabled: row.enabled,
                      bindingId: bindingId === '' ? null : bindingId,
                    })
                  }
                  ariaLabel={t('code.bindingLabel')}
                  data-testid={`code-binding-${row.capability}`}
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
            <WorkItemRounds item={item} />
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
function WorkItemRounds({ item }: { item: WorkItemRow }): ReactElement | null {
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

interface FrameworkRow {
  id: string
  name: string
  description: string | null
  capability: string
  scriptsRedacted: boolean
  paramSchema: Array<{ name: string; kind: string; required?: boolean }>
  paramDefaults: Record<string, unknown>
  stageContractVer: number
  ownerUserId: string | null
  visibility: 'private' | 'public'
  builtin: boolean
  aclRevision: number
  upstream: UpstreamLinkWire | null
  updatedAt: number
}

interface BindingRow {
  id: string
  name: string
  description: string | null
  frameworkId: string
  agentBySlot: Record<string, string>
  params: Record<string, unknown>
  ownerUserId: string | null
  visibility: 'private' | 'public'
  builtin: boolean
  aclRevision: number
  upstream: UpstreamLinkWire | null
  updatedAt: number
}

/**
 * T57(a) — the two template layers, listed and copyable.
 *
 * Two lists rather than one, because they are not two kinds of the same thing:
 * a framework carries scripts that run as the daemon, a binding deliberately
 * carries none, and that difference is what decides who may edit which. A
 * single merged list with a "layer" column would invite exactly the mental
 * model the split exists to prevent.
 *
 * Copy is the primary action here. Editing a framework needs `scripts:author`
 * and a script editor; starting from one that works and adjusting the binding
 * is what a team actually does, and it needs neither.
 */
function TemplatesPanel(): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const frameworks = useQuery({
    queryKey: ['capability-frameworks'],
    queryFn: () => api.get<FrameworkRow[]>('/api/capability-frameworks'),
  })
  const bindings = useQuery({
    queryKey: ['capability-bindings'],
    queryFn: () => api.get<BindingRow[]>('/api/capability-bindings'),
  })

  const catalog = useQuery({
    queryKey: ['code-capabilities'],
    queryFn: () => api.get<{ items: CapabilityCatalogRow[] }>('/api/code/capabilities'),
  })
  const [newFramework, setNewFramework] = useState(false)
  const [newBinding, setNewBinding] = useState(false)

  const copy = useMutation({
    mutationFn: (input: { kind: 'frameworks' | 'bindings'; id: string }) =>
      api.post<FrameworkRow | BindingRow>(
        `/api/capability-${input.kind}/${encodeURIComponent(input.id)}/copy`,
        {},
      ),
    onSuccess: (_row, input) =>
      void queryClient.invalidateQueries({
        queryKey: [input.kind === 'frameworks' ? 'capability-frameworks' : 'capability-bindings'],
      }),
  })

  if (frameworks.isPending || bindings.isPending) return <LoadingState />
  if (frameworks.isError) {
    return <ErrorBanner error={frameworks.error} onRetry={() => void frameworks.refetch()} />
  }
  if (bindings.isError) {
    return <ErrorBanner error={bindings.error} onRetry={() => void bindings.refetch()} />
  }

  const frameworkNames = new Map((frameworks.data ?? []).map((f) => [f.id, f.name]))

  return (
    <section className="page__section">
      <NewFrameworkDialog
        open={newFramework}
        onClose={() => setNewFramework(false)}
        capabilities={catalog.data?.items ?? []}
      />
      <NewBindingDialog
        open={newBinding}
        onClose={() => setNewBinding(false)}
        frameworks={frameworks.data ?? []}
        capabilities={catalog.data?.items ?? []}
      />

      <div className="page__header--row">
        <h3>{t('code.templates.frameworksTitle')}</h3>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => setNewFramework(true)}
          data-testid="code-new-framework"
        >
          {t('code.templates.newFramework')}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setNewBinding(true)}
          disabled={(frameworks.data?.length ?? 0) === 0}
          data-testid="code-new-binding"
        >
          {t('code.templates.newBinding')}
        </button>
      </div>
      <p>{t('code.templates.frameworksHint')}</p>
      {(frameworks.data?.length ?? 0) === 0 ? (
        <EmptyState title={t('code.templates.noFrameworks')} />
      ) : (
        <ul data-testid="code-frameworks">
          {frameworks.data?.map((row) => (
            <li key={row.id} className="card" data-testid={`code-framework-${row.id}`}>
              <div className="page__header--row">
                <strong>{row.name}</strong>
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
                    on every original would be noise on the common case. */}
                {row.upstream !== null && (
                  <StatusChip kind="neutral" size="sm">
                    {t('code.templates.copiedFrom')}
                  </StatusChip>
                )}
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => copy.mutate({ kind: 'frameworks', id: row.id })}
                  data-testid={`code-framework-copy-${row.id}`}
                >
                  {t('code.templates.copy')}
                </button>
                {/* T57(b) — export. The fence is BOTH values or nothing: an
                    empty fence is not "no protection", it is a 422, and a
                    caller who believes they have what-you-see-is-what-you-get
                    and silently has none is worse off than one who gets an
                    error. */}
                <ResourcePackageExportButton
                  type="capability_framework"
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
            </li>
          ))}
        </ul>
      )}

      <h3>{t('code.templates.bindingsTitle')}</h3>
      <p>{t('code.templates.bindingsHint')}</p>
      {(bindings.data?.length ?? 0) === 0 ? (
        <EmptyState title={t('code.templates.noBindings')} />
      ) : (
        <ul data-testid="code-bindings">
          {bindings.data?.map((row) => (
            <li key={row.id} className="card" data-testid={`code-binding-${row.id}`}>
              <div className="page__header--row">
                <strong>{row.name}</strong>
                {/* The framework NAME, not its id: a binding is understood by
                    what it points at, and an opaque ULID means opening another
                    page to find out. */}
                <StatusChip kind="info" size="sm">
                  {frameworkNames.get(row.frameworkId) ?? t('code.templates.frameworkMissing')}
                </StatusChip>
                {row.upstream !== null && (
                  <StatusChip kind="neutral" size="sm">
                    {t('code.templates.copiedFrom')}
                  </StatusChip>
                )}
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => copy.mutate({ kind: 'bindings', id: row.id })}
                  data-testid={`code-binding-copy-${row.id}`}
                >
                  {t('code.templates.copy')}
                </button>
                <ResourcePackageExportButton
                  type="capability_binding"
                  id={row.id}
                  name={row.name}
                  fence={{
                    expectedUpdatedAt: row.updatedAt,
                    expectedAclRevision: row.aclRevision,
                  }}
                  variant="action"
                />
              </div>
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
 * Create a framework (department layer) — name + which capability it drives.
 *
 * Scripts are deliberately NOT collected here. They run as the daemon, so
 * authoring one needs `scripts:author` and a proper editor; a team that only
 * needs "review my merge requests" should never be asked for a script to get
 * started. A framework with no scripts is valid for every capability whose
 * contract has no script stage — which today is all of them but `ci-fix`.
 */
function NewFrameworkDialog(props: {
  open: boolean
  onClose: () => void
  capabilities: CapabilityCatalogRow[]
}): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [capability, setCapability] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api.post<FrameworkRow>('/api/capability-frameworks', {
        name,
        capability,
        scripts: {},
        hooks: [],
        paramSchema: [],
        paramDefaults: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['capability-frameworks'] })
      setName('')
      setCapability('')
      props.onClose()
    },
  })

  const ready = name.trim() !== '' && capability !== ''

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('code.templates.newFramework')}
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
            data-testid="code-framework-create"
          >
            {t('code.templates.createAction')}
          </button>
        </>
      }
    >
      <Field label={t('code.templates.nameLabel')} required>
        <TextInput value={name} onChange={setName} data-testid="code-framework-name" />
      </Field>
      <Field label={t('code.templates.capabilityLabel')} required>
        <Select<string>
          value={capability}
          options={props.capabilities.map((row) => ({
            value: row.capability,
            label: t(`code.capability.${row.capability}`),
          }))}
          onChange={setCapability}
          placeholder={t('code.templates.capabilityLabel')}
          ariaLabel={t('code.templates.capabilityLabel')}
          data-testid="code-framework-capability"
        />
      </Field>
      {create.isError && <ErrorBanner error={create.error} />}
    </Dialog>
  )
}

/**
 * Create a binding (group layer) — which agent fills each of the capability's
 * AI slots.
 *
 * The slots come from the catalog rather than a list written here: a capability
 * that gains a slot must show it without a frontend change, which is the whole
 * reason that endpoint derives from the stage contracts.
 */
function NewBindingDialog(props: {
  open: boolean
  onClose: () => void
  frameworks: FrameworkRow[]
  capabilities: CapabilityCatalogRow[]
}): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [frameworkId, setFrameworkId] = useState('')
  const [agentBySlot, setAgentBySlot] = useState<Record<string, string>>({})

  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<AgentRow[]>('/api/agents'),
    enabled: props.open,
  })

  const capabilityOf = props.frameworks.find((f) => f.id === frameworkId)?.capability ?? ''
  const slots = props.capabilities.find((c) => c.capability === capabilityOf)?.agentSlots ?? []

  const create = useMutation({
    mutationFn: () =>
      api.post<BindingRow>('/api/capability-bindings', {
        name,
        frameworkId,
        agentBySlot,
        promptBySlot: {},
        params: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['capability-bindings'] })
      setName('')
      setFrameworkId('')
      setAgentBySlot({})
      props.onClose()
    },
  })

  // Every slot filled, not just some: a round whose second AI stage has no
  // agent fails halfway, after it has already taken the merge-request lease.
  const ready = name.trim() !== '' && frameworkId !== '' && slots.every((s) => agentBySlot[s])

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('code.templates.newBinding')}
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
            data-testid="code-binding-create"
          >
            {t('code.templates.createAction')}
          </button>
        </>
      }
    >
      <Field label={t('code.templates.nameLabel')} required>
        <TextInput value={name} onChange={setName} data-testid="code-binding-name" />
      </Field>
      <Field label={t('code.templates.frameworkLabel')} required>
        <Select<string>
          value={frameworkId}
          options={props.frameworks.map((f) => ({
            value: f.id,
            label: `${f.name} · ${t(`code.capability.${f.capability}`)}`,
          }))}
          onChange={(id) => {
            setFrameworkId(id)
            // Slots belong to the capability; keeping the old picks would carry
            // a reviewer into a ci-fix binding under a slot name that no longer
            // exists.
            setAgentBySlot({})
          }}
          placeholder={t('code.templates.frameworkLabel')}
          ariaLabel={t('code.templates.frameworkLabel')}
          data-testid="code-binding-framework"
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
            data-testid={`code-binding-slot-${slot}`}
          />
        </Field>
      ))}
      {create.isError && <ErrorBanner error={create.error} />}
    </Dialog>
  )
}
