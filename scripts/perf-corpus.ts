// RFC-359 AC11: the RFC-311 seed has one row generator for both database sinks.
// Keep the original index arithmetic and payload bytes; loading and HTTP timing
// are separate concerns. This module performs no database or filesystem work.

export interface PerfCorpusDimensions {
  readonly tasks: number
  readonly runsPerTask: number
  readonly events: number
  readonly deliveries: number
  readonly repos: number
}

export interface PerfCorpusCounts {
  readonly cachedRepos: number
  readonly tasks: number
  readonly nodeRuns: number
  readonly nodeRunEvents: number
  readonly webhookDeliveries: number
}

export const PERF_CORPUS_FULL_DIMENSIONS: PerfCorpusDimensions = Object.freeze({
  tasks: 100_000,
  runsPerTask: 30,
  events: 10_000_000,
  deliveries: 100_000,
  repos: 500,
})

export const PERF_CORPUS_SMALL_DIMENSIONS: PerfCorpusDimensions = Object.freeze({
  tasks: 1_000,
  runsPerTask: 30,
  events: 100_000,
  deliveries: 1_000,
  repos: 5,
})

export const PERF_CORPUS_CHUNKS = Object.freeze({
  tasks: 20_000,
  nodeRuns: 50_000,
  nodeRunEvents: 100_000,
  webhookDeliveries: 50_000,
})

const T0 = Date.parse('2026-01-01T00:00:00Z')
const SPAN = Date.parse('2026-08-01T00:00:00Z') - T0

// The pre-existing benchmark entry values are passed through as opaque data.
export const PERF_CORPUS_ENTRY = Object.freeze({
  userId: 'perf-admin',
  username: 'perf-admin',
  displayName: 'perf-admin',
  role: 'admin' as const,
  workflowId: 'perf-wf',
  workflowName: 'perf-wf',
  workflowDefinition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  patId: 'perf-pat',
  patName: 'perf-bench',
  patScopesJson: '[]',
  bearerToken: `aws_pat_${'ab'.repeat(32)}`,
  now: T0,
})

const STATUSES = ['done', 'done', 'done', 'failed', 'canceled', 'running', 'pending'] as const
const RUN_STATUSES = ['done', 'done', 'done', 'failed', 'running'] as const

const PAYLOAD = JSON.stringify({
  type: 'text',
  part: { text: 'perf event payload '.repeat(8) },
})
const BODY = JSON.stringify({ object_kind: 'merge_request', perf: 'x'.repeat(512) })

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

export function perfCorpusCounts(args: PerfCorpusDimensions): PerfCorpusCounts {
  return {
    cachedRepos: args.repos,
    tasks: args.tasks,
    nodeRuns: args.tasks * args.runsPerTask,
    nodeRunEvents: args.events,
    webhookDeliveries: args.deliveries,
  }
}

export function* perfCorpusRanges(total: number, chunk: number) {
  if (!Number.isSafeInteger(chunk) || chunk <= 0) {
    throw new RangeError('performance corpus chunk must be a positive safe integer')
  }
  for (let base = 0; base < total; base += chunk) {
    const hi = Math.min(base + chunk, total)
    yield { base, hi }
  }
}

export function perfRepoRow(i: number) {
  return {
    id: `perfrepo${pad(i, 6)}`,
    urlHash: `pr${pad(i, 6)}`,
    urlRedacted: `git@example.com:perf/repo-${i}.git`,
    localPath: `/cache/perf/repo-${i}`,
    defaultBranch: 'main',
    lastFetchedAt: T0 + ((i * 7919) % SPAN),
    createdAt: T0,
    lastAutoRefreshAt: i % 3 === 0 ? T0 + i : null,
    hasSubmodules: i % 4 === 0 ? 1 : i % 4 === 1 ? 0 : null,
    lastSubmoduleSyncOk: i % 8 === 0 ? 0 : 1,
  }
}

export function perfTaskRow(i: number, args: PerfCorpusDimensions) {
  const id = `perftask${pad(i, 7)}`
  const startedAt = T0 + ((i * 104_729) % SPAN)
  const isChild = i % 10 === 9
  const parentId = isChild ? `perftask${pad(i - 1, 7)}` : null
  const childStartedAt = startedAt + 60_000
  const status = STATUSES[i % STATUSES.length]!
  const finished = status === 'done' || status === 'failed' || status === 'canceled'
  return {
    id,
    name: `perf task ${i}`,
    workflowId: 'perf-wf',
    workflowSnapshot: '{}',
    repoPath: `/repo/perf-${i % 97}`,
    worktreePath: `/wt/perf-${i}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    startedAt: isChild ? childStartedAt : startedAt,
    finishedAt: finished ? startedAt + 120_000 : null,
    runningMs: 0,
    ownerUserId: PERF_CORPUS_ENTRY.userId,
    launchOrigin: 'manual' as const,
    parentTaskId: parentId,
    invocationDepth: isChild ? 1 : 0,
    cachedRepoId: `perfrepo${pad(i % args.repos, 6)}`,
    branchStartedAt: isChild
      ? childStartedAt
      : (i + 1) % 10 === 9 && i + 1 < args.tasks
        ? T0 + (((i + 1) * 104_729) % SPAN) + 60_000
        : startedAt,
    rootTaskId: parentId ?? id,
    // Exact bytes produced by the surviving SQLite tasks INSERT trigger (0210).
    // Its node_runs counterpart was removed by 0224; do not synthesize run data.
    executionLineageId: parentId ?? id,
    lineageSlotPathJson: JSON.stringify([
      {
        stableNodeKey: 'task-root',
        frozenOccurrenceKey: parentId ?? id,
        workflowRevision: null,
      },
      ...(isChild
        ? [{ stableNodeKey: 'child-task', frozenOccurrenceKey: id, workflowRevision: null }]
        : []),
    ]),
  }
}

export function perfNodeRunRow(i: number, args: PerfCorpusDimensions) {
  const taskIdx = i % args.tasks
  const seq = Math.floor(i / args.tasks)
  const startedAt = T0 + ((taskIdx * 104_729) % SPAN) + seq * 1000
  const status = RUN_STATUSES[i % RUN_STATUSES.length]!
  return {
    id: `perfrun${pad(i, 8)}`,
    taskId: `perftask${pad(taskIdx, 7)}`,
    nodeId: `node-${seq}`,
    status,
    iteration: 0,
    retryIndex: 0,
    startedAt,
    finishedAt: status === 'running' ? null : startedAt + 900,
    continuationSlotKey: null,
    lineageSlotPathJson: null,
    scopePath: '',
  }
}

export function perfEventRow(i: number, args: PerfCorpusDimensions) {
  const totalRuns = args.tasks * args.runsPerTask
  const hotRuns = Math.max(1, Math.floor(totalRuns * 0.02))
  const runIdx = i % 3 === 0 ? i % hotRuns : i % totalRuns
  return {
    nodeRunId: `perfrun${pad(runIdx, 8)}`,
    ts: T0 + i,
    kind: 'text' as const,
    payload: PAYLOAD,
  }
}

export function perfDeliveryRow(i: number) {
  return {
    id: `perfdlv${pad(i, 8)}`,
    endpointId: 'perf-endpoint',
    eventUuid: `uuid-${i}`,
    objectKind: 'merge_request',
    eventType: 'merge_request',
    status: 'matched' as const,
    receivedAt: T0 + ((i * 31) % SPAN),
    bodyJson: BODY,
  }
}
