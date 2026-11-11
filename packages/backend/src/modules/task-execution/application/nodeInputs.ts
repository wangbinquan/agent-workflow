import type { WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { describeWrapperKind, resolveWorkflowSourceRef } from '@agent-workflow/shared'
import type { Logger } from '@/util/log'
import type { NodeExecutionPersistence } from './ports/nodeExecutionPersistence'
import { collectDataflowInboundEdges } from '../domain/inboundEdges'
import { loadFrameChain } from './frameChain'
import {
  resolveSourceFrame,
  resolveSourceFrameInScope,
  type FrameCoordinate,
} from '../domain/environmentChain'
import { encodeConsumedEdges } from '../domain/consumedInputs'
import { nodeOutputSlot } from '../domain/runSelection/nodeOutputSlot'

export async function resolveUpstreamInputs(
  persistence: NodeExecutionPersistence,
  taskId: string,
  edges: WorkflowEdge[],
  nodeId: string,
  // RFC-354 — the consumer's FRAME (wrapper generation row + round). Every
  // source is read in the frame the environment chain resolves it to: a local
  // in this frame, a closure / parameter in an enclosing frame — never by a
  // numeric iteration window.
  frame: FrameCoordinate,
  log: Logger,
  definition?: WorkflowDefinition,
  parents?: ReadonlyMap<string, string>,
): Promise<{ inputs: Record<string, string>; consumed: Record<string, string> }> {
  const grouped = new Map<string, string[]>()
  // Fanout boundary edges are structural mirrors, and clarify/cross-clarify
  // response edges are prompt-injected system channels — neither is ordinary
  // row-to-row dataflow. Reading them here would either observe a still-running
  // wrapper/channel row (and emit a false "missing upstream" warning) or, when
  // an older channel output exists, inject it into a reserved agent input and
  // record false consumed provenance. `agent.__clarify__ → <gate>` IS kept
  // (RFC-354 D7): the asker is the gate's structural upstream for both gate
  // kinds — the port table's `dataflow` flag decides, not the target's kind.
  //
  // RFC-306: the projection now lives in task-execution/domain/inboundEdges so
  // the branch-activation judgment reads EXACTLY the same edge set — see that
  // module's header for why a second hand-rolled copy would be a bug factory.
  const incoming = collectDataflowInboundEdges(edges, nodeId)
  // RFC-074 provenance: which upstream node_run each source edge actually read.
  // Keyed by source nodeId — all edges from the same source resolve to the same
  // picked run, so this stays consistent across multi-port fan-in.
  const consumed: Record<string, string> = {}
  // The generation rows between this frame and the top, loaded once; the
  // pure frame walk below looks them up synchronously.
  const chain = await loadFrameChain({ read: (id) => persistence.read(id) }, frame)

  for (const edge of incoming) {
    const resolved =
      definition === undefined
        ? { ok: true as const, source: edge.source, exitedWrapperIds: [] }
        : resolveWorkflowSourceRef(definition, edge.source, nodeId, parents)
    if (!resolved.ok) {
      throw new Error(
        `wrapper-output-boundary-missing: source '${edge.source.nodeId}.${edge.source.portName}' is not exposed by ${describeWrapperKind(resolved.wrapperKind)} '${resolved.wrapperId}'`,
      )
    }
    const source = resolved.source
    // RFC-354 — lexical environment lookup. The source lives either in this
    // frame (a sibling in the same wrapper generation and round) or in an
    // enclosing frame (a value captured from outside the body, or a wrapper
    // parameter); the walk decides which, and a source that is not lexically
    // visible is a definition error surfaced loudly, never an empty string.
    // Without a definition (legacy fixtures) every source is read in the
    // consumer's own frame.
    const sourceFrame =
      definition === undefined || parents === undefined
        ? frame
        : resolveSourceFrame({
            sourceNodeId: source.nodeId,
            targetNodeId: nodeId,
            parents,
            frame,
            containerRows: chain.rows,
          })
    if (!('containerRunId' in sourceFrame) && !sourceFrame.ok) {
      throw new Error(
        `closure-binding-unresolved: source '${source.nodeId}.${source.portName}' is not lexically visible from '${nodeId}' (${sourceFrame.reason})`,
      )
    }
    const readFrame = 'containerRunId' in sourceFrame ? sourceFrame : sourceFrame.frame
    const run = await persistence.snapshotRead(async (snapshot) => {
      const rows = await snapshot.list({ taskId, nodeId: source.nodeId })
      const ids = new Set(rows.map((row) => row.id))
      const selected = (
        await snapshot.selection.slotHistory(
          taskId,
          nodeOutputSlot(
            source.nodeId,
            definition?.nodes.find((node) => node.id === source.nodeId)?.kind,
            readFrame,
          ),
          { statusIn: ['done', 'skipped'] },
        )
      )
        .filter((row) => ids.has(row.id))
        .at(-1)
      return rows.find((row) => row.id === selected?.id)
    })
    if (!run) {
      log.warn('upstream node_run not found', { taskId, sourceNodeId: source.nodeId })
      continue
    }
    consumed[source.nodeId] = run.id
    const outRows = await persistence.listOutputs(run.id)
    const port = outRows.find((o) => o.portName === source.portName)
    // RFC-306: a closed branch contributes NOTHING to a downstream prompt.
    //
    //   * source row `skipped` ⇒ it produced no ports at all;
    //   * port row `active === false` ⇒ its content is the author's REASON for
    //     closing the branch. That text must never reach another agent: it is
    //     one model's private justification, and injecting it as if it were data
    //     invents an input the author never wired.
    //
    // Reaching this line at all means the node was judged ACTIVE — i.e. some
    // OTHER inbound edge is live (joinMode 'any'), or the operator forced the
    // node to run. Empty string is exactly the right value for the dead legs.
    const inactive = run.status === 'skipped' || port?.active === false
    const content = inactive ? '' : (port?.content ?? '')
    const list = grouped.get(edge.target.portName) ?? []
    list.push(content)
    grouped.set(edge.target.portName, list)
  }

  const inputs: Record<string, string> = {}
  for (const [name, values] of grouped) {
    inputs[name] = values.length === 1 ? (values[0] ?? '') : values.join('\n\n---\n\n')
  }
  return { inputs, consumed }
}

/**
 * RFC-193 D16 — row-returning variant: derived-output projections (output
 * virtual nodes, wrapper outlet promotion) must copy `kind` + `archive_json`
 * alongside `content`, or the projected row 404s on the port-artifacts API
 * and goes dark after worktree GC (Codex design-gate P1).
 */
export async function readPortRowAtFrame(
  persistence: NodeExecutionPersistence,
  taskId: string,
  nodeId: string,
  portName: string,
  // RFC-354 — the FRAME the producing node is read in (the caller resolves
  // it through the environment chain when the source sits in an enclosing
  // scope); rows of any other frame are invisible here.
  frame: FrameCoordinate,
  nodeKind?: string,
): Promise<{
  runId: string | null
  content: string
  kind: string | null
  archiveJson: string | null
  /**
   * RFC-306: false when this port is NOT carrying a value this round — either
   * the producer marked it `active="false"`, or the producing run was itself
   * skipped. Every projection built on this read (output nodes, wrapper outlet
   * promotion, loop exit conditions) has to propagate it, or a closed branch
   * silently re-opens one layer up.
   */
  active: boolean
}> {
  const chosen = await persistence.snapshotRead(async (snapshot) => {
    const rows = await snapshot.list({ taskId, nodeId })
    const ids = new Set(rows.map((row) => row.id))
    const selected = (
      await snapshot.selection.slotHistory(taskId, nodeOutputSlot(nodeId, nodeKind, frame), {
        statusIn: ['done', 'skipped'],
      })
    )
      .filter((row) => ids.has(row.id))
      .at(-1)
    return rows.find((row) => row.id === selected?.id)
  })
  if (chosen === undefined) {
    // No settled run at all. `active: true` (not false) on purpose: "nothing has
    // run yet" is not a branch decision, and reporting it as inactive would let
    // a bookkeeping gap masquerade as a deliberate skip.
    return { runId: null, content: '', kind: null, archiveJson: null, active: true }
  }
  const out = (await persistence.listOutputs(chosen.id)).filter((row) => row.portName === portName)
  // A skipped producing run has no port rows at all, so the port-row check alone
  // would read it as "absent ⇒ active" (the compatibility default). The run
  // status has to be consulted too.
  const active = chosen.status !== 'skipped' && out[0]?.active !== false
  return {
    runId: chosen.id,
    content: active ? (out[0]?.content ?? '') : '',
    kind: out[0]?.kind ?? null,
    archiveJson: out[0]?.archiveJson ?? null,
    active,
  }
}

/**
 * RFC-354 — a wrapper's port read on behalf of its body. `frame` is the READER's frame — the body frame
 * `(generation, round)` a loop evaluates its exit condition / output bindings in. The producing node is read in the
 * frame the environment chain resolves it to: a body node locally, a node outside the wrapper as a captured free
 * variable (one generation row outward per enclosing wrapper). A source that is not lexically visible fails loudly
 * instead of reading ''.
 *
 * RFC-420: moved verbatim from the wrapper data binding (`composition/wrapperMechanics.ts` `readPort`).
 */
export async function readPortInScope(
  input: {
    readonly persistence: NodeExecutionPersistence
    readonly taskId: string
    readonly definition: WorkflowDefinition
    readonly parents: ReadonlyMap<string, string>
  },
  nodeId: string,
  portName: string,
  frame: FrameCoordinate,
): ReturnType<typeof readPortRowAtFrame> {
  const chain = await loadFrameChain({ read: (id: string) => input.persistence.read(id) }, frame)
  const scopeRow = frame.containerRunId === null ? undefined : chain.rows.get(frame.containerRunId)
  const resolved = resolveSourceFrameInScope({
    sourceNodeId: nodeId,
    scope: scopeRow?.nodeId ?? null,
    parents: input.parents,
    frame,
    containerRowById: (id) => chain.rows.get(id),
  })
  if (!resolved.ok) {
    throw new Error(
      `closure-binding-unresolved: port '${nodeId}.${portName}' is not visible from frame ` +
        `${frame.containerRunId ?? 'top'}#${frame.iteration} (${resolved.reason}${resolved.scopeId === null ? '' : ` at ${resolved.scopeId}`})`,
    )
  }
  return await readPortRowAtFrame(
    input.persistence,
    input.taskId,
    nodeId,
    portName,
    resolved.frame,
    input.definition.nodes.find((node) => node.id === nodeId)?.kind,
  )
}

/**
 * The encoded consumed-inputs record of the newest earlier top-level attempt of a fan-out node in one round (the
 * asking attempt excluded); null when there is none.
 *
 * RFC-420: moved verbatim from the wrapper data binding (`composition/wrapperMechanics.ts` `priorFanoutConsumed`).
 */
export async function priorFanoutConsumedJson(
  persistence: NodeExecutionPersistence,
  taskId: string,
  nodeId: string,
  iteration: number,
  excludeRunId: string,
): Promise<string | null> {
  return persistence.snapshotRead(async (snapshot) => {
    const rows = await snapshot.list({ taskId, nodeId, iteration })
    const previous = (
      await snapshot.selection.familyHistory(
        taskId,
        {
          nodeId,
          iteration,
          runIds: rows.filter((row) => row.id !== excludeRunId).map((row) => row.id),
        },
        { topLevelOnly: true, consumedOnly: true },
      )
    ).at(-1)
    if (previous === undefined) return null
    return encodeConsumedEdges(await snapshot.selection.consumed(previous.id))
  })
}
