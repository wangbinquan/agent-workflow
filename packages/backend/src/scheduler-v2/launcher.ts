// RFC-061 PR-B T10/T11 — task launcher that wires actor + production runner.
//
// services/task.ts now calls runTaskActorViaProduction (instead of the
// legacy services/scheduler:runTask). The launcher:
//   1. Mints initial events: task-started + logical-run-created per
//      entry node (input nodes + leaf nodes with no upstream edges).
//   2. Registers an actor in taskActorRegistry.
//   3. Constructs a ProductionRunnerAdapter bound to the actor's queue.
//   4. Runs the actor loop until terminal task state.
//   5. Deregisters the actor + emits task-completed/-failed/-canceled.

import { and, asc, eq } from 'drizzle-orm'

import { createLogger } from '@/util/log'
import type { Logger } from '@/util/log'
import type { DbClient } from '../db/client'
import { attempts, events as eventsTable, logicalRuns, nodeOutputs, tasks } from '../db/schema'
import { writeEvents, type NewEvent } from '../services/writeEvents'
import {
  filterDataEdges,
  type Scope,
  type WorkflowDefinition,
  type WorkflowEdgeLike,
  type WorkflowNode,
} from '@agent-workflow/shared'

import { taskActorRegistry } from './actorRegistry'
import { ProductionRunnerAdapter } from './runnerAdapterProduction'
import type { RunnerAdapter } from './runnerAdapter'
import { runTaskActor } from './taskActor'
import type { UpstreamInput } from '../handlers'
import { getAgent } from '../services/agent'
import { injectMemoryForRun } from '../services/memoryInject'

export interface RunTaskActorViaProductionOptions {
  db: DbClient
  taskId: string
  workflow: WorkflowDefinition
  inputsMap: Record<string, string>
  worktreePath: string
  repoPath: string
  appHome: string
  /** Soft per-attempt timeout (forwarded to runOpencodeAttempt). */
  defaultPerNodeTimeoutMs?: number
  log?: Logger
  /** Test hook: override the runner adapter (e.g. MockRunnerAdapter). */
  runnerAdapterOverride?: RunnerAdapter
  /** Override the opencode CLI head (tests inject stubOpencode). */
  opencodeCmd?: readonly string[]
}

/**
 * Main entry point. Idempotent: re-launching the same taskId rejoins
 * the existing actor (taskActorRegistry.register is idempotent), so
 * tests that call this in a loop don't spin up parallel loops.
 */
export async function runTaskActorViaProduction(
  opts: RunTaskActorViaProductionOptions,
): Promise<void> {
  const log = opts.log ?? createLogger('actor-launcher')

  // 0. Transition tasks.status pending → running so the UI + tests
  //    see the task actually moving. The actor's checkAndEmitTaskTerminal
  //    later flips it to done/failed/canceled.
  opts.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, opts.taskId)).run()

  // 1. Mint initial events (only if not already present).
  await seedInitialEventsIfMissing(opts.db, opts.taskId, opts.workflow, log)

  // 2. Register actor + production adapter.
  const actor = taskActorRegistry.register(opts.taskId)
  const runner =
    opts.runnerAdapterOverride ??
    new ProductionRunnerAdapter({
      db: opts.db,
      taskId: opts.taskId,
      worktreePath: opts.worktreePath,
      appHome: opts.appHome,
      wakeProducer: actor.queue,
      ...(opts.opencodeCmd !== undefined ? { opencodeCmd: opts.opencodeCmd } : {}),
    })

  // 3. Kick the loop with an initial wake.
  actor.queue.enqueue({ kind: 'event-applied', eventId: 'launcher-kick' })

  // 4. Run loop to terminal.
  try {
    await runTaskActor(actor, {
      db: opts.db,
      taskId: opts.taskId,
      workflow: opts.workflow,
      inputsMap: opts.inputsMap,
      repoPath: opts.repoPath,
      runner,
      readUpstreamPort: makeProjectionReader(opts.db, opts.taskId),
      resolveUpstreamInputs: makeUpstreamInputsResolver(opts.db, opts.taskId, opts.workflow),
      loadMemoryBlockForAgent: makeMemoryBlockLoader(opts.db, opts.taskId),
    })
  } finally {
    // 5. Always deregister on exit.
    taskActorRegistry.deregister(opts.taskId, 'task-loop-exit')
  }
}

