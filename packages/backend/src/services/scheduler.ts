// DAG scheduler for one task.
//
// M3 added agent-multi (fan-out), wrapper-git, retries, pre-snapshot rollback,
// resume, and single-node retry. M4 P-4-01 + P-4-03 extend the scheduler with
//   - wrapper-loop iteration scheduling + 3 built-in exit conditions
//   - recursive "scope" execution so wrapper nesting works for any composition
//     (git-in-loop, loop-in-git, loop-in-loop, git-in-git)
//
// A "scope" is the set of node ids that execute under one parent — the top
// level is the root scope; each wrapper has an inner scope = its nodeIds[].
// The level-parallel scheduler operates on a scope at a time. Wrapper nodes
// live in their parent scope; when one is reached, the scheduler recurses
// into the wrapper's inner scope (once for wrapper-git, up to maxIterations
// times for wrapper-loop).

import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, nodeRunOutputs, nodeRuns, skills, tasks } from '@/db/schema'
import { evaluateExitCondition, parseExitCondition } from '@/services/exitCondition'
import { runNode, type ResolvedSkill, type RunResult } from '@/services/runner'
import { emitTaskStatus, getTask } from '@/services/task'
import { createLogger, type Logger } from '@/util/log'
import { splitDiffPerDirectory, splitDiffPerFile, splitDiffPerNFiles } from '@/util/diffSplit'
import { gitDiffSnapshot, gitStashSnapshot, rollbackToSnapshot, runGit } from '@/util/git'
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

type NodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'skipped'
  | 'exhausted'

interface SchedulerState {
  db: DbClient
  task: typeof tasks.$inferSelect
  taskId: string
  definition: WorkflowDefinition
  opts: RunTaskOptions
  log: Logger
  inputsMap: Record<string, string>
  globalSem: Semaphore
  writeSem: Semaphore
  subprocessSem: Semaphore
  /** nodeId → innermost wrapper id containing it. */
  containerOf: Map<string, string>
  /** Top-level scope set of node ids. */
  topLevelIds: Set<string>
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

  // 4. Validate node kinds.
  for (const node of definition.nodes) {
    if (
      node.kind !== 'input' &&
      node.kind !== 'agent-single' &&
      node.kind !== 'agent-multi' &&
      node.kind !== 'output' &&
      node.kind !== 'wrapper-git' &&
      node.kind !== 'wrapper-loop'
    ) {
      await failTask(
        db,
        taskId,
        `scheduler does not yet support ${node.kind} nodes`,
        `node kind ${node.kind} unsupported`,
        node.id,
      )
      return
    }
  }

  // 5. Containment map (transitive — innermost wrapper wins).
  const containerOf = buildContainerMap(definition)
  const topLevelIds = new Set<string>()
  for (const n of definition.nodes) {
    if (!containerOf.has(n.id)) topLevelIds.add(n.id)
  }

  // 6. Pre-validate top-level scope for cycles (inner scopes are checked per
  //    recursive call). Output nodes are excluded — they don't execute.
  const topLevelOrder = topologicalOrder(
    definition.nodes.filter((n) => topLevelIds.has(n.id)),
    definition.edges,
    log,
  )
  if (topLevelOrder === null) {
    await failTask(db, taskId, 'workflow has a cycle outside any loop wrapper', 'cycle detected')
    return
  }

  // 7. Inputs map from launcher form.
  const inputsMap: Record<string, string> = (() => {
    try {
      return JSON.parse(task.inputs) as Record<string, string>
    } catch {
      return {}
    }
  })()

  const state: SchedulerState = {
    db,
    task,
    taskId,
    definition,
    opts,
    log,
    inputsMap,
    globalSem: new Semaphore(opts.maxConcurrentNodes ?? 4),
    writeSem: new Semaphore(1),
    subprocessSem: new Semaphore(opts.multiProcessSubprocessConcurrency ?? 4),
    containerOf,
    topLevelIds,
  }

  // 8. Drive the top-level scope.
  const result = await runScope(state, {
    scopeIds: topLevelIds,
    iteration: 0,
    log,
  })

  if (result.kind === 'failed' && result.detail) {
    await failTask(db, taskId, result.detail.summary, result.detail.message, result.detail.nodeId)
    return
  }
  if (result.kind === 'canceled') {
    await cancelTaskRow(db, taskId, result.detail?.nodeId)
    return
  }

