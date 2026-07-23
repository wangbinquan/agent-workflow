// Right-side drawer that opens when the user picks a node on the task
// status canvas (P-2-13). Tabs:
//
//   - Session — full conversation flow for the picked run (took over the
//               old read-only Prompt tab; prompt text lives in the flow).
//   - Events  — latest 500 events with kind filter chips; refetches on
//               /ws/tasks/:id node.event invalidations.
//   - Output  — port → value cards (copyable).
//   - Stats   — start/finish/duration, exit code, token usage.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { copyText } from '@/lib/clipboard'
import { describeTaskFailure } from '@/lib/task-failure'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NodeRun, NodeRunEventsResponse, NodeRunOutput, Task } from '@agent-workflow/shared'
import { NODE_EVENT_KIND } from '@agent-workflow/shared'
import { useNavigate } from '@tanstack/react-router'
import { NodeDependencyTreeSection } from './agents/NodeDependencyTreeSection'
import { LoadingState } from './LoadingState'
import { SessionTab } from './node-session/SessionTab'
import { StatusChip } from './StatusChip'
import { TabBar, tabDomIds, type TabDef } from './TabBar'
import { api } from '@/api/client'
import {
  clarifyRoundForRun,
  displayRetryForRun,
  formatIterationLabel,
  nodeRunHistory,
} from '@/lib/node-history'
import {
  classifyCanceled,
  displayNoderunStatusKey,
  nodeRunStatusToKind,
  supersededDecision,
} from '@/lib/noderun-status'
import { reviewRunDisplay } from '@/lib/reviewRunDisplay'
import { parseRfc026Event } from '@/lib/rfc026-events'
import { parseRfc031Event } from '@/lib/rfc031-events'
import { ErrorBanner } from '@/components/ErrorBanner'

interface Props {
  taskId: string
  /** Used to gate the Retry button — the API rejects retry on a running task. */
  taskStatus?: Task['status']
  nodeRunId: string | null
  /**
   * RFC-011: the workflow node id this drawer is currently anchored at.
   * Needed so the Session tab can list every historical node_run for the
   * same node (retries, iterations, fan-out shards, review re-runs).
   * Derived from `runs.find(r.id === nodeRunId).nodeId` upstream but passed
   * explicitly to keep the helper / drawer separation crisp.
   */
  nodeId: string | null
  /**
   * RFC-011: the workflow definition kind (agent-single / input / output /
   * wrapper-* / review …). The Session tab uses it to decide whether this
   * node kind has an own opencode session (attempts switcher) or renders
   * the "N/A" placeholder. Looked up against the task's workflowSnapshot
   * in tasks.detail.tsx.
   */
  workflowNodeKind: string | null
  /**
   * RFC-022 / RFC-223: the primary immutable agent id for agent-single nodes,
   * resolved from the workflow snapshot. Stats tab uses it to fetch the
   * dependsOn closure tree. Null for non-agent kinds — tree section hides.
   */
  agentId: string | null
  runs: NodeRun[]
  outputs: NodeRunOutput[]
  onClose: () => void
  /** Allows the drawer to navigate between sibling/child runs. */
  onSelectRun?: (nodeRunId: string) => void
}

type Tab = 'session' | 'events' | 'output' | 'stats'

const NODE_DETAIL_DRAWER_TAB_PREFIX = 'node-detail-drawer'
const NODE_DETAIL_DRAWER_HEADING_ID = `${NODE_DETAIL_DRAWER_TAB_PREFIX}-heading`