/**
 * Mint task-started + per-entry-node logical-run-created if the events
 * table has no rows for this task yet. Idempotent for resume scenarios.
 */
async function seedInitialEventsIfMissing(
  db: DbClient,
  taskId: string,
  workflow: WorkflowDefinition,
  log: Logger,
): Promise<void> {
  const existing = db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(eq(eventsTable.taskId, taskId))
    .limit(1)
    .all()
  if (existing.length > 0) {
    log.debug('seed-skipped (events already present)', { taskId })
    return
  }

  const entryNodes = findEntryNodes(workflow)
  const evs: NewEvent[] = [{ taskId, kind: 'task-started', actor: 'system', payload: {} }]
  for (const n of entryNodes) {
    evs.push({
      taskId,
      kind: 'logical-run-created',
      nodeId: n.id,
      loopIter: 0,
      shardKey: '',
      iter: 0,
      actor: 'system',
      payload: {},
    })
  }
  await writeEvents(db, evs)
}

function findEntryNodes(workflow: WorkflowDefinition): WorkflowNode[] {
  const nodes = (workflow as { nodes?: ReadonlyArray<WorkflowNode> }).nodes ?? []
  const rawEdges = (workflow as { edges?: ReadonlyArray<WorkflowEdgeLike> }).edges ?? []
  // RFC-062 §2 — feedback edges (target.portName ∈ SYSTEM_PORT_NAMES) are
  // back-edges, not real inbound dependencies. A node whose only inbound
  // edges are feedback ones is still an entry node and must be seeded
  // with logical-run-created here; otherwise it would deadlock waiting
  // for its own response port to fire.
  const edges = filterDataEdges(rawEdges)
  const hasInbound = new Set<string>()
  for (const e of edges) {
    const t = e.target?.nodeId
    if (typeof t === 'string') hasInbound.add(t)
  }
  return nodes.filter((n) => !hasInbound.has(n.id))
}

/**
 * Build a projection reader that returns `node_outputs.content` for the
 * latest matching scope. Returns null when no row exists.
 */
function makeProjectionReader(
  db: DbClient,
  taskId: string,
): (upstreamNodeId: string, portName: string, scope: Scope) => Promise<string | null> {
  return async (upstreamNodeId, portName, scope) => {
    const rows = db
      .select({ content: nodeOutputs.content })
      .from(nodeOutputs)
      .where(
        and(
          eq(nodeOutputs.taskId, taskId),
          eq(nodeOutputs.nodeId, upstreamNodeId),
          eq(nodeOutputs.loopIter, scope.loopIter),
          eq(nodeOutputs.shardKey, scope.shardKey),
          eq(nodeOutputs.portName, portName),
        ),
      )
      .orderBy(asc(nodeOutputs.iter))
      .all()
    if (rows.length === 0) return null
    return rows[rows.length - 1]!.content
  }
}

/**
 * RFC-041 PR3 (RFC-061 rewire) — build the memory-block loader the actor
 * passes through to agent-single dispatch. The loader takes an agent
 * name, resolves the agent + its dependsOn closure, calls
 * injectMemoryForRun, and returns the rendered block (or null).
 *
 * Failures inside this closure NEVER escape — agent dispatch must not
 * crash because the memories table is unreachable.
 */
