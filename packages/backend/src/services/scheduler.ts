// DAG scheduler for one task. M1 supports a LINEAR subset of the workflow
// schema only:
//   - input nodes      (materialize launcher value as a virtual node_run)
//   - agent-single     (run via runNode)
//   - output nodes     (skipped at scheduling time; detail page reads them)
//
// Multi-process, wrappers (git/loop), and retries are explicitly rejected:
// the task fails with `workflow-unsupported-feature`. The full implementation
// lands in M3 (P-3-02, P-3-03) and M4 (P-4-01).
//
// Cycles are also rejected (cycles inside loop wrappers are only allowed when
// loop wrappers exist, which they don't in M1).

import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, nodeRunOutputs, nodeRuns, skills, tasks } from '@/db/schema'
import { runNode, type ResolvedSkill, type RunResult } from '@/services/runner'
import { emitTaskStatus, getTask } from '@/services/task'
import { createLogger, type Logger } from '@/util/log'
import { splitDiffPerDirectory, splitDiffPerFile, splitDiffPerNFiles } from '@/util/diffSplit'
import { gitStashSnapshot, rollbackToSnapshot } from '@/util/git'
import { Semaphore } from '@/util/semaphore'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

export interface RunTaskOptions {
  taskId: string
  db: DbClient
  appHome: string
  /** Override opencode binary command (tests inject mock-opencode). */
  opencodeCmd?: string[]
  log?: Logger
  /**
   * When aborted, any node currently running is SIGTERMed via runNode and the
   * task transitions to status=canceled. Subsequent nodes are not started.
   */
  signal?: AbortSignal
  /** Default per-node timeout in ms (from settings); node-level override wins. */
  defaultPerNodeTimeoutMs?: number
  /** Global concurrency limit for agent nodes within this task. Default 4. */
  maxConcurrentNodes?: number
  /** Concurrency cap for fan-out child subprocesses (P-3-02). Default 4. */
  multiProcessSubprocessConcurrency?: number
}

/**
 * Drive one task from "pending" to a terminal status. Caller decides whether
 * to await this (tests) or fire-and-forget (HTTP route).
 */