export function NodeDetailDrawer({
  taskId,
  taskStatus,
  nodeRunId,
  nodeId,
  workflowNodeKind,
  agentId,
  runs,
  outputs,
  onClose,
  onSelectRun,
}: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('session')
  const [cascade, setCascade] = useState(true)
  const qc = useQueryClient()
  const run = nodeRunId === null ? undefined : runs.find((candidate) => candidate.id === nodeRunId)
  const nodeOutputs =
    nodeRunId === null ? [] : outputs.filter((output) => output.nodeRunId === nodeRunId)
  const eventsQuery = useQuery<NodeRunEventsResponse>({
    queryKey: ['tasks', taskId, 'node-runs', nodeRunId, 'events'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/node-runs/${encodeURIComponent(nodeRunId ?? '')}/events`,
        undefined,
        signal,
      ),
    enabled: run !== undefined,
  })

  const retry = useMutation({
    mutationFn: () => {
      if (nodeRunId === null) throw new Error('no nodeRunId')
      const qs = new URLSearchParams({ cascade: cascade ? 'true' : 'false' }).toString()
      return api.post<Task>(
        `/api/tasks/${encodeURIComponent(taskId)}/nodes/${encodeURIComponent(nodeRunId)}/retry?${qs}`,
      )
    },
    onSuccess: (tk) => {
      qc.setQueryData(['tasks', taskId], tk)
      void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  if (nodeRunId === null) return null
  if (run === undefined) return null
  const retryable = canRetryNodeRun(run.status, taskStatus)

  // P-3-10: sibling fan-out children, if this run is a multi-process parent.
  const children = runs.filter((r) => r.parentNodeRunId === nodeRunId)
  // Unified run history — every sibling node_run of the same nodeId, with
  // the active row highlighted in place. See node-history.ts for why we
  // collapsed the previous two-section layout into one.
  const history = nodeRunHistory(run, runs)

  const tabs: Array<TabDef<Tab>> = [
    { key: 'session', label: t('nodeDrawer.tabSession') },
    {
      key: 'events',
      label: t('nodeDrawer.tabEvents'),
      badge: eventsQuery.data?.events.length,
      badgeTone: 'neutral',
      badgeAriaLabel:
        eventsQuery.data === undefined
          ? undefined
          : t('nodeDrawer.eventCount', { count: eventsQuery.data.events.length }),
    },
    {
      key: 'output',
      label: t('nodeDrawer.tabOutput'),
      badge: nodeOutputs.length,
      badgeTone: 'neutral',
      badgeAriaLabel: t('nodeDrawer.outputCount', { count: nodeOutputs.length }),
    },
    { key: 'stats', label: t('nodeDrawer.tabStats') },
  ]
  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div>
          <div id={NODE_DETAIL_DRAWER_HEADING_ID} className="inspector__kind">
            {t('nodeDrawer.kindLabel')}
          </div>
          <div className="inspector__id">
            <code>{run.nodeId}</code> <span className="muted">/ {run.id.slice(-6)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inspector__close"
          aria-label={t('inspector.closeAria')}
        >
          ×
        </button>
      </header>
      <TabBar<Tab>
        variant="inspector"
        tabs={tabs}
        active={tab}
        onSelect={setTab}
        ariaLabelledBy={NODE_DETAIL_DRAWER_HEADING_ID}
        idPrefix={NODE_DETAIL_DRAWER_TAB_PREFIX}
      />
      {retryable && (
        <div className="inspector__action-row">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
          >
            {retry.isPending ? t('nodeDrawer.retrying') : t('nodeDrawer.retryButton')}
          </button>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={cascade}
              onChange={(e) => setCascade(e.target.checked)}
              disabled={retry.isPending}
            />
            <span>{t('nodeDrawer.retryCascadeLabel')}</span>
          </label>
        </div>
      )}
      {retry.error !== null && retry.error !== undefined && <ErrorBanner error={retry.error} />}
      {children.length > 0 && <SubProcessList shards={children} onPick={onSelectRun} />}
      <div className="inspector__body">
        {tabs.map(({ key }) => {
          const ids = tabDomIds(NODE_DETAIL_DRAWER_TAB_PREFIX, key)
          const active = key === tab
          return (
            <div
              key={key}
              role="tabpanel"
              id={ids.panelId}
              aria-labelledby={ids.tabId}
              hidden={!active}
            >
              {active && key === 'session' && (
                <SessionTab
                  taskId={taskId}
                  runs={runs}
                  nodeId={nodeId}
                  selectedRunId={nodeRunId}
                  workflowNodeKind={workflowNodeKind}
                />
              )}
              {active && key === 'events' && <EventsTab query={eventsQuery} />}
              {active && key === 'output' && <OutputTab outputs={nodeOutputs} />}
              {active && key === 'stats' && (
                <StatsTab run={run} history={history} onPickRetry={onSelectRun} agentId={agentId} />
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------

function SubProcessList({ shards, onPick }: { shards: NodeRun[]; onPick?: (id: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="subprocess-list">
      <div className="subprocess-list__title">
        {t('nodeDrawer.shardCount', { n: shards.length })}
      </div>
      <ul>
        {shards
          .sort((a, b) => (a.shardKey ?? '').localeCompare(b.shardKey ?? ''))
          .map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="subprocess-list__item"
                onClick={() => onPick?.(c.id)}
              >
                <StatusChip kind={nodeRunStatusToKind(c.status)}>
                  {t(displayNoderunStatusKey(c))}
                </StatusChip>
                <code className="subprocess-list__shard">
                  {c.shardKey ?? t('nodeDrawer.shardNoKey')}
                </code>
                <span className="muted">
                  {t('nodeDrawer.tokenPrefix')} {c.tokTotal ?? 0}
                </span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------

function OutputTab({ outputs }: { outputs: NodeRunOutput[] }) {
  const { t } = useTranslation()
  if (outputs.length === 0) {
    return <div className="muted">{t('nodeDrawer.outputNone')}</div>
  }
  return (
    <div className="form-grid">
      {outputs.map((o, i) => (
        <article key={`${o.port}-${i}`} className="task-output-card">
          <header className="task-output-card__header">
            <div className="task-output-card__name">{o.port}</div>
            <CopyButton text={o.value} />
          </header>
          <pre className="task-output-card__body">
            {o.value === '' ? <span className="muted">{t('common.empty')}</span> : o.value}
          </pre>
        </article>
      ))}
    </div>
  )
}

function StatsDependencyTreeRow({ agentId }: { agentId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <>
      <dt>{t('nodeDrawer.statDependencyTree')}</dt>
      <dd>
        <NodeDependencyTreeSection
          agentId={agentId}
          onNodeClick={(id) => navigate({ to: '/agents/$id', params: { id } })}
        />
      </dd>
    </>
  )
}

function StatsTab({
  run,
  history,
  onPickRetry,
  agentId,
}: {
  run: NodeRun
  history: NodeRun[]
  onPickRetry?: (id: string) => void
  /** RFC-022: primary agent name; null hides the dependency-tree section. */
  agentId: string | null
}) {
  const { t } = useTranslation()
  // RFC-078: review rows surface the current round's content-anchored start,
  // not the pinned slot-open started_at. durationMs unifies the review wait and
  // the compute span so the "duration" reads identically — no 人工/非人工
  // marker. See lib/reviewRunDisplay.
  const { displayStartedAt: displayStarted, durationMs } = reviewRunDisplay(run)
  const duration = durationMs === null ? t('common.emDash') : `${(durationMs / 1000).toFixed(2)}s`
  // RFC-011 文案：被新尝试取代的旧 attempt 不再以 raw 'canceled' 字串呈现，
  // 也不显示机器前缀错误信息——通过 noderun-status helper 决定 chip 文案与
  // 是否用 supersededHint / rollbackHint 替换 errorMessage。
  const cancellationKind = classifyCanceled(run)
  const decision = supersededDecision(run)
  return (
    <dl className="task-meta">
      <dt>{t('nodeDrawer.statStatus')}</dt>
      <dd>{t(displayNoderunStatusKey(run))}</dd>
      <dt>{t('nodeDrawer.statStarted')}</dt>
      <dd>
        {displayStarted === null ? t('common.emDash') : new Date(displayStarted).toLocaleString()}
      </dd>
      <dt>{t('nodeDrawer.statFinished')}</dt>
      <dd>
        {run.finishedAt === null ? t('common.emDash') : new Date(run.finishedAt).toLocaleString()}
      </dd>
      <dt>{t('nodeDrawer.statDuration')}</dt>
      <dd>{duration}</dd>
      <dt>{t('nodeDrawer.statExitCode')}</dt>
      <dd>{run.exitCode === null ? t('common.emDash') : run.exitCode}</dd>
      <dt>{t('nodeDrawer.statIteration')}</dt>
      <dd>{run.iteration}</dd>
      {/* RFC-189 — the authoritative lw workgroup round ordinal (wg_round);
          absent on non-workgroup / free_collab rows. Codex 实现门 P3: api.get
          only CASTS the JSON — a pre-0095 remote daemon omits the field
          entirely (undefined, zod default never runs), so guard both. */}
      {run.wgRound !== null && run.wgRound !== undefined && (
        <>
          <dt>{t('nodeDrawer.statWgRound')}</dt>
          <dd data-testid="rfc189-wg-round">{run.wgRound}</dd>
        </>
      )}
      <dt>{t('nodeDrawer.statRetry')}</dt>
      {/* displayRetryForRun: workgroup host runs HISTORICALLY stored a turn
          ordinal in retryIndex (pre-0095 rows still do), so the raw column
          would read "retried N times" on a turn that never failed — the
          lineage derivation holds under both the old and RFC-189 semantics. */}
      <dd>{displayRetryForRun(run, history)}</dd>
      {run.opencodeSessionId !== null && run.opencodeSessionId.length > 0 && (
        <>
          <dt>{t('nodeDrawer.statSession')}</dt>
          <dd data-testid="rfc026-session-id">
            <code>{run.opencodeSessionId.slice(0, 16)}</code>
            {clarifyRoundForRun(run, history) > 0 && (
              <span
                className="chip chip--tight"
                data-testid="rfc026-session-chip"
                style={{ marginLeft: 8 }}
              >
                {t('clarify.node.chip.inline')}
              </span>
            )}
          </dd>
        </>
      )}
      <dt>{t('nodeDrawer.statTokensIn')}</dt>
      <dd>{run.tokInput ?? t('common.emDash')}</dd>
      <dt>{t('nodeDrawer.statTokensOut')}</dt>
      <dd>{run.tokOutput ?? t('common.emDash')}</dd>
      <dt>{t('nodeDrawer.statTokensTotal')}</dt>
      <dd>{run.tokTotal ?? t('common.emDash')}</dd>
      <dt>{t('nodeDrawer.statCacheCreate')}</dt>
      <dd>{run.tokCacheCreate ?? t('common.emDash')}</dd>
      <dt>{t('nodeDrawer.statCacheRead')}</dt>
      <dd>{run.tokCacheRead ?? t('common.emDash')}</dd>
      {cancellationKind === 'superseded' && decision !== null && (
        <>
          <dt>{t('nodeDrawer.statError')}</dt>
          <dd className="task-meta__error">
            {t('noderunStatus.supersededHint', {
              decision: t(`noderunStatus.decision.${decision}`),
            })}
          </dd>
        </>
      )}
      {cancellationKind === 'rollback' && decision !== null && (
        <>
          <dt>{t('nodeDrawer.statError')}</dt>
          <dd className="task-meta__error">
            {t('noderunStatus.rollbackHint', {
              decision: t(`noderunStatus.decision.${decision}`),
            })}
          </dd>
        </>
      )}
      {cancellationKind === 'manual' && run.errorMessage !== null && (
        <>
          <dt>{t('nodeDrawer.statError')}</dt>
          {/* RFC-203 T4 (Codex impl-gate P2): localize ONLY genuine failure
              rows. classifyCanceled returns 'manual' for canceled / interrupted
              rows too, whose errorMessage ('aborted by signal',
              'daemon-shutdown …') is not a task-failure token — running it
              through describeTaskFailure would mislabel them "Task execution
              failed". Those keep their raw message; failed / exhausted rows
              get the localized copy. */}
          <dd className="task-meta__error" title={run.errorMessage}>
            {run.status === 'failed' || run.status === 'exhausted'
              ? describeTaskFailure({
                  failureCode: run.failureCode ?? null,
                  errorSummary: run.errorMessage,
                }).title
              : run.errorMessage}
          </dd>
        </>
      )}
      {agentId !== null && <StatsDependencyTreeRow agentId={agentId} />}
      {history.length > 1 && (
        <>
          <dt>{t('nodeDrawer.statHistory')}</dt>
          <dd>
            <ul className="retries-history" data-testid="stats-history-list">
              {history.map((r) => {
                const isActive = r.id === run.id
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={`retries-history__item${
                        isActive ? ' retries-history__item--active' : ''
                      }`}
                      aria-current={isActive ? 'true' : undefined}
                      disabled={isActive}
                      onClick={() => onPickRetry?.(r.id)}
                    >
                      <code>
                        {formatIterationLabel(
                          r,
                          { t },
                          clarifyRoundForRun(r, history),
                          displayRetryForRun(r, history),
                        )}
                      </code>{' '}
                      <StatusChip kind={nodeRunStatusToKind(r.status)}>
                        {t(displayNoderunStatusKey(r))}
                      </StatusChip>
                      {r.startedAt !== null && (
                        <span className="muted">{new Date(r.startedAt).toLocaleTimeString()}</span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </dd>
        </>
      )}
    </dl>
  )
}

function EventsTab({
  query,
}: {
  query: {
    data: NodeRunEventsResponse | undefined
    isLoading: boolean
    error: unknown
  }
}) {
  const { t } = useTranslation()
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(() => new Set(NODE_EVENT_KIND))

  const visible = useMemo(
    () => (query.data?.events ?? []).filter((e) => enabledKinds.has(e.kind)),
    [query.data, enabledKinds],
  )

  function toggleKind(k: string) {
    setEnabledKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  return (
    <div>
      <div className="events-filter chip-row">
        {NODE_EVENT_KIND.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => toggleKind(k)}
            className={`chip chip--tight ${enabledKinds.has(k) ? 'chip--active' : ''}`}
          >
            {k}
          </button>
        ))}
      </div>
      {query.isLoading && <LoadingState size="compact" />}
      {query.error !== null && query.error !== undefined && <ErrorBanner error={query.error} />}
      {visible.length === 0 && !query.isLoading && (
        <div className="muted">{t('nodeDrawer.noEventsMatch')}</div>
      )}
      <ol className="events-list">
        {visible.map((e) => {
          // RFC-026: events the scheduler writes for inline-session-resume
          // get a friendlier rendering — info chip + plain summary line —
          // instead of the raw `[rfc026/...]` JSON blob.
          const rfc026 =
            e.kind === 'text' && typeof e.payload === 'string' ? parseRfc026Event(e.payload) : null
          if (rfc026 !== null) {
            const classes =
              rfc026.level === 'info'
                ? 'events-list__item events-list__item--rfc026-info'
                : 'events-list__item events-list__item--rfc026-warning'
            const summary =
              rfc026.level === 'info'
                ? t('clarify.eventStream.sessionResumed', {
                    prefix: rfc026.sessionIdPrefix,
                    n: rfc026.clarifyGeneration ?? '?',
                  })
                : t('clarify.eventStream.fallbackToIsolated', { reason: rfc026.reason })
            return (
              <li key={e.id} className={classes} data-testid={`rfc026-event-${rfc026.level}`}>
                <header className="events-list__header">
                  <code className="events-list__kind">
                    {rfc026.level === 'info' ? 'info' : 'warning'}
                  </code>
                  <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
                </header>
                <div className="events-list__rfc026">{summary}</div>
              </li>
            )
          }
          // RFC-031: opencode plugin failed to load — runner tagged it onto
          // the stderr stream. Render as a warning card with the plugin name
          // up-front so operators can correlate against /plugins UI.
          const rfc031 =
            e.kind === 'text' && typeof e.payload === 'string' ? parseRfc031Event(e.payload) : null
          if (rfc031 !== null) {
            const label =
              rfc031.pluginName.length > 0 ? rfc031.pluginName : t('nodeDrawer.unknownPlugin')
            return (
              <li
                key={e.id}
                className="events-list__item events-list__item--rfc026-warning"
                data-testid="rfc031-event-warning"
              >
                <header className="events-list__header">
                  <code className="events-list__kind">warning</code>
                  <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
                </header>
                <div className="events-list__rfc026">
                  <strong>{label}</strong>
                  {rfc031.message.length > 0 ? `: ${rfc031.message}` : ''}
                </div>
              </li>
            )
          }
          return (
            <li key={e.id} className={`events-list__item events-list__item--${e.kind}`}>
              <header className="events-list__header">
                <code className="events-list__kind">{e.kind}</code>
                <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
              </header>
              <pre className="events-list__body">
                {typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload, null, 2)}
              </pre>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  function copy() {
    // copyText survives insecure http:// contexts, where the async Clipboard
    // API is undefined — the bare dereference threw there (2026-07-21 sweep).
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button type="button" className="btn btn--sm" onClick={copy}>
      {copied ? t('common.copied') : t('common.copy')}
    </button>
  )
}

/**
 * The /retry endpoint mints a fresh node_run at retry_index+1 for the
 * target node (and, with cascade=true, every downstream node). Two
 * preconditions:
 *   - The node's latest run must actually be in a recoverable terminal
 *     state. `done` / `skipped` would re-do already-finished work;
 *     `pending` / `running` would race the live scheduler.
 *   - The task itself must not be running — the backend returns 409
 *     `task-still-running` otherwise (see retryNode in task.ts).
 *
 * Exported for unit tests.
 */
export function canRetryNodeRun(
  runStatus: NodeRun['status'],
  taskStatus: Task['status'] | undefined,
): boolean {
  const terminalRunForRetry =
    runStatus === 'failed' ||
    runStatus === 'interrupted' ||
    runStatus === 'exhausted' ||
    runStatus === 'canceled'
  if (!terminalRunForRetry) return false
  if (taskStatus === 'running' || taskStatus === 'pending') return false
  return true
}