  // 9. Done.
  await db.update(tasks).set({ status: 'done', finishedAt: Date.now() }).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
  log.info('task done', { taskId })
}

// -----------------------------------------------------------------------------
// scope execution
// -----------------------------------------------------------------------------

interface ScopeResult {
  kind: 'ok' | 'failed' | 'canceled'
  detail?: { summary: string; message: string; nodeId?: string }
}

interface ScopeArgs {
  scopeIds: Set<string>
  iteration: number
  log: Logger
}

async function runScope(state: SchedulerState, args: ScopeArgs): Promise<ScopeResult> {
  const { db, taskId, definition, opts } = state
  const { scopeIds, iteration, log } = args

  // Filter scope nodes (exclude output sinks — they don't run).
  const scopeNodes = definition.nodes.filter((n) => scopeIds.has(n.id) && n.kind !== 'output')
  // Upstream map restricted to in-scope sources.
  const upstreamsOf = buildScopeUpstreams(scopeNodes, definition.edges)
  const remaining = new Map(scopeNodes.map((n) => [n.id, n]))
  const completed = new Set<string>()

  // P-3-08 resume: nodes whose latest run at THIS iteration is `done` are
  // pre-completed. Inner scopes additionally narrow by iteration so re-runs
  // start fresh per iteration.
  const priorRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const latestPerNode = new Map<string, (typeof priorRuns)[number]>()
  for (const r of priorRuns) {
    if (r.iteration !== iteration) continue
    if (!scopeIds.has(r.nodeId)) continue
    if (r.parentNodeRunId !== null) continue // skip fan-out child rows
    const prev = latestPerNode.get(r.nodeId)
    if (prev === undefined || r.retryIndex > prev.retryIndex) latestPerNode.set(r.nodeId, r)
  }
  for (const [nodeId, r] of latestPerNode) {
    if (r.status === 'done') {
      completed.add(nodeId)
      remaining.delete(nodeId)
    }
  }

  while (remaining.size > 0) {
    if (opts.signal?.aborted === true) {
      return { kind: 'canceled', detail: { summary: 'task canceled', message: 'signal aborted' } }
    }
    const ready: WorkflowNode[] = []
    for (const n of remaining.values()) {
      const ups = upstreamsOf.get(n.id) ?? []
      if (ups.every((u) => completed.has(u))) ready.push(n)
    }
    if (ready.length === 0) {
      return {
        kind: 'failed',
        detail: { summary: 'scheduler stalled', message: 'no ready nodes in scope' },
      }
    }
    for (const n of ready) remaining.delete(n.id)

    const results = await Promise.all(
      ready.map((node) => runOneNode(state, { node, iteration, log })),
    )
    for (let i = 0; i < ready.length; i++) {
      const node = ready[i]!
      const r = results[i]!
      if (r.kind === 'ok') {
        completed.add(node.id)
        continue
      }
      return {
        kind: r.kind,
        detail: { summary: r.summary, message: r.message, nodeId: node.id },
      }
    }
  }

  return { kind: 'ok' }
}

// -----------------------------------------------------------------------------
// per-node execution
// -----------------------------------------------------------------------------

interface OneNodeResult {
  kind: 'ok' | 'failed' | 'canceled'
  summary: string
  message: string
}

interface OneNodeArgs {
  node: WorkflowNode
  iteration: number
  log: Logger
}

