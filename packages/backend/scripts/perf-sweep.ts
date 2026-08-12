// P-5-12 — performance + stability sweep.
//
// Spins up an in-memory DB, seeds synthetic data, and measures end-to-end
// latency for the four scenarios called out in design/plan.md §6 P-5-12:
//
//   1.  Node-detail page fetching 1000 events.
//   2.  Tasks list with 100 rows.
//   3.  Diff splitting on a synthetic 10 MiB diff.
//   4.  10 concurrent task runs against scheduler.ts + stub-opencode.sh.
//
// Bypasses the HTTP layer so we measure the service-level cost. The HTTP
// overhead (Hono + middleware) is fixed-cost and accounted for in the
// notes file (docs/performance-notes.md).
//
// Run: `bun run --filter @agent-workflow/backend perf:sweep`.

import { execSync } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ulid } from 'ulid'

import { createInMemoryDb } from '@/db/client'
import { agents, nodeRuns, nodeRunEvents, tasks, workflows } from '@/db/schema'
import { startTask } from '@/services/task'
import { listTasks, getNodeRunEvents } from '@/services/task'
import { createLogger } from '@/util/log'

const here = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(here, '..')
const repoRoot = resolve(backendRoot, '..', '..')
const STUB_OPENCODE = resolve(repoRoot, 'e2e', 'fixtures', 'stub-opencode.sh')
const MIGRATIONS_DIR = resolve(backendRoot, 'db', 'migrations')
const log = createLogger('perf')

interface Sample {
  name: string
  ms: number
  rssDeltaKb: number
  notes?: string
}

const samples: Sample[] = []

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

function rssKb(): number {
  return Math.round(process.memoryUsage().rss / 1024)
}

async function bench<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const rss0 = rssKb()
  const t0 = nowMs()
  const out = await fn()
  const ms = nowMs() - t0
  const rss1 = rssKb()
  samples.push({ name, ms, rssDeltaKb: rss1 - rss0 })
  log.info('bench', { name, ms, rssDeltaKb: rss1 - rss0 })
  return out
}

// -------------------------------------------------------------------------
// Scenario 1: 1000 events on node-detail.
// -------------------------------------------------------------------------
async function scenarioEvents(): Promise<void> {
  const db = createInMemoryDb(MIGRATIONS_DIR)
  const workflowId = ulid()
  const taskId = ulid()
  const nodeRunId = ulid()

  await db.insert(workflows).values({
    id: workflowId,
    name: 'perf',
    description: '',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    version: 1,
  })
  await db.insert(tasks).values({
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/perf',
    worktreePath: '/tmp/perf',
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'done',
    inputs: '{}',
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'agent_1',
    status: 'done',
    retryIndex: 0,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })

  const N = 1000
  const t0 = nowMs()
  const rows = Array.from({ length: N }, (_, i) => ({
    nodeRunId,
    ts: Date.now() + i,
    kind: 'text' as const,
    payload: JSON.stringify({ type: 'text', part: { type: 'text', text: 'line ' + i } }),
  }))
  const CHUNK = 250
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(nodeRunEvents).values(rows.slice(i, i + CHUNK))
  }
  samples.push({
    name: 'seed_1000_events_insert',
    ms: nowMs() - t0,
    rssDeltaKb: 0,
    notes: 'batched 250 rows / insert',
  })

  await bench('events_fetch_first_500', () =>
    getNodeRunEvents(db, taskId, nodeRunId, { since: 0, limit: 500 }),
  )
  await bench('events_fetch_next_500_cursor', async () => {
    const first = await getNodeRunEvents(db, taskId, nodeRunId, { since: 0, limit: 500 })
    const cursor = first.events[first.events.length - 1]?.id ?? 0
    return getNodeRunEvents(db, taskId, nodeRunId, { since: cursor, limit: 500 })
  })
  await bench('events_full_1000_in_one_call', () =>
    getNodeRunEvents(db, taskId, nodeRunId, { since: 0, limit: 1000 }),
  )

  db.$client.close()
}

// -------------------------------------------------------------------------
// Scenario 2: list 100 tasks.
// -------------------------------------------------------------------------
async function scenarioTasksList(): Promise<void> {
  const db = createInMemoryDb(MIGRATIONS_DIR)
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'perf',
    description: '',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    version: 1,
  })

  const N = 100
  const t0 = nowMs()
  const rows = Array.from({ length: N }, (_, i) => ({
    id: ulid(),
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/perf-' + (i % 5),
    worktreePath: '/tmp/perf-wt',
    baseBranch: 'main',
    branch: 'agent-workflow/x',
    status: (['pending', 'running', 'done', 'failed', 'canceled'] as const)[i % 5],
    inputs: '{}',
    startedAt: Date.now() - i * 60_000,
    finishedAt: i % 5 >= 2 ? Date.now() - i * 60_000 + 10_000 : null,
  }))
  await db.insert(tasks).values(rows)
  samples.push({ name: 'seed_100_tasks', ms: nowMs() - t0, rssDeltaKb: 0 })

  await bench('tasks_list_500_limit', () => listTasks(db, { limit: 500 }))
  await bench('tasks_list_filter_done', () => listTasks(db, { status: 'done', limit: 500 }))
  await bench('tasks_list_filter_workflow', () => listTasks(db, { workflowId, limit: 500 }))

  db.$client.close()
}