export async function runTask(opts: RunTaskOptions): Promise<void> {
  const log = opts.log ?? createLogger('scheduler')
  const { db, taskId } = opts

  // 1. Load task row.
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const task = taskRows[0]
  if (!task) {
    log.error('runTask: task not found', { taskId })
    return
  }

  // 2. Parse workflow snapshot.
  let definition: WorkflowDefinition
  try {
    const raw: unknown = JSON.parse(task.workflowSnapshot)
    definition = WorkflowDefinitionSchema.parse(raw)
  } catch (err) {
    await failTask(db, taskId, 'snapshot-invalid', (err as Error).message)
    return
  }

  // 3. Mark running.
  await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)

  // 4. Validate node kinds. M3 adds agent-multi (P-3-02). Wrappers + loops
  //    land in P-3-03 / M4.
  for (const node of definition.nodes) {
    if (
      node.kind !== 'input' &&
      node.kind !== 'agent-single' &&
      node.kind !== 'agent-multi' &&
      node.kind !== 'output'
    ) {
      await failTask(
        db,
        taskId,
        `scheduler does not yet support ${node.kind} nodes`,
        `node kind ${node.kind} unsupported in M3`,
        node.id,
      )
      return
    }
  }

  // 5. Topological sort excluding output nodes (they're sinks for display).
  const order = topologicalOrder(definition, log)
  if (order === null) {
    await failTask(db, taskId, 'workflow has a cycle (M1 has no loop wrappers)', 'cycle detected')
    return
  }

  // 6. Walk nodes in order.
  //    Inputs persist as a virtual node_run with one output named 'out'.
  //    Agent-single nodes invoke the runner.
  //    Output nodes are skipped — task detail page reads their bindings.
  const inputsMap: Record<string, string> = (() => {
    try {
      return JSON.parse(task.inputs) as Record<string, string>
    } catch {
      return {}
    }
  })()

  // 6. Run nodes level-parallel under semaphores (P-3-05):
  //    - global semaphore caps concurrent agent nodes (config: maxConcurrentNodes)
  //    - write semaphore (capacity 1) serializes non-readonly agents
  //    - input/output nodes bypass both
  //
  //    Each iteration pulls every node whose upstreams are all done and
  //    kicks them off in parallel. The batch settles before we look at
  //    failures or the abort signal, so an in-flight write isn't stranded.
  const globalSem = new Semaphore(opts.maxConcurrentNodes ?? 4)
  const writeSem = new Semaphore(1)
  const subprocessSem = new Semaphore(opts.multiProcessSubprocessConcurrency ?? 4)
  const upstreamsOf = buildUpstreamMap(definition)
  const remaining = new Map(order.map((n) => [n.id, n]))
  const completed = new Set<string>()

  // P-3-08: resume support — nodes whose latest run is `done` are already
  // complete and should be skipped on a second runTask() call. Pending /
  // failed / interrupted runs flow back through the executor (the runOneNode
  // body picks up the existing pending row when present).
  const priorRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const latestPerNode = new Map<string, (typeof priorRuns)[number]>()
  for (const r of priorRuns) {
    const prev = latestPerNode.get(r.nodeId)
    if (prev === undefined || r.retryIndex > prev.retryIndex) latestPerNode.set(r.nodeId, r)
  }
  for (const [nodeId, r] of latestPerNode) {
    if (r.status === 'done') {
      completed.add(nodeId)
      remaining.delete(nodeId)
    }
  }
  let halt: 'failed' | 'canceled' | null = null
  let haltDetail: { summary: string; message: string; nodeId?: string } | null = null

  while (remaining.size > 0 && halt === null) {
    if (opts.signal?.aborted === true) {
      halt = 'canceled'
      break
    }
    const ready: WorkflowNode[] = []
    for (const n of remaining.values()) {
      const ups = upstreamsOf.get(n.id) ?? []
      if (ups.every((u) => completed.has(u))) ready.push(n)
    }
    if (ready.length === 0) {
      // No progress possible — bug or schedule held by halted batch.
      halt = 'failed'
      haltDetail = { summary: 'scheduler stalled', message: 'no ready nodes' }
      break
    }
    for (const n of ready) remaining.delete(n.id)

    const results = await Promise.all(
      ready.map((node) =>
        runOneNode({
          node,
          definition,
          task,
          taskId,
          db,
          opts,
          inputsMap,
          globalSem,
          writeSem,
          subprocessSem,
          log,
        }),
      ),
    )
    for (let i = 0; i < ready.length; i++) {
      const node = ready[i]!
      const r = results[i]!
      if (r.kind === 'ok') {
        completed.add(node.id)
        continue
      }
      if (halt === null) {
        halt = r.kind
        haltDetail = { summary: r.summary, message: r.message, nodeId: node.id }
      }
    }
  }

  if (halt === 'failed' && haltDetail !== null) {
    await failTask(db, taskId, haltDetail.summary, haltDetail.message, haltDetail.nodeId)
    return
  }
  if (halt === 'canceled') {
    await cancelTaskRow(db, taskId, haltDetail?.nodeId)
    return
  }

  // 7. All nodes done → task done.
  await db.update(tasks).set({ status: 'done', finishedAt: Date.now() }).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
  log.info('task done', { taskId })
}

async function emitStatus(db: DbClient, taskId: string): Promise<void> {
  const t = await getTask(db, taskId)
  if (t !== null) emitTaskStatus(t)
}

function broadcastNodeStatus(
  taskId: string,
  nodeRunId: string,
  nodeId: string,
  status:
    | 'pending'
    | 'running'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'interrupted'
    | 'skipped'
    | 'exhausted',
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'node.status',
    nodeRunId,
    nodeId,
    status,
  })
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function insertNodeRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  status: 'pending' | 'done',
  retryIndex: number = 0,
): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status,
    retryIndex,
    startedAt: now,
    finishedAt: status === 'done' ? now : null,
  })
  return id
}