async function runOneNode(state: SchedulerState, args: OneNodeArgs): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, inputsMap, globalSem, writeSem, log } = state
  const { node, iteration } = args

  if (opts.signal?.aborted === true) {
    return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
  }
  if (node.kind === 'output') return { kind: 'ok', summary: '', message: '' }

  if (node.kind === 'wrapper-git') {
    return runGitWrapperNode(state, args)
  }
  if (node.kind === 'wrapper-loop') {
    return runLoopWrapperNode(state, args)
  }

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
    const nrId = await insertNodeRun(db, taskId, node.id, 'done', 0, iteration)
    // RFC-004: an input node's single output port is named after its inputKey,
    // so edges authored on the canvas (whose source.portName defaults to the
    // visible handle label = inputKey) actually resolve. Previously hardcoded
    // to 'out', which mismatched every workflow created through the editor.
    await db.insert(nodeRunOutputs).values({ nodeRunId: nrId, portName: inputKey, content: value })
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

  if (node.kind === 'agent-multi') {
    return runFanOutNode(state, args, agent)
  }

  const upstreamInputs = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
  )
  const resolvedSkills = await resolveSkills(db, opts.appHome, agent.skills)
  const promptTemplate = pickString(node, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = pickNumber(node, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs
  const maxRetries = pickNumber(node, 'retries') ?? 0

  // Pick up an existing pending node_run at this iteration; otherwise create
  // a fresh run with retry_index = max-existing-in-iter + 1 (or 0).
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  let retryIndex = 0
  let nodeRunId: string
  const pendingExisting = sameNodeIterRuns.find(
    (r) => r.status === 'pending' && r.parentNodeRunId === null,
  )
  if (pendingExisting !== undefined) {
    nodeRunId = pendingExisting.id
    retryIndex = pendingExisting.retryIndex
  } else {
    retryIndex =
      sameNodeIterRuns.length === 0 ? 0 : Math.max(...sameNodeIterRuns.map((r) => r.retryIndex)) + 1
    nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending', retryIndex, iteration)
  }
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')

  const releaseGlobal = await globalSem.acquire()
  const releaseWrite = agent.readonly ? null : await writeSem.acquire()

  let lastResult: RunResult | null = null
  let lastError: string | null = null

  try {
    for (let attempt = retryIndex; attempt <= retryIndex + maxRetries; attempt++) {
      if (attempt > retryIndex) {
        const snap = await readSnapshotForLatestRun(db, taskId, node.id, iteration)
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
        nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending', attempt, iteration)
        broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
      }

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
            iteration,
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

// -----------------------------------------------------------------------------
// wrapper-loop (P-4-01)
// -----------------------------------------------------------------------------

async function runLoopWrapperNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId } = state
  const { node, iteration: parentIteration } = args
  const inner = pickStringArray(node, 'nodeIds')
  if (inner.length === 0) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} has no inner nodes`,
      message: 'wrapper-empty',
    }
  }
  const maxIter = pickNumber(node, 'maxIterations')
  if (maxIter === undefined || maxIter < 1) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} missing maxIterations`,
      message: 'wrapper-loop-max-iterations',
    }
  }
  const cond = parseExitCondition((node as Record<string, unknown>).exitCondition)
  if (cond === null) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} invalid exitCondition`,
      message: 'wrapper-loop-exit-condition',
    }
  }
  const bindings = readBindings(node, 'outputBindings')

  const wrapperRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, parentIteration)
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')

  const innerSet = new Set(inner)
  for (let i = 0; i < maxIter; i++) {
    const subRes = await runScope(state, {
      scopeIds: innerSet,
      iteration: i,
      log: args.log.child(`loop:${node.id}`),
    })
    if (subRes.kind === 'canceled') {
      await db
        .update(nodeRuns)
        .set({ status: 'canceled', finishedAt: Date.now() })
        .where(eq(nodeRuns.id, wrapperRunId))
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
      return { kind: 'canceled', summary: subRes.detail?.summary ?? 'canceled', message: '' }
    }
    if (subRes.kind === 'failed') {
      await db
        .update(nodeRuns)
        .set({
          status: 'failed',
          finishedAt: Date.now(),
          errorMessage: subRes.detail?.message ?? 'inner failed',
        })
        .where(eq(nodeRuns.id, wrapperRunId))
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: subRes.detail?.summary ?? `wrapper-loop ${node.id} inner failed`,
        message: subRes.detail?.message ?? 'inner failed',
      }
    }

    // Evaluate exit condition against the current iteration's outputs.
    const portContent = await readPortAtIteration(db, taskId, cond.nodeId, cond.portName, i)
    if (evaluateExitCondition(cond, portContent)) {
      // Bind outputs from this iteration.
      for (const b of bindings) {
        const v = await readPortAtIteration(db, taskId, b.bind.nodeId, b.bind.portName, i)
        await db
          .insert(nodeRunOutputs)
          .values({ nodeRunId: wrapperRunId, portName: b.name, content: v })
      }
      await db
        .update(nodeRuns)
        .set({ status: 'done', finishedAt: Date.now() })
        .where(eq(nodeRuns.id, wrapperRunId))
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
      return { kind: 'ok', summary: '', message: '' }
    }
  }

  // Exhausted: max iterations without exit.
  await db
    .update(nodeRuns)
    .set({ status: 'exhausted', finishedAt: Date.now(), errorMessage: 'max iterations reached' })
    .where(eq(nodeRuns.id, wrapperRunId))
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'exhausted')
  return {
    kind: 'failed',
    summary: `wrapper-loop ${node.id} exhausted after ${maxIter} iterations`,
    message: 'wrapper-loop-exhausted',
  }
}

// -----------------------------------------------------------------------------
// wrapper-git (P-3-03 + nested via P-4-03)
//
// The wrapper takes a baseline = HEAD, recursively executes its inner scope
// once, then computes the diff vs the baseline. This works for unnested
// wrappers and for wrapper-loop-in-wrapper-git (the inner scope can itself
// contain a wrapper-loop).
// -----------------------------------------------------------------------------

async function runGitWrapperNode(state: SchedulerState, args: OneNodeArgs): Promise<OneNodeResult> {
  const { db, task, taskId } = state
  const { node, iteration } = args
  const inner = pickStringArray(node, 'nodeIds')
  if (inner.length === 0) {
    return {
      kind: 'failed',
      summary: `wrapper-git ${node.id} has no inner nodes`,
      message: 'wrapper-empty',
    }
  }

  const wrapperRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, iteration)
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')

  // Baseline = HEAD of the worktree right before inner runs.
  let baseline = ''
  try {
    const r = await runGit(task.worktreePath, ['rev-parse', 'HEAD'])
    if (r.exitCode === 0) baseline = r.stdout.trim()
  } catch {
    /* empty fixture in tests */
  }

  // Recurse into inner scope.
  const subRes = await runScope(state, {
    scopeIds: new Set(inner),
    iteration,
    log: args.log.child(`git:${node.id}`),
  })
  if (subRes.kind === 'canceled') {
    await db
      .update(nodeRuns)
      .set({ status: 'canceled', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, wrapperRunId))
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
    return { kind: 'canceled', summary: 'inner canceled', message: '' }
  }
  if (subRes.kind === 'failed') {
    await db
      .update(nodeRuns)
      .set({
        status: 'failed',
        finishedAt: Date.now(),
        errorMessage: subRes.detail?.message ?? 'inner failed',
      })
      .where(eq(nodeRuns.id, wrapperRunId))
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
    return {
      kind: 'failed',
      summary: subRes.detail?.summary ?? `wrapper-git ${node.id} inner failed`,
      message: subRes.detail?.message ?? 'inner failed',
    }
  }

  // Compute diff vs baseline (or HEAD as fallback when worktree was empty).
  let diff = ''
  try {
    diff = await gitDiffSnapshot(task.worktreePath, baseline || 'HEAD')
  } catch {
    diff = ''
  }
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: wrapperRunId, portName: 'git_diff', content: diff })
  await db
    .update(nodeRuns)
    .set({ status: 'done', finishedAt: Date.now() })
    .where(eq(nodeRuns.id, wrapperRunId))
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
  return { kind: 'ok', summary: '', message: '' }
}

// -----------------------------------------------------------------------------
// fan-out (P-3-02), kept structurally identical to M3 except for iteration.
// -----------------------------------------------------------------------------

async function runFanOutNode(
  state: SchedulerState,
  args: OneNodeArgs,
  agent: Agent,
): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, subprocessSem, log } = state
  const { node, iteration } = args

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

  // Latest source-node run not narrower than current iteration; prefer in-iter
  // run, otherwise fall back to most recent run from a prior iteration.
  const sourceRun = await pickLatestSourceRun(db, taskId, sourcePort.nodeId as string, iteration)
  if (sourceRun === null) {
    return {
      kind: 'failed',
      summary: `agent-multi node ${node.id} sourcePort ${sourcePort.nodeId as string} has no completed run`,
      message: 'source-not-ready',
    }
  }
  const sourceOuts = await db
    .select()
    .from(nodeRunOutputs)
    .where(
      and(
        eq(nodeRunOutputs.nodeRunId, sourceRun.id),
        eq(nodeRunOutputs.portName, sourcePort.portName as string),
      ),
    )
  const sourceContent = sourceOuts[0]?.content ?? ''

  const parentRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, iteration)
  broadcastNodeStatus(taskId, parentRunId, node.id, 'running')

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

  const upstreamInputs = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
  )
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
          iteration,
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
              iteration,
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

  const allFailed = sorted.length > 0 && sorted.every((c) => c.status !== 'done')
  const finalStatus: NodeStatus = allFailed ? 'failed' : 'done'
  // P-4-05: aggregate child tok_total into the parent so resource-limit ticks
  // and the UI's per-node stats reflect actual cost.
  const childTok = await sumChildTokens(db, parentRunId)
  await db
    .update(nodeRuns)
    .set({
      status: finalStatus,
      finishedAt: Date.now(),
      tokInput: childTok.input,
      tokOutput: childTok.output,
      tokCacheCreate: childTok.cacheCreate,
      tokCacheRead: childTok.cacheRead,
      tokTotal: childTok.total,
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

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function emitStatus(db: DbClient, taskId: string): Promise<void> {
  const t = await getTask(db, taskId)
  if (t !== null) emitTaskStatus(t)
}

function broadcastNodeStatus(
  taskId: string,
  nodeRunId: string,
  nodeId: string,
  status: NodeStatus,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'node.status',
    nodeRunId,
    nodeId,
    status,
  })
}

async function insertNodeRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  status: 'pending' | 'done',
  retryIndex: number = 0,
  iteration: number = 0,
): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status,
    retryIndex,
    iteration,
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
 * Resolve upstream port values for one node at a given iteration.
 *
 * For each incoming edge: pick the upstream node's latest run whose iteration
 * is ≤ current iteration (prefer the highest matching iteration, then highest
 * retry_index). This lets inner-scope nodes see top-level node outputs
 * (iteration=0) and same-iteration upstream outputs from earlier ready batches.
 */
async function resolveUpstreamInputs(
  db: DbClient,
  taskId: string,
  edges: WorkflowEdge[],
  nodeId: string,
  iteration: number,
  log: Logger,
): Promise<Record<string, string>> {
  const grouped = new Map<string, string[]>()
  const incoming = edges.filter((e) => e.target.nodeId === nodeId)

  for (const edge of incoming) {
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, edge.source.nodeId)))
    const candidates = rows
      .filter((r) => r.iteration <= iteration && r.parentNodeRunId === null)
      .sort((a, b) => {
        if (b.iteration !== a.iteration) return b.iteration - a.iteration
        return b.retryIndex - a.retryIndex
      })
    const run = candidates[0]
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

async function pickLatestSourceRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
): Promise<typeof nodeRuns.$inferSelect | null> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
  const candidates = rows
    .filter((r) => r.iteration <= iteration && r.parentNodeRunId === null)
    .sort((a, b) => {
      if (b.iteration !== a.iteration) return b.iteration - a.iteration
      return b.retryIndex - a.retryIndex
    })
  return candidates[0] ?? null
}

async function sumChildTokens(
  db: DbClient,
  parentRunId: string,
): Promise<{
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  total: number
}> {
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.parentNodeRunId, parentRunId))
  let input = 0
  let output = 0
  let cacheCreate = 0
  let cacheRead = 0
  for (const r of rows) {
    input += r.tokInput ?? 0
    output += r.tokOutput ?? 0
    cacheCreate += r.tokCacheCreate ?? 0
    cacheRead += r.tokCacheRead ?? 0
  }
  return { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead }
}

async function readPortAtIteration(
  db: DbClient,
  taskId: string,
  nodeId: string,
  portName: string,
  iteration: number,
): Promise<string> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, nodeId),
        eq(nodeRuns.iteration, iteration),
      ),
    )
  const r = rows
    .filter((r) => r.parentNodeRunId === null)
    .sort((a, b) => b.retryIndex - a.retryIndex)[0]
  if (!r) return ''
  const out = await db
    .select()
    .from(nodeRunOutputs)
    .where(and(eq(nodeRunOutputs.nodeRunId, r.id), eq(nodeRunOutputs.portName, portName)))
  return out[0]?.content ?? ''
}

/**
 * Topological order using Kahn's algorithm over a node subset. Edges whose
 * endpoints are outside the subset are ignored. Returns null if a cycle is
 * detected.
 */
function topologicalOrder(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  _log: Logger,
): WorkflowNode[] | null {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map<string, number>()
  for (const n of nodes) inDegree.set(n.id, 0)
  for (const e of edges) {
    if (!nodeById.has(e.source.nodeId) || !nodeById.has(e.target.nodeId)) continue
    inDegree.set(e.target.nodeId, (inDegree.get(e.target.nodeId) ?? 0) + 1)
  }
  const queue: string[] = []
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id)
  const out: WorkflowNode[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    const n = nodeById.get(id)
    if (n) out.push(n)
    for (const e of edges) {
      if (e.source.nodeId !== id) continue
      if (!nodeById.has(e.target.nodeId)) continue
      const next = (inDegree.get(e.target.nodeId) ?? 0) - 1
      inDegree.set(e.target.nodeId, next)
      if (next === 0) queue.push(e.target.nodeId)
    }
  }
  if (out.length !== nodes.length) return null
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

function pickStringArray(node: WorkflowNode, key: string): string[] {
  const v = (node as Record<string, unknown>)[key]
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

interface Binding {
  name: string
  bind: { nodeId: string; portName: string }
}

function readBindings(node: WorkflowNode, key: string): Binding[] {
  const arr = (node as Record<string, unknown>)[key]
  if (!Array.isArray(arr)) return []
  const out: Binding[] = []
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.name !== 'string') continue
    const bind = rec.bind
    if (typeof bind !== 'object' || bind === null) continue
    const br = bind as Record<string, unknown>
    if (typeof br.nodeId !== 'string' || typeof br.portName !== 'string') continue
    out.push({ name: rec.name, bind: { nodeId: br.nodeId, portName: br.portName } })
  }
  return out
}

async function readSnapshotForLatestRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
): Promise<string> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, nodeId),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(desc(nodeRuns.retryIndex))
    .limit(1)
  return rows[0]?.preSnapshot ?? ''
}

/**
 * Build the in-scope upstream map for nodes within a single scope. Edges
 * crossing into the scope from outside are ignored (their sources are
 * treated as already-done because the parent scope ran them first).
 */
function buildScopeUpstreams(
  scopeNodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Map<string, string[]> {
  const ids = new Set(scopeNodes.map((n) => n.id))
  const m = new Map<string, string[]>()
  for (const n of scopeNodes) m.set(n.id, [])
  for (const e of edges) {
    if (!ids.has(e.target.nodeId)) continue
    if (!ids.has(e.source.nodeId)) continue
    const list = m.get(e.target.nodeId) ?? []
    if (!list.includes(e.source.nodeId)) list.push(e.source.nodeId)
    m.set(e.target.nodeId, list)
  }
  // agent-multi's sourcePort.nodeId is an extra dep if both ends are in scope.
  for (const n of scopeNodes) {
    if (n.kind === 'agent-multi') {
      const sp = (n as Record<string, unknown>).sourcePort as { nodeId?: unknown } | undefined
      if (sp === undefined || typeof sp.nodeId !== 'string') continue
      if (!ids.has(sp.nodeId)) continue
      const list = m.get(n.id) ?? []
      if (!list.includes(sp.nodeId)) list.push(sp.nodeId)
      m.set(n.id, list)
    }
  }
  return m
}

/**
 * Recursive containment map: every node id → innermost wrapper id containing
 * it (if any). Outer wrapper relationships are not stored because the inner
 * scope already implies them. Nodes not contained by any wrapper are absent
 * from the map (= top-level).
 *
 * Robust against:
 *   - wrappers listing the same inner under both (treats it as belonging to
 *     the wrapper appearing later in iteration order — validator catches the
 *     truly invalid configurations)
 *   - missing inner ids (skipped)
 */
function buildContainerMap(def: WorkflowDefinition): Map<string, string> {
  const out = new Map<string, string>()
  const nodeById = new Map(def.nodes.map((n) => [n.id, n]))
  // Walk wrappers from innermost to outermost (innermost = wrapper whose
  // inner ids contain no other wrappers from def). Since wrappers can nest,
  // we sort by nesting depth: wrappers whose inner ids include other
  // wrappers are processed AFTER those other wrappers. This is implemented
  // by repeated passes — small N, cheap.
  const wrappers = def.nodes.filter((n) => n.kind === 'wrapper-git' || n.kind === 'wrapper-loop')
  const processed = new Set<string>()
  let safety = wrappers.length + 1
  while (processed.size < wrappers.length && safety-- > 0) {
    for (const w of wrappers) {
      if (processed.has(w.id)) continue
      const inner = pickStringArray(w, 'nodeIds')
      // Defer if any inner is itself an unprocessed wrapper.
      const blocked = inner.some(
        (id) =>
          nodeById.get(id) !== undefined &&
          (nodeById.get(id)!.kind === 'wrapper-git' || nodeById.get(id)!.kind === 'wrapper-loop') &&
          !processed.has(id),
      )
      if (blocked) continue
      for (const id of inner) {
        if (!nodeById.has(id)) continue
        // Innermost wins (don't overwrite once set).
        if (!out.has(id)) out.set(id, w.id)
      }
      processed.add(w.id)
    }
  }
  return out
}
