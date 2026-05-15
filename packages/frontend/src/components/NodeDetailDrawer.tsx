// Right-side drawer that opens when the user picks a node on the task
// status canvas (P-2-13). M2 ships 4 tabs:
//
//   - Prompt — promptText captured by the runner (read-only).
//   - Events — latest 500 events with kind filter chips; refetches on
//               /ws/tasks/:id node.event invalidations.
//   - Output — port → value cards (copyable).
//   - Stats  — start/finish/duration, exit code, token usage.
//
// Retries history + sub-process listing for fan-out children land in M3.

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NodeRun, NodeRunEventsResponse, NodeRunOutput } from '@agent-workflow/shared'
import { NODE_EVENT_KIND } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'

interface Props {
  taskId: string
  nodeRunId: string | null
  runs: NodeRun[]
  outputs: NodeRunOutput[]
  onClose: () => void
  /** Allows the drawer to navigate between sibling/child runs. */
  onSelectRun?: (nodeRunId: string) => void
}

type Tab = 'prompt' | 'events' | 'output' | 'stats'

export function NodeDetailDrawer({
  taskId,
  nodeRunId,
  runs,
  outputs,
  onClose,
  onSelectRun,
}: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('prompt')

  if (nodeRunId === null) return null
  const run = runs.find((r) => r.id === nodeRunId)
  if (run === undefined) return null
  const nodeOutputs = outputs.filter((o) => o.nodeRunId === nodeRunId)

  // P-3-10: sibling fan-out children, if this run is a multi-process parent.
  const children = runs.filter((r) => r.parentNodeRunId === nodeRunId)
  // P-3-10: previous retries on this node id.
  const retries = runs
    .filter((r) => r.nodeId === run.nodeId && r.id !== run.id && r.parentNodeRunId === null)
    .sort((a, b) => a.retryIndex - b.retryIndex)

  const tabs: Array<[Tab, string]> = [
    ['prompt', t('nodeDrawer.tabPrompt')],
    ['events', t('nodeDrawer.tabEvents')],
    ['output', t('nodeDrawer.tabOutput')],
    ['stats', t('nodeDrawer.tabStats')],
  ]

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div>
          <div className="inspector__kind">{t('nodeDrawer.kindLabel')}</div>
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
      <div className="tabs inspector__tabs">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`tabs__tab ${tab === k ? 'tabs__tab--active' : ''}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {children.length > 0 && <SubProcessList shards={children} onPick={onSelectRun} />}
      <div className="inspector__body">
        {tab === 'prompt' && <PromptTab run={run} />}
        {tab === 'events' && <EventsTab taskId={taskId} nodeRunId={nodeRunId} />}
        {tab === 'output' && <OutputTab outputs={nodeOutputs} />}
        {tab === 'stats' && <StatsTab run={run} retries={retries} onPickRetry={onSelectRun} />}
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
                <span className={`status-chip status-chip--${noderunTone(c.status)}`}>
                  {c.status}
                </span>
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

function noderunTone(s: NodeRun['status']): string {
  switch (s) {
    case 'running':
      return 'blue'
    case 'done':
      return 'green'
    case 'failed':
    case 'exhausted':
      return 'red'
    case 'canceled':
    case 'interrupted':
      return 'gray'
    case 'pending':
    case 'skipped':
      return 'gray'
  }
}

// ---------------------------------------------------------------------------

function PromptTab({ run }: { run: NodeRun }) {
  const { t } = useTranslation()
  if (run.promptText === null) {
    return <div className="muted">{t('nodeDrawer.promptPending')}</div>
  }
  return <pre className="readonly-pre">{run.promptText}</pre>
}

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

function StatsTab({
  run,
  retries,
  onPickRetry,
}: {
  run: NodeRun
  retries: NodeRun[]
  onPickRetry?: (id: string) => void
}) {
  const { t } = useTranslation()
  const duration =
    run.startedAt !== null && run.finishedAt !== null
      ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(2)}s`
      : t('common.emDash')
  return (
    <dl className="task-meta">
      <dt>{t('nodeDrawer.statStatus')}</dt>
      <dd>{run.status}</dd>
      <dt>{t('nodeDrawer.statStarted')}</dt>
      <dd>
        {run.startedAt === null ? t('common.emDash') : new Date(run.startedAt).toLocaleString()}
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
      <dt>{t('nodeDrawer.statRetry')}</dt>
      <dd>{run.retryIndex}</dd>
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
      {run.errorMessage !== null && (
        <>
          <dt>{t('nodeDrawer.statError')}</dt>
          <dd className="task-meta__error">{run.errorMessage}</dd>
        </>
      )}
      {retries.length > 0 && (
        <>
          <dt>{t('nodeDrawer.statRetries')}</dt>
          <dd>
            <ul className="retries-history">
              {retries.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="retries-history__item"
                    onClick={() => onPickRetry?.(r.id)}
                  >
                    <code>{t('nodeDrawer.attempt', { n: r.retryIndex })}</code>{' '}
                    <span className={`status-chip status-chip--${noderunTone(r.status)}`}>
                      {r.status}
                    </span>
                    {r.startedAt !== null && (
                      <span className="muted">{new Date(r.startedAt).toLocaleTimeString()}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  )
}

function EventsTab({ taskId, nodeRunId }: { taskId: string; nodeRunId: string }) {
  const { t } = useTranslation()
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(() => new Set(NODE_EVENT_KIND))
  const query = useQuery<NodeRunEventsResponse>({
    queryKey: ['tasks', taskId, 'node-runs', nodeRunId, 'events'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/node-runs/${encodeURIComponent(nodeRunId)}/events`,
        undefined,
        signal,
      ),
  })

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
      {query.isLoading && <div className="muted">{t('common.loading')}</div>}
      {query.error !== null && query.error !== undefined && (
        <div className="error-box">{describeError(query.error)}</div>
      )}
      {visible.length === 0 && !query.isLoading && (
        <div className="muted">{t('nodeDrawer.noEventsMatch')}</div>
      )}
      <ol className="events-list">
        {visible.map((e) => (
          <li key={e.id} className={`events-list__item events-list__item--${e.kind}`}>
            <header className="events-list__header">
              <code className="events-list__kind">{e.kind}</code>
              <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
            </header>
            <pre className="events-list__body">
              {typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload, null, 2)}
            </pre>
          </li>
        ))}
      </ol>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
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

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