async function failTask(
  db: DbClient,
  taskId: string,
  errorSummary: string,
  errorMessage: string,
  failedNodeId?: string,
): Promise<void> {
  const set: Record<string, unknown> = {
    status: 'failed',
    finishedAt: Date.now(),
    errorSummary,
    errorMessage,
  }
  if (failedNodeId !== undefined) set.failedNodeId = failedNodeId
  await db.update(tasks).set(set).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
}

async function cancelTaskRow(db: DbClient, taskId: string, failedNodeId?: string): Promise<void> {
  const set: Record<string, unknown> = {
    status: 'canceled',
    finishedAt: Date.now(),
    errorSummary: 'canceled by user',
    errorMessage: 'aborted by signal',
  }
  if (failedNodeId !== undefined) set.failedNodeId = failedNodeId
  await db.update(tasks).set(set).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
}

async function loadAgent(db: DbClient, name: string): Promise<Agent | null> {
  const rows = await db.select().from(agents).where(eq(agents.name, name)).limit(1)
  const row = rows[0]
  if (!row) return null
  const out: Agent = {
    id: row.id,
    name: row.name,
    description: row.description,
    outputs: JSON.parse(row.outputs) as string[],
    readonly: row.readonly,
    permission: JSON.parse(row.permission) as Record<string, unknown>,
    skills: JSON.parse(row.skills) as string[],
    frontmatterExtra: JSON.parse(row.frontmatterExtra) as Record<string, unknown>,
    bodyMd: row.bodyMd,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.model !== null) out.model = row.model
  if (row.variant !== null) out.variant = row.variant
  if (row.temperature !== null) out.temperature = row.temperature
  if (row.steps !== null) out.steps = row.steps
  if (row.maxSteps !== null) out.maxSteps = row.maxSteps
  return out
}

async function resolveSkills(
  db: DbClient,
  appHome: string,
  names: string[],
): Promise<ResolvedSkill[]> {
  const out: ResolvedSkill[] = []
  for (const name of names) {
    const rows = await db.select().from(skills).where(eq(skills.name, name)).limit(1)
    const row = rows[0]
    if (!row) {
      // Skill not in DB — assume it's a project skill that opencode will
      // discover via the worktree's .opencode/skills. No injection needed.
      out.push({ name, sourceKind: 'project' })
      continue
    }
    if (row.sourceKind === 'managed') {
      const skillPath = `${appHome}/${row.managedPath ?? `skills/${name}/files`}`
      out.push({ name, sourceKind: 'managed', sourcePath: skillPath })
    } else if (row.sourceKind === 'external' && row.externalPath !== null) {
      out.push({ name, sourceKind: 'external', sourcePath: row.externalPath })
    }
  }
  return out
}

/**
 * Look up upstream node_run outputs for each incoming edge targeting `nodeId`
 * and produce the resolved input map for the next runNode invocation.
 * Multiple edges → same target port → concatenated with a horizontal-rule
 * separator (per design/proposal.md §4.2.2).
 */
async function resolveUpstreamInputs(
  db: DbClient,
  taskId: string,
  edges: WorkflowEdge[],
  nodeId: string,
  log: Logger,
): Promise<Record<string, string>> {
  const grouped = new Map<string, string[]>()
  const incoming = edges.filter((e) => e.target.nodeId === nodeId)

  for (const edge of incoming) {
    // Find the node_run for the upstream node (M1: one run per node).
    const runRows = await db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.nodeId, edge.source.nodeId))
      .limit(1)
    const run = runRows.find((r) => r.taskId === taskId)
    if (!run) {
      log.warn('upstream node_run not found', { taskId, sourceNodeId: edge.source.nodeId })
      continue
    }
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, run.id))
    const port = outRows.find((o) => o.portName === edge.source.portName)
    const content = port?.content ?? ''
    const list = grouped.get(edge.target.portName) ?? []
    list.push(content)
    grouped.set(edge.target.portName, list)
  }

  const result: Record<string, string> = {}
  for (const [name, values] of grouped) {
    result[name] = values.length === 1 ? (values[0] ?? '') : values.join('\n\n---\n\n')
  }
  return result
}