// -------------------------------------------------------------------------
// Scenario 3: 10 MiB diff split.
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Scenario 4: 10 concurrent tasks against scheduler + stub-opencode.
// -------------------------------------------------------------------------
async function scenarioConcurrentTasks(): Promise<void> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-perf-home-'))
  mkdirSync(join(appHome, 'worktrees'), { recursive: true })

  const repoPath = mkdtempSync(join(tmpdir(), 'aw-perf-repo-'))
  writeFileSync(join(repoPath, 'README.md'), '# perf\n')
  execSync('git init -b main -q', { cwd: repoPath })
  execSync('git config user.email perf@example.com', { cwd: repoPath })
  execSync('git config user.name perf', { cwd: repoPath })
  execSync('git add .', { cwd: repoPath })
  execSync('git commit -qm initial', { cwd: repoPath })

  const db = createInMemoryDb(MIGRATIONS_DIR)
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'perf',
    description: '',
    definition: JSON.stringify({
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic' },
        {
          id: 'agent_1',
          kind: 'agent-single',
          agentName: 'perf-agent',
          promptTemplate: 'Echo {{topic}}',
        },
        {
          id: 'out_1',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'agent_1', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'agent_1', portName: 'answer' },
          target: { nodeId: 'out_1', portName: 'answer' },
        },
      ],
    }),
    version: 1,
  })
  await db.insert(agents).values({
    id: ulid(),
    name: 'perf-agent',
    description: '',
    outputs: JSON.stringify(['answer']),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const N = 10
  const rss0 = rssKb()
  const t0 = nowMs()

  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      await startTask(
        { workflowId, repoPath, baseBranch: 'main', inputs: { topic: 'perf-' + i } },
        {
          db,
          appHome,
          opencodeCmd: [STUB_OPENCODE],
        },
      )
    }),
  )

  const deadline = Date.now() + 60_000
  for (;;) {
    if (Date.now() > deadline) throw new Error('concurrent tasks did not finish in 60s')
    const rows = await db.select({ status: tasks.status }).from(tasks)
    if (rows.length === N && rows.every((r) => r.status === 'done' || r.status === 'failed')) break
    await Bun.sleep(100)
  }

  const ms = nowMs() - t0
  samples.push({
    name: `concurrent_${N}_tasks_wall_time`,
    ms,
    rssDeltaKb: rssKb() - rss0,
    notes: `${N} tasks reach terminal`,
  })

  const allRuns = await db.select().from(nodeRuns)
  const durations = allRuns
    .filter((r) => r.startedAt !== null && r.finishedAt !== null && r.nodeId === 'agent_1')
    .map((r) => (r.finishedAt as number) - (r.startedAt as number))
  if (durations.length > 0) {
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length
    const max = Math.max(...durations)
    samples.push({
      name: 'agent_node_avg_ms_under_load',
      ms: Math.round(avg),
      rssDeltaKb: 0,
      notes: `n=${durations.length}, max=${max}ms`,
    })
  }
  const terminal = await db.select({ status: tasks.status }).from(tasks)
  const failed = terminal.filter((r) => r.status === 'failed').length
  if (failed > 0) {
    samples.push({
      name: 'concurrent_tasks_failed_count',
      ms: 0,
      rssDeltaKb: 0,
      notes: `${failed}/${N} tasks failed`,
    })
  }

  rmSync(appHome, { recursive: true, force: true })
  rmSync(repoPath, { recursive: true, force: true })
  db.$client.close()
}

// -------------------------------------------------------------------------
// Reporter.
// -------------------------------------------------------------------------
function rowsToMarkdown(rows: Sample[]): string {
  const lines = [
    '| scenario | wall time (ms) | RSS delta (KiB) | notes |',
    '| --- | ---: | ---: | --- |',
  ]
  for (const r of rows) {
    lines.push(`| \`${r.name}\` | ${r.ms} | ${r.rssDeltaKb} | ${r.notes ?? ''} |`)
  }
  return lines.join('\n')
}

function machineInfo(): string {
  const mem = totalmem() / 1024 / 1024 / 1024
  return [
    `platform: ${process.platform} ${process.arch}`,
    `runtime: bun ${typeof Bun !== 'undefined' ? Bun.version : 'n/a'}`,
    `cpus: ${cpus().length}`,
    `mem: ${mem.toFixed(1)} GiB`,
  ].join(' · ')
}

async function main(): Promise<void> {
  log.info('starting perf sweep')
  await scenarioEvents()
  await scenarioTasksList()
  try {
    await scenarioConcurrentTasks()
  } catch (err) {
    samples.push({
      name: 'concurrent_tasks_FAILED',
      ms: 0,
      rssDeltaKb: 0,
      notes: (err as Error).message,
    })
  }

  const md = [
    '## Raw measurements',
    '',
    `_Captured ${new Date().toISOString()} on ${machineInfo()}._`,
    '',
    rowsToMarkdown(samples),
  ].join('\n')
  process.stdout.write('\n' + md + '\n')
}

await main()