function makeMemoryBlockLoader(
  db: DbClient,
  taskId: string,
): (agentName: string) => Promise<string | null> {
  return async (agentName) => {
    try {
      const primary = await getAgent(db, agentName)
      if (primary === null) return null
      // RFC-041: dependsOn closure means an agent inherits memories
      // scoped to any of its dependent agents. Resolve depths first so
      // we get a full closure list.
      const dependents: Awaited<ReturnType<typeof getAgent>>[] = []
      const seen = new Set<string>([primary.id])
      const queue: string[] = primary.dependsOn ?? []
      while (queue.length > 0) {
        const next = queue.shift()!
        if (seen.has(next)) continue
        seen.add(next)
        const dep = await getAgent(db, next)
        if (dep === null) continue
        dependents.push(dep)
        for (const d of dep.dependsOn ?? []) queue.push(d)
      }
      const result = await injectMemoryForRun({
        db,
        taskId,
        primaryAgent: primary,
        dependents: dependents.filter((d) => d !== null) as ReadonlyArray<
          NonNullable<(typeof dependents)[number]>
        >,
      })
      return result.block
    } catch {
      return null
    }
  }
}

/**
 * Build an upstream-inputs resolver: collects all upstream port values
 * for a given node by walking workflow edges + reading node_outputs.
 */
function makeUpstreamInputsResolver(
  db: DbClient,
  taskId: string,
  workflow: WorkflowDefinition,
): (nodeId: string, scope: Scope) => Promise<UpstreamInput[]> {
  return async (nodeId, scope) => {
    const rawEdges = (workflow as { edges?: ReadonlyArray<WorkflowEdgeLike> }).edges ?? []
    // RFC-062 §2 — feedback ports (__clarify_response__ /
    // __external_feedback__) DO appear in workflow.edges so the canvas
    // can render handles, but their content is injected into the agent
    // prompt via dedicated Clarify Q&A / External Feedback blocks
    // (SignalKindHandler.renderPromptSection), NOT via node_outputs.
    // Including them here would (a) waste a DB round-trip for a port
    // that never has a node_outputs row, and (b) risk duplicating the
    // feedback content as a generic `## __clarify_response__` section
    // alongside the dedicated block.
    const edges = filterDataEdges(rawEdges)
    const inbound = edges.filter((e) => e.target?.nodeId === nodeId)
    const out: UpstreamInput[] = []
    for (const e of inbound) {
      const src = e.source
      if (!src || typeof src.nodeId !== 'string' || typeof src.portName !== 'string') continue
      const rows = db
        .select({ content: nodeOutputs.content })
        .from(nodeOutputs)
        .where(
          and(
            eq(nodeOutputs.taskId, taskId),
            eq(nodeOutputs.nodeId, src.nodeId),
            eq(nodeOutputs.loopIter, scope.loopIter),
            eq(nodeOutputs.shardKey, scope.shardKey),
            eq(nodeOutputs.portName, src.portName),
          ),
        )
        .orderBy(asc(nodeOutputs.iter))
        .all()
      const row = rows[rows.length - 1]
      if (row !== undefined) {
        const targetPort = e.target?.portName ?? src.portName
        out.push({ portName: targetPort, content: row.content })
      }
    }
    return out
  }
}

/* ============================================================
 *  Diagnostics
 * ============================================================ */

/**
 * Return a quick summary of where a task stands — used by REST routes
 * to render the legacy "node-runs" view from the new projection.
 */
export function describeTask(
  db: DbClient,
  taskId: string,
): {
  task: typeof tasks.$inferSelect | null
  logicalRuns: Array<typeof logicalRuns.$inferSelect>
  attempts: Array<typeof attempts.$inferSelect>
} {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).all()[0] ?? null
  const lrs = db.select().from(logicalRuns).where(eq(logicalRuns.taskId, taskId)).all()
  const atts =
    lrs.length === 0
      ? []
      : db.select().from(attempts).where(eq(attempts.logicalRunId, lrs[0]!.id)).all()
  return { task, logicalRuns: lrs, attempts: atts }
}