/**
 * Kahn's algorithm. Returns null if the graph has a cycle (M1: only one
 * caller, which fails the task immediately).
 *
 * Excludes 'output' nodes from the order — they don't run; the detail
 * page reads them on demand.
 */
function topologicalOrder(def: WorkflowDefinition, _log: Logger): WorkflowNode[] | null {
  const nodes = def.nodes.filter((n) => n.kind !== 'output')
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map<string, number>()
  for (const n of nodes) inDegree.set(n.id, 0)
  for (const e of def.edges) {
    if (!nodeById.has(e.source.nodeId) || !nodeById.has(e.target.nodeId)) continue
    inDegree.set(e.target.nodeId, (inDegree.get(e.target.nodeId) ?? 0) + 1)
  }
  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }
  const out: WorkflowNode[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    const n = nodeById.get(id)
    if (n) out.push(n)
    for (const e of def.edges) {
      if (e.source.nodeId !== id) continue
      if (!nodeById.has(e.target.nodeId)) continue
      const next = (inDegree.get(e.target.nodeId) ?? 0) - 1
      inDegree.set(e.target.nodeId, next)
      if (next === 0) queue.push(e.target.nodeId)
    }
  }
  if (out.length !== nodes.length) return null // cycle
  return out
}

function pickString(node: WorkflowNode, key: string): string | null {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function pickNumber(node: WorkflowNode, key: string): number | undefined {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Latest node_run.preSnapshot for `nodeId` on this task (highest retry_index). */
async function readSnapshotForLatestRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
): Promise<string> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
    .orderBy(desc(nodeRuns.retryIndex))
    .limit(1)
  return rows[0]?.preSnapshot ?? ''
}

/** nodeId → list of upstream nodeIds (deduped). Includes `sourcePort` of
 *  agent-multi nodes as an upstream dep (not modeled as an edge). */
function buildUpstreamMap(definition: WorkflowDefinition): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const n of definition.nodes) m.set(n.id, [])
  for (const e of definition.edges) {
    const list = m.get(e.target.nodeId)
    if (list === undefined) continue
    if (!list.includes(e.source.nodeId)) list.push(e.source.nodeId)
  }
  for (const n of definition.nodes) {
    if (n.kind !== 'agent-multi') continue
    const sp = (n as Record<string, unknown>).sourcePort as { nodeId?: unknown } | undefined
    if (sp === undefined || typeof sp.nodeId !== 'string') continue
    const list = m.get(n.id) ?? []
    if (!list.includes(sp.nodeId)) list.push(sp.nodeId)
    m.set(n.id, list)
  }
  return m
}

interface OneNodeResult {
  kind: 'ok' | 'failed' | 'canceled'
  summary: string
  message: string
}

interface OneNodeContext {
  node: WorkflowNode
  definition: WorkflowDefinition
  task: typeof tasks.$inferSelect
  taskId: string
  db: DbClient
  opts: RunTaskOptions
  inputsMap: Record<string, string>
  globalSem: Semaphore
  writeSem: Semaphore
  /** Independent pool for multi-process child runs (P-3-02). */
  subprocessSem: Semaphore
  log: Logger
}

