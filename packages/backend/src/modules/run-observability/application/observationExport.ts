import type {
  ObservationMetrics,
  ObservationOverview,
  ObservationSnapshotExport,
  ObservationSnapshotExportQuery,
} from '@agent-workflow/shared'

type Cell = string | number | boolean | null
const metricHeaders = [
  'invocations',
  'observed_invocations',
  'records',
  'input_known',
  'cache_read_known',
  'cache_write_known',
  'output_known',
  'tokens_total_known',
  'tokens_has_known',
  'tokens_complete',
  'input_unknown',
  'cache_read_unknown',
  'cache_write_unknown',
  'output_unknown',
  'cost_known_cny',
  'cost_complete',
  'priced_records',
  'price_versions',
  'cost_reasons',
  'authorities',
  'truncated',
]
function metrics(value: ObservationMetrics): Cell[] {
  const { tokens, cost } = value
  return [
    value.invocations,
    value.observedInvocations,
    value.records,
    tokens.known.input,
    tokens.known.cacheRead,
    tokens.known.cacheWrite,
    tokens.known.output,
    tokens.totalKnown,
    tokens.hasKnown,
    tokens.complete,
    tokens.unknownBuckets.input,
    tokens.unknownBuckets.cacheRead,
    tokens.unknownBuckets.cacheWrite,
    tokens.unknownBuckets.output,
    cost.knownAmount,
    cost.complete,
    cost.pricedRecords,
    JSON.stringify(cost.priceVersionIds),
    JSON.stringify(cost.reasons),
    JSON.stringify(value.authorities),
    value.truncated,
  ]
}
function cell(value: Cell): string {
  const text = value === null ? '' : String(value)
  const literal = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text
  return `"${literal.replaceAll('"', '""')}"`
}

/** Serializes only the already-authorized snapshot; never reads a global rollup. */
export function exportObservationSnapshot(
  snapshot: ObservationOverview,
  query: ObservationSnapshotExportQuery,
): ObservationSnapshotExport {
  let identity: string[], rows: Cell[][]
  if (query.view === 'agents') {
    identity = ['agent_key', 'agent_id', 'agent_revision', 'purpose', 'task_count', 'task_ids']
    rows = snapshot.agents.flatMap((agent) => {
      const key = JSON.stringify([agent.agentId, agent.agentRevision, agent.purpose])
      if (query.agent !== undefined && query.agent !== key) return []
      return [
        [
          key,
          agent.agentId,
          agent.agentRevision,
          agent.purpose,
          agent.tasks.length,
          JSON.stringify(agent.tasks.map((task) => task.taskId)),
          ...metrics(agent.metrics),
        ],
      ]
    })
  } else {
    identity = [
      'task_id',
      'task_name',
      'state',
      'parent_task_id',
      'started_at',
      'finished_at',
      'wall_ms',
      'running_ms',
    ]
    const selected =
      query.quality === undefined
        ? null
        : new Set(snapshot.quality.find((item) => item.reason === query.quality)?.taskIds ?? [])
    rows = snapshot.tasks
      .filter((row) => selected === null || selected.has(row.task.id))
      .map(({ task, wallMs, runningMs, metrics: value }) => [
        task.id,
        task.name,
        task.status,
        task.parentTaskId,
        task.startedAt,
        task.finishedAt,
        wallMs,
        runningMs,
        ...metrics(value),
      ])
  }
  const headers = [
    ...identity,
    ...metricHeaders,
    'currency',
    'as_of',
    'window_from',
    'window_to',
    'timezone',
    'cohort',
    'task_scope',
    'projection_version',
    'snapshot_partial',
    'task_limit',
    'invocation_limit',
    'record_limit',
    'quality_filter',
  ]
  const metadata: Cell[] = [
    'CNY',
    snapshot.asOf,
    query.window.from,
    query.window.to,
    query.window.timezone,
    snapshot.cohort,
    snapshot.taskScope,
    snapshot.projectionVersion,
    snapshot.partial,
    snapshot.limits.tasks,
    snapshot.limits.invocations,
    snapshot.limits.records,
    query.quality ?? null,
  ]
  const lines = [headers, ...rows.map((row) => [...row, ...metadata])]
  return {
    filename: `aw-observations-${query.view}-${query.window.from}-${query.window.to}.csv`,
    mediaType: 'text/csv;charset=utf-8',
    content: '\ufeff' + lines.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n',
    rows: rows.length,
    asOf: snapshot.asOf,
    partial: snapshot.partial,
    bounded: true,
  }
}