async function runOneNode(ctx: OneNodeContext): Promise<OneNodeResult> {
  const { node, definition, task, taskId, db, opts, inputsMap, globalSem, writeSem, log } = ctx
  if (opts.signal?.aborted === true) {
    return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
  }
  if (node.kind === 'output') return { kind: 'ok', summary: '', message: '' }

  if (node.kind === 'input') {
    const inputKey = pickString(node, 'inputKey')
    if (inputKey === null) {
      return {
        kind: 'failed',
        summary: `input node ${node.id} missing inputKey`,
        message: 'invalid',
      }
    }
    const value = inputsMap[inputKey] ?? ''
    const nrId = await insertNodeRun(db, taskId, node.id, 'done')
    await db.insert(nodeRunOutputs).values({ nodeRunId: nrId, portName: 'out', content: value })
    broadcastNodeStatus(taskId, nrId, node.id, 'done')
    return { kind: 'ok', summary: '', message: '' }
  }

  const agentName = pickString(node, 'agentName')
  if (agentName === null) {
    return {
      kind: 'failed',
      summary: `node ${node.id} missing agentName`,
      message: 'invalid agent node',
    }
  }
  const agent = await loadAgent(db, agentName)
  if (agent === null) {
    return { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
  }

  // agent-multi (P-3-02): the parent waits for sourcePort content from
  // upstream, shards it, then fans out a child node_run per shard with the
  // sub-process semaphore providing the independent concurrency pool.
  if (node.kind === 'agent-multi') {
    return runFanOutNode(ctx, agent)
  }

  const upstreamInputs = await resolveUpstreamInputs(db, taskId, definition.edges, node.id, log)
  const resolvedSkills = await resolveSkills(db, opts.appHome, agent.skills)
  const promptTemplate = pickString(node, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = pickNumber(node, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs
  const maxRetries = pickNumber(node, 'retries') ?? 0

  // Pick up an existing pending node_run if the scheduler is resuming this
  // node (P-3-08 set them back to pending). Otherwise create a new run with
  // retry_index = max existing + 1 — or 0 if this is the first attempt.
  const existing = await db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
    .orderBy(asc(nodeRuns.startedAt))
  const sameNodeRuns = existing.filter((r) => r.nodeId === node.id)
  let retryIndex = 0
  let nodeRunId: string
  const pendingExisting = sameNodeRuns.find((r) => r.status === 'pending')
  if (pendingExisting !== undefined) {
    nodeRunId = pendingExisting.id
    retryIndex = pendingExisting.retryIndex
  } else {
    retryIndex =
      sameNodeRuns.length === 0 ? 0 : Math.max(...sameNodeRuns.map((r) => r.retryIndex)) + 1
    nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending', retryIndex)
  }
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')

  // Acquire semaphores. Order matters: global → write so a write node can't
  // hold the write slot while waiting for its global slot.
  const releaseGlobal = await globalSem.acquire()
  const releaseWrite = agent.readonly ? null : await writeSem.acquire()

  let lastResult: RunResult | null = null
  let lastError: string | null = null

  try {
    // Retry loop (P-3-06). retry_index tracks the attempt; the very first
    // attempt is 0. We always run at least once. Read-only nodes don't
    // rollback because they didn't snapshot.
    for (let attempt = retryIndex; attempt <= retryIndex + maxRetries; attempt++) {
      if (attempt > retryIndex) {
        // Rollback before retry (write nodes only) using THIS node_run's
        // snapshot before the previous attempt.
        const snap = await readSnapshotForLatestRun(db, taskId, node.id)
        if (!agent.readonly && snap !== '') {
          try {
            await rollbackToSnapshot(task.worktreePath, snap)
          } catch (err) {
            log.warn('retry rollback failed', {
              nodeId: node.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending', attempt)
        broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
      }

      // P-3-07: snapshot the worktree before a non-readonly node.
      if (!agent.readonly) {
        try {
          const sha = await gitStashSnapshot(task.worktreePath)
          await db.update(nodeRuns).set({ preSnapshot: sha }).where(eq(nodeRuns.id, nodeRunId))
        } catch (err) {
          log.warn('pre-snapshot failed', {
            nodeRunId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      try {
        lastResult = await runNode({
          taskId,
          nodeRunId,
          agent,
          inputs: upstreamInputs,
          worktreePath: task.worktreePath,
          templateMeta: {
            repoPath: task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: node.id,
          },
          ...(promptTemplate !== undefined ? { promptTemplate } : {}),
          ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
          skills: resolvedSkills,
          appHome: opts.appHome,
          ...(opts.opencodeCmd ? { opencodeCmd: opts.opencodeCmd } : {}),
          db,
          log: log.child('run'),
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        lastResult = {
          status: 'failed',
          exitCode: null,
          outputs: {},
          tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
          prompt: '',
          errorMessage: `node ${node.id} threw: ${msg}`,
        }
        lastError = msg
      }

      broadcastNodeStatus(taskId, nodeRunId, node.id, lastResult.status)
      if (lastResult.status === 'done' || lastResult.status === 'canceled') break
      // Otherwise loop — caps at retryIndex + maxRetries inclusive.
    }
  } finally {
    releaseWrite?.()
    releaseGlobal()
  }

  if (lastResult === null) {
    return {
      kind: 'failed',
      summary: 'node produced no result',
      message: lastError ?? 'unknown',
    }
  }
  if (lastResult.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: 'node canceled',
      message: lastResult.errorMessage ?? 'canceled',
    }
  }
  if (lastResult.status !== 'done') {
    return {
      kind: 'failed',
      summary: lastResult.errorMessage ?? `node ${node.id} ${lastResult.status}`,
      message: lastResult.errorMessage ?? lastResult.status,
    }
  }
  return { kind: 'ok', summary: '', message: '' }
}

// ---------------------------------------------------------------------------
// Multi-process fan-out (P-3-02)
// ---------------------------------------------------------------------------

async function runFanOutNode(ctx: OneNodeContext, agent: Agent): Promise<OneNodeResult> {
  const { node, definition, task, taskId, db, opts, subprocessSem, log } = ctx

  // 1. Resolve the source port (the diff to shard).
  const sourcePort = (node as Record<string, unknown>).sourcePort as
    | { nodeId?: unknown; portName?: unknown }
    | undefined
  if (
    sourcePort === undefined ||
    typeof sourcePort.nodeId !== 'string' ||
    typeof sourcePort.portName !== 'string'
  ) {
    return {
      kind: 'failed',
      summary: `agent-multi node ${node.id} missing sourcePort`,
      message: 'sourcePort required',
    }
  }

  // 2. Locate the latest node_run for the source node and pull its content.
  const sourceRuns = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, sourcePort.nodeId)))
    .orderBy(desc(nodeRuns.retryIndex))
    .limit(1)
  const sourceRun = sourceRuns[0]
  if (sourceRun === undefined) {
    return {
      kind: 'failed',
      summary: `agent-multi node ${node.id} sourcePort ${sourcePort.nodeId} has no completed run`,
      message: 'source-not-ready',
    }
  }
  const sourceOuts = await db
    .select()
    .from(nodeRunOutputs)
    .where(
      and(
        eq(nodeRunOutputs.nodeRunId, sourceRun.id),
        eq(nodeRunOutputs.portName, sourcePort.portName),
      ),
    )
  const sourceContent = sourceOuts[0]?.content ?? ''

  // 3. Open the parent node_run + apply default fanout strategy.
  const parentRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0)
  broadcastNodeStatus(taskId, parentRunId, node.id, 'running')

  // 4. Empty source → parent done immediately with empty outputs + no errors.
  if (sourceContent.trim() === '') {
    for (const port of agent.outputs) {
      await db
        .insert(nodeRunOutputs)
        .values({ nodeRunId: parentRunId, portName: port, content: '' })
    }
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: parentRunId, portName: 'errors', content: '' })
    await db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, parentRunId))
    broadcastNodeStatus(taskId, parentRunId, node.id, 'done')
    return { kind: 'ok', summary: '', message: '' }
  }

  // 5. Shard via configured strategy. Default = per-file.
  const strategy = (node as Record<string, unknown>).shardingStrategy as
    | { kind: 'per-file' }
    | { kind: 'per-n-files'; n: number }
    | { kind: 'per-directory'; depth?: number }
    | undefined
  let shards
  try {
    if (strategy === undefined || strategy.kind === 'per-file') {
      shards = splitDiffPerFile(sourceContent)
    } else if (strategy.kind === 'per-n-files') {
      shards = splitDiffPerNFiles(sourceContent, strategy.n)
    } else {
      shards = splitDiffPerDirectory(sourceContent, strategy.depth ?? 1)
    }
  } catch (err) {
    return {
      kind: 'failed',
      summary: `shard split failed for node ${node.id}`,
      message: err instanceof Error ? err.message : String(err),
    }
  }

  // 6. Per-shard child runs. Inherit upstream non-source inputs verbatim.
  const upstreamInputs = await resolveUpstreamInputs(db, taskId, definition.edges, node.id, log)
  const resolvedSkills = await resolveSkills(db, opts.appHome, agent.skills)
  const promptTemplate = pickString(node, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = pickNumber(node, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs

  interface ChildResult {
    shardKey: string
    runId: string
    status: RunResult['status']
    outputs: Record<string, string>
    errorMessage?: string
  }

  const children = await Promise.all(
    shards.map((shard) =>
      subprocessSem.run<ChildResult>(async () => {
        const childRunId = ulid()
        await db.insert(nodeRuns).values({
          id: childRunId,
          taskId,
          nodeId: node.id,
          status: 'pending',
          retryIndex: 0,
          parentNodeRunId: parentRunId,
          shardKey: shard.shardKey,
          startedAt: Date.now(),
        })
        broadcastNodeStatus(taskId, childRunId, node.id, 'pending')

        const shardInputs: Record<string, string> = {
          ...upstreamInputs,
          [sourcePort.portName as string]: shard.content,
        }
        try {
          const result = await runNode({
            taskId,
            nodeRunId: childRunId,
            agent,
            inputs: shardInputs,
            worktreePath: task.worktreePath,
            templateMeta: {
              repoPath: task.repoPath,
              baseBranch: task.baseBranch,
              taskId,
              nodeId: node.id,
              shardKey: shard.shardKey,
            },
            ...(promptTemplate !== undefined ? { promptTemplate } : {}),
            ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
            skills: resolvedSkills,
            appHome: opts.appHome,
            ...(opts.opencodeCmd ? { opencodeCmd: opts.opencodeCmd } : {}),
            db,
            log: log.child('fanout'),
            ...(opts.signal ? { signal: opts.signal } : {}),
          })
          broadcastNodeStatus(taskId, childRunId, node.id, result.status)
          return {
            shardKey: shard.shardKey,
            runId: childRunId,
            status: result.status,
            outputs: result.outputs,
            ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          broadcastNodeStatus(taskId, childRunId, node.id, 'failed')
          return {
            shardKey: shard.shardKey,
            runId: childRunId,
            status: 'failed',
            outputs: {},
            errorMessage: msg,
          }
        }
      }),
    ),
  )

  // 7. Aggregate. Per declared output port, concat successful shards sorted
  //    by shardKey (dictionary order). errors port = list of failed shards.
  const sorted = [...children].sort((a, b) => a.shardKey.localeCompare(b.shardKey))
  for (const port of agent.outputs) {
    const content = sorted
      .filter((c) => c.status === 'done')
      .map((c) => c.outputs[port] ?? '')
      .join('\n')
    await db.insert(nodeRunOutputs).values({ nodeRunId: parentRunId, portName: port, content })
  }
  const failed = sorted.filter((c) => c.status !== 'done')
  const errorsBody = failed
    .map((c) => `## ${c.shardKey} (${c.status})\n${c.errorMessage ?? ''}`)
    .join('\n\n')
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: parentRunId, portName: 'errors', content: errorsBody })

  // 8. Mark parent done if at least one shard succeeded — even with failed
  //    shards, the errors port surfaces them. If ALL shards failed, fail.
  const allFailed = sorted.length > 0 && sorted.every((c) => c.status !== 'done')
  const finalStatus = allFailed ? 'failed' : 'done'
  await db
    .update(nodeRuns)
    .set({
      status: finalStatus,
      finishedAt: Date.now(),
      ...(allFailed ? { errorMessage: 'all shards failed' } : {}),
    })
    .where(eq(nodeRuns.id, parentRunId))
  broadcastNodeStatus(taskId, parentRunId, node.id, finalStatus)
  if (allFailed) {
    return {
      kind: 'failed',
      summary: `agent-multi ${node.id} all ${sorted.length} shards failed`,
      message: errorsBody,
    }
  }
  return { kind: 'ok', summary: '', message: '' }
}
