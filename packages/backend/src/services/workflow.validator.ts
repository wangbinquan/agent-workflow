// Workflow static validator (P-2-01).
//
// Replaces the M1 stub with the five static checks the design promises:
//
//   1. edge-port-existence    — every edge endpoint references a real node
//                               and a port that actually exists on it.
//   2. topology               — DAG outside of `wrapper-loop`; cycles allowed
//                               only inside one and the same loop wrapper.
//   3. wrapper-required       — wrapper-git needs ≥1 inner node; wrapper-loop
//                               needs ≥1 inner + maxIterations + exitCondition.
//   4. reference-resolution   — agent names referenced by nodes resolve to
//                               existing agents; agent.skills resolve; output
//                               bindings point at concrete (node, port);
//                               input keys are unique.
//   5. prompt-template        — every `{{name}}` token in promptTemplate is a
//                               builtin or matches an inbound edge's
//                               target.portName on this node.
//
// The validator is permissive about node shape (kind discriminators are loose
// in the M1 schema), so per-kind fields are read defensively.

import type {
  Agent,
  ParsedKind,
  Skill,
  WorkflowDefinition,
  WorkflowValidationIssue,
  WorkflowValidationResult,
} from '@agent-workflow/shared'
import {
  BUILTIN_VARS,
  CLARIFY_SOURCE_PORT_NAME,
  countFanoutAggregators,
  declaredPorts,
  isClarifyChannelEdge,
  isMultiDocReviewInput,
  isReviewableBodyKind,
  isWrapperKind,
  tryParseKind,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { listAgents } from '@/services/agent'
import { listPlugins } from '@/services/plugin'
import { listSkills } from '@/services/skill'
import { getWorkflow } from '@/services/workflow'
import { NotFoundError } from '@/util/errors'

// RFC-103 T5 (04-WFM-06/07): the built-in prompt-var set is now the single
// source `BUILTIN_VARS` from shared/prompt.ts (was a local copy that lagged the
// substitution engine and falsely rejected RFC-066 `{{__repos__}}` etc.).

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

export async function validateWorkflowById(
  db: DbClient,
  id: string,
): Promise<WorkflowValidationResult> {
  const wf = await getWorkflow(db, id)
  if (wf === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
  }
  return validateWorkflowDef(wf.definition, {
    agents: await listAgents(db),
    skills: await listSkills(db),
    plugins: await listPlugins(db),
  })
}

export interface ValidatorContext {
  agents: Agent[]
  skills: Skill[]
  /**
   * RFC-031: list of registered plugins, used to validate that every name in
   * `agent.plugins` (and across the dependsOn closure) maps to a known +
   * enabled record. Optional for callers that predate RFC-031; the validator
   * silently skips the plugin check when this field is absent so existing
   * tests + workflow-yaml import sites don't break.
   */
  plugins?: Array<{ name: string; enabled: boolean }>
}

export function validateWorkflowDef(
  def: WorkflowDefinition,
  ctx: ValidatorContext,
): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = []

  const nodes = def.nodes ?? []
  const edges = def.edges ?? []
  const inputs = def.inputs ?? []
  // def.outputs are validated indirectly via the per-node "output" bindings
  // walk below; kept here as a placeholder if we later add top-level rules.

  const agentByName = new Map(ctx.agents.map((a) => [a.name, a]))
  const skillNames = new Set(ctx.skills.map((s) => s.name))
  // RFC-031: lookup tables for plugin reference checks. `pluginsKnown`
  // tells us name exists; `pluginsEnabled` tells us its enabled flag. When
  // ctx.plugins is undefined we leave both as undefined → checks no-op.
  const pluginsKnown =
    ctx.plugins === undefined ? undefined : new Set(ctx.plugins.map((p) => p.name))
  const pluginsEnabled =
    ctx.plugins === undefined
      ? undefined
      : new Set(ctx.plugins.filter((p) => p.enabled).map((p) => p.name))

  // 1. wrapper-required-fields ------------------------------------------------
  // (run early so later rules don't dereference invalid wrappers)
  for (const node of nodes) {
    if (node.kind === 'wrapper-git') {
      const inner = readStringArray(node, 'nodeIds')
      if (inner.length === 0) {
        issues.push({
          code: 'wrapper-empty',
          message: `wrapper-git '${node.id}' has no inner nodes`,
          pointer: node.id,
        })
      }
    }
    if (node.kind === 'wrapper-loop') {
      const inner = readStringArray(node, 'nodeIds')
      if (inner.length === 0) {
        issues.push({
          code: 'wrapper-empty',
          message: `wrapper-loop '${node.id}' has no inner nodes`,
          pointer: node.id,
        })
      }
      const maxIter = readNumber(node, 'maxIterations')
      if (maxIter === undefined || !Number.isInteger(maxIter) || maxIter < 1) {
        issues.push({
          code: 'wrapper-loop-max-iterations',
          message: `wrapper-loop '${node.id}' missing maxIterations (integer ≥ 1)`,
          pointer: node.id,
        })
      }
      const exitCond = (node as Record<string, unknown>).exitCondition
      if (exitCond === undefined || exitCond === null || typeof exitCond !== 'object') {
        issues.push({
          code: 'wrapper-loop-exit-condition',
          message: `wrapper-loop '${node.id}' missing exitCondition`,
          pointer: node.id,
        })
      }
    }
    // RFC-060 PR-C — schema-time cartesian guard. wrapper-fanout nested
    // inside another wrapper-fanout fires a warning (not an error) since
    // the shard total at runtime is the product of the outer + inner
    // cardinalities. Authors can override with `expectedShardCount` or
    // simply acknowledge the cost.
    if (node.kind === 'wrapper-fanout') {
      // Walk up via innerToWrapper-equivalent here — innerToWrapper isn't
      // built yet (rule 1 runs before nodeById is established), so do
      // the direct lookup against all candidate wrappers.
      for (const candidate of nodes) {
        if (candidate.kind !== 'wrapper-fanout') continue
        if (candidate.id === node.id) continue
        const inner = readStringArray(candidate, 'nodeIds')
        if (inner.includes(node.id)) {
          issues.push({
            code: 'wrapper-fanout-nested',
            message: `wrapper-fanout '${node.id}' is nested inside wrapper-fanout '${candidate.id}' — total shard count grows multiplicatively at runtime; consider declaring 'expectedShardCount' or restructuring`,
            pointer: node.id,
            severity: 'warning',
          })
          break
        }
      }
    }

    // RFC-060 PR-C — wrapper-fanout required fields.
    //
    // Inner subgraph reuses wrapper-git/loop's flat `nodeIds[]` reference
    // (design §1.1); empty inner is allowed only when the shardSource list
    // is also empty (runtime fanout-empty path). The validator can't see
    // shardSource's runtime cardinality, so it just warns when both are
    // empty rather than hard-failing — authors often start with the
    // wrapper card alone and fill nodeIds[] next.
    //
    // Shard source: EXACTLY ONE input port must have `isShardSource: true`
    // and the port's `kind` must parse as `list<T>`. Other inputs are
    // broadcast.
    if (node.kind === 'wrapper-fanout') {
      const inputs = readWrapperFanoutInputs(node)
      const shardSources = inputs.filter((p) => p.isShardSource === true)
      if (shardSources.length === 0) {
        issues.push({
          code: 'wrapper-fanout-shard-source-missing',
          message: `wrapper-fanout '${node.id}' has no input port marked isShardSource: true (exactly one required)`,
          pointer: node.id,
        })
      } else if (shardSources.length > 1) {
        issues.push({
          code: 'wrapper-fanout-shard-source-duplicate',
          message: `wrapper-fanout '${node.id}' has ${shardSources.length} input ports marked isShardSource: true (exactly one allowed)`,
          pointer: node.id,
        })
      } else {
        const shardPort = shardSources[0]!
        const parsed = tryParseKind(shardPort.kind)
        if (parsed === null || parsed.kind !== 'list') {
          issues.push({
            code: 'wrapper-fanout-shard-source-must-be-list',
            message: `wrapper-fanout '${node.id}' shardSource input '${shardPort.name}' must declare kind: list<T> (got '${shardPort.kind}')`,
            pointer: node.id,
          })
        }
      }
    }
  }

  // Build node lookup + port-sets per node (output port set, input port set).
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  // RFC-060 PR-C — innerToWrapper: every inner subgraph node points at its
  // immediate wrapper container (wrapper-git / wrapper-loop / wrapper-fanout).
  // Used by the aggregator-placement rule + wrapper-fanout boundary edge
  // validator. Computed eagerly (one pass) so subsequent rules read it
  // in O(1).
  const innerToWrapper = new Map<string, string>()
  for (const node of nodes) {
    if (isWrapperKind(node.kind)) {
      for (const innerId of readStringArray(node, 'nodeIds')) {
        // Multi-wrapper containment is an authoring error; the last write
        // wins here, RFC-016 wrapper-children-outside-bounds catches the
        // pathological "node listed in two wrappers" pattern. Validator
        // surfaces it via the existing wrapper rules.
        innerToWrapper.set(innerId, node.id)
      }
    }
  }

  // RFC-094 (audit S-6) — wrapper-loop nested (transitively) inside another
  // wrapper-loop is a BROKEN topology, not a cost concern: node_runs rows are
  // keyed (taskId, nodeId, iteration) with no parent-scope axis, so from the
  // outer loop's 2nd round the inner loop's frontier hits round-1 done rows
  // and the whole inner scope silently no-ops (current behavior locked by
  // scheduler-audit-s06-nested-loop-inner-noop.test.ts). Error — blocks task
  // launch (not canvas save) until nested-loop support lands (audit WP-6c).
  // The walk is transitive: loop→git→loop / loop→fanout→loop collide on the
  // same iteration axis. Contrast wrapper-fanout-nested above, which stays a
  // warning (multiplicative cost, not broken semantics).
  {
    const nodeKindById = new Map(nodes.map((n) => [n.id, n.kind]))
    for (const node of nodes) {
      if (node.kind !== 'wrapper-loop') continue
      let cur = innerToWrapper.get(node.id)
      for (let hop = 0; cur !== undefined && hop < nodes.length; hop++) {
        if (nodeKindById.get(cur) === 'wrapper-loop') {
          issues.push({
            code: 'wrapper-loop-nested',
            message: `wrapper-loop '${node.id}' is nested inside wrapper-loop '${cur}' — inner iterations silently no-op from the outer loop's 2nd round (audit S-6); restructure to a single loop until nested-loop support lands`,
            pointer: node.id,
          })
          break
        }
        cur = innerToWrapper.get(cur)
      }
    }
  }

  const outputPorts = new Map<string, Set<string>>()
  const inputPorts = new Map<string, Set<string>>()

  // RFC-146: the per-kind port switch (historically fork #5 of five parallel
  // implementations) is gone — ports come from the shared declaration table
  // (`declaredPorts`, packages/shared/src/nodePorts.ts). The validator takes
  // BOTH projections: data ports and framework system channels (clarify
  // family, __clarify__/__clarify_response__/__external_feedback__) are
  // accepted on edges exactly as the old hardcoded switch did.
  //
  // Behavior fix riding along: the old switch had NO wrapper-fanout case, so
  // a fanout outlet (aggregator-renamed port or the implicit __done__) wired
  // to a plain downstream edge / output binding / loop exitCondition
  // false-errored (`edge-source-port-missing` family) and blocked task
  // launch. The table derives fanout outlets via `deriveWrapperFanoutOutputs`
  // — the same oracle the canvas renders with — so those wirings validate.
  const defnForPorts: WorkflowDefinition = { ...def, nodes, edges }
  for (const node of nodes) {
    const declared = declaredPorts(node, defnForPorts, agentByName)
    outputPorts.set(
      node.id,
      new Set([...declared.dataOutputs, ...declared.systemOutputs].map((p) => p.name)),
    )
    inputPorts.set(
      node.id,
      new Set([...declared.dataInputs, ...declared.systemInputs].map((p) => p.name)),
    )
  }

  // Collect inbound edges per (target nodeId → portName set) for prompt check.
  const inbound = new Map<string, Set<string>>()
  for (const edge of edges) {
    const set = inbound.get(edge.target.nodeId) ?? new Set<string>()
    set.add(edge.target.portName)
    inbound.set(edge.target.nodeId, set)
  }

  // 2. edge-port-existence ----------------------------------------------------
  for (const edge of edges) {
    const src = nodeById.get(edge.source.nodeId)
    const tgt = nodeById.get(edge.target.nodeId)
    if (src === undefined) {
      issues.push({
        code: 'edge-source-node-missing',
        message: `edge '${edge.id}' source node '${edge.source.nodeId}' not found`,
        pointer: edge.id,
      })
      continue
    }
    if (tgt === undefined) {
      issues.push({
        code: 'edge-target-node-missing',
        message: `edge '${edge.id}' target node '${edge.target.nodeId}' not found`,
        pointer: edge.id,
      })
      continue
    }
    // RFC-094 (audit gap ⑥-9): a boundary='wrapper-input' edge's SOURCE is the
    // wrapper-fanout node itself (the wrapper forwards its declared input port
    // inward), which has no entry in the kind-switch above — the generic check
    // false-errored every legal fanout workflow at the createTask gate. Rule 4
    // (`boundary-input-port-not-declared`) validates that edge's source port
    // precisely, so the generic source check skips it.
    if (edge.boundary !== 'wrapper-input') {
      const outs = outputPorts.get(src.id) ?? new Set()
      if (!outs.has(edge.source.portName)) {
        issues.push({
          code: 'edge-source-port-missing',
          message: `edge '${edge.id}': node '${src.id}' has no output port '${edge.source.portName}'`,
          pointer: edge.id,
        })
      }
    }
    // Output and agent-input ports are accepted: output node declares its
    // inputs explicitly; agent nodes accept any port name (the runner exposes
    // them as prompt vars). Wrappers don't accept inbound edges.
    if (tgt.kind === 'output') {
      const ins = inputPorts.get(tgt.id) ?? new Set()
      if (!ins.has(edge.target.portName)) {
        issues.push({
          code: 'edge-target-port-missing',
          message: `edge '${edge.id}': output node '${tgt.id}' has no input port '${edge.target.portName}'`,
          pointer: edge.id,
        })
      }
    } else if (tgt.kind === 'wrapper-git' || tgt.kind === 'wrapper-loop') {
      issues.push({
        code: 'edge-target-port-missing',
        message: `edge '${edge.id}': wrapper '${tgt.id}' does not accept inbound edges in v1`,
        pointer: edge.id,
      })
    }

    // RFC-094 (audit S-5) — per-shard inner chain inside a wrapper-fanout.
    // The shard-scope computation auto-promotes chains, but the dispatch side
    // never feeds B with A's shard-child outputs (`resolveUpstreamInputs`
    // filters parentNodeRunId !== null rows), so B's port renders as an EMPTY
    // string and the task goes green on garbage (current behavior locked by
    // scheduler-audit-s05-fanout-inner-chain.test.ts). Error — blocks task
    // launch until per-shard chains are dispatched (audit WP-6b). Edges INTO
    // the aggregator stay legal (that is how aggregation input is wired), as
    // do clarify-channel edges (not part of data dispatch) and boundary edges
    // (validated by rule 4).
    if (edge.boundary === undefined && !isClarifyChannelEdge(edge)) {
      const srcWrapper = innerToWrapper.get(edge.source.nodeId)
      const tgtWrapper = innerToWrapper.get(edge.target.nodeId)
      if (
        srcWrapper !== undefined &&
        srcWrapper === tgtWrapper &&
        nodeById.get(srcWrapper)?.kind === 'wrapper-fanout' &&
        src.kind !== 'clarify' &&
        src.kind !== 'clarify-cross-agent' &&
        tgt.kind !== 'clarify' &&
        tgt.kind !== 'clarify-cross-agent'
      ) {
        const tgtAgent = agentByName.get(readString(tgt, 'agentName') ?? '')
        const targetIsAggregator = tgt.kind === 'agent-single' && tgtAgent?.role === 'aggregator'
        if (!targetIsAggregator) {
          issues.push({
            code: 'fanout-inner-chain-unsupported',
            message: `edge '${edge.id}' chains inner node '${src.id}' into non-aggregator inner node '${tgt.id}' inside wrapper-fanout '${srcWrapper}' — per-shard chains are not dispatched yet (the target reads an EMPTY port at runtime, audit S-5); route the result through the aggregator or split into sequential fanouts`,
            pointer: edge.id,
          })
        }
      }
    }
  }

  // 3. topology ---------------------------------------------------------------
  // Map every node to the loop wrapper (if any) that contains it; edges whose
  // endpoints share the same loop wrapper are allowed to participate in a
  // cycle. All others must form a DAG.
  //
  // RFC-023: clarify "ask-back" edges (agent.__clarify__ → clarify.questions
  // and clarify.answers → agent.__clarify_response__) form an intentional
  // cycle by design — answers feed back to the asking agent for the next
  // round. Cycles that pass through a clarify node are therefore allowed
  // outside of a wrapper-loop too (the clarify_no_iteration_cap warning is
  // what nudges users to wrap it). We strip those edges from the DAG check
  // by skipping any edge whose source or target node is `kind: 'clarify'`.
  const loopOf = buildLoopMembership(nodes)

  // Build a graph that excludes intra-loop edges, then check for cycles.
  const filtered: Array<{ from: string; to: string }> = []
  for (const edge of edges) {
    const srcNode = nodeById.get(edge.source.nodeId)
    const tgtNode = nodeById.get(edge.target.nodeId)
    if (srcNode === undefined) continue
    if (tgtNode === undefined) continue
    const lFrom = loopOf.get(edge.source.nodeId)
    const lTo = loopOf.get(edge.target.nodeId)
    if (lFrom !== undefined && lFrom === lTo) continue
    if (srcNode.kind === 'clarify' || tgtNode.kind === 'clarify') continue
    // RFC-056: cross-agent clarify forms intentional feedback cycles too —
    // newNode.to_designer → designer.__external_feedback__ loops back upstream,
    // and newNode.to_questioner → questioner.__clarify_response__ loops back
    // down. Strip any edge touching a clarify-cross-agent node from the DAG
    // check the same way RFC-023 clarify edges are stripped above.
    if (srcNode.kind === 'clarify-cross-agent' || tgtNode.kind === 'clarify-cross-agent') continue
    filtered.push({ from: edge.source.nodeId, to: edge.target.nodeId })
  }
  if (
    hasCycle(
      filtered,
      nodes.map((n) => n.id),
    )
  ) {
    issues.push({
      code: 'topology-cycle',
      message: 'workflow contains a cycle outside any loop wrapper',
    })
  }

  // The topology check above exempts ALL intra-loop edges — that exemption
  // exists for clarify / cross-clarify FEEDBACK cycles (see comments above). But
  // a plain agent→agent DATA cycle between two of a loop's inner nodes is NOT
  // cross-iteration feedback (v1 has no cross-iteration ports), so it deadlocks
  // at runtime: the scheduler's findScopeCycle fails the inner scope with a
  // 'scope-cycle' error. Surface that at edit time as a WARNING (non-blocking,
  // so the clarify/cross-clarify feedback patterns the exemption protects are
  // untouched — their channel edges are excluded below). See
  // scheduler-boundary-intra-loop-cycle-stall.test.ts.
  for (const node of nodes) {
    if (node.kind !== 'wrapper-loop') continue
    const innerIds = new Set(readStringArray(node, 'nodeIds'))
    if (innerIds.size < 2) continue
    const dataEdges: Array<{ from: string; to: string }> = []
    for (const edge of edges) {
      if (!innerIds.has(edge.source.nodeId) || !innerIds.has(edge.target.nodeId)) continue
      const s = nodeById.get(edge.source.nodeId)
      const t = nodeById.get(edge.target.nodeId)
      if (s === undefined || t === undefined) continue
      // Exclude clarify / cross-clarify channel edges (mirrors buildScopeUpstreams
      // — these carry feedback out-of-band, not as same-iteration dataflow).
      if (s.kind === 'clarify' || t.kind === 'clarify') continue
      if (s.kind === 'clarify-cross-agent' || t.kind === 'clarify-cross-agent') continue
      const sp = edge.source.portName
      const tp = edge.target.portName
      if (sp === '__clarify__' || sp === 'to_designer' || sp === 'to_questioner') continue
      if (tp === '__clarify_response__' || tp === '__external_feedback__') continue
      dataEdges.push({ from: edge.source.nodeId, to: edge.target.nodeId })
    }
    if (hasCycle(dataEdges, [...innerIds])) {
      issues.push({
        code: 'wrapper-loop-inner-data-cycle',
        message: `wrapper-loop '${node.id}' has a data cycle between its inner nodes; with no cross-iteration ports in v1 this deadlocks at runtime (the scheduler fails the loop scope with a cycle error). Break the cycle or route the feedback through a clarify channel / worktree file.`,
        pointer: node.id,
        severity: 'warning',
      })
    }
  }

  // 4. reference-resolution ---------------------------------------------------
  for (const node of nodes) {
    if (node.kind === 'agent-single') {
      const name = readString(node, 'agentName') ?? ''
      const agent = agentByName.get(name)
      if (agent === undefined) {
        issues.push({
          code: 'agent-not-found',
          message: `node '${node.id}': agent '${name}' not found`,
          pointer: node.id,
        })
        continue
      }
      // RFC-060 PR-C — aggregator placement guard. An aggregator agent
      // (agent.role === 'aggregator') MUST be an inner node of a
      // wrapper-fanout. PR-B rejected it everywhere as a placeholder;
      // PR-C tightens the rule by consulting the innerToWrapper map:
      //   - Inner of wrapper-fanout → allowed (runtime dispatches it once
      //     as the convergence point).
      //   - Inner of wrapper-git / wrapper-loop or top-level → rejected
      //     with `aggregator-agent-outside-fanout`.
      if (agent.role === 'aggregator') {
        const containerId = innerToWrapper.get(node.id)
        const container = containerId !== undefined ? nodeById.get(containerId) : undefined
        const inFanout = container?.kind === 'wrapper-fanout'
        if (!inFanout) {
          issues.push({
            code: 'aggregator-agent-outside-fanout',
            message: `node '${node.id}' uses aggregator agent '${agent.name}' — aggregator agents must sit inside a wrapper-fanout (RFC-060${
              containerId !== undefined
                ? `; currently nested in '${containerId}' which is kind '${container?.kind}'`
                : '; currently at top level'
            }).`,
            pointer: node.id,
          })
        }
      }
      for (const s of agent.skills) {
        if (!skillNames.has(s)) {
          issues.push({
            code: 'skill-not-found',
            message: `agent '${agent.name}' (used by node '${node.id}') references unknown skill '${s}'`,
            pointer: node.id,
          })
        }
      }
      // RFC-031: plugin references on the directly-used agent.
      if (pluginsKnown !== undefined && pluginsEnabled !== undefined) {
        for (const p of agent.plugins ?? []) {
          if (!pluginsKnown.has(p)) {
            issues.push({
              code: 'plugin-not-found',
              message: `agent '${agent.name}' (used by node '${node.id}') references unknown plugin '${p}'`,
              pointer: node.id,
            })
          } else if (!pluginsEnabled.has(p)) {
            issues.push({
              code: 'plugin-disabled',
              message: `agent '${agent.name}' (used by node '${node.id}') references disabled plugin '${p}'`,
              pointer: node.id,
            })
          }
        }
      }
      // RFC-022: also scan the agent.dependsOn closure for missing agents /
      // missing skills. BFS over agentByName since the validator already
      // owns the full agent set (no DB call). `seen` set guards against
      // cycle-driven infinite loops — even though agent.ts save-time guard
      // refuses cycles, the validator is also called from `workflow-yaml`
      // import and from CI fixtures that may have stale DBs.
      const seenInClosure = new Set<string>([agent.name])
      const closureQueue = [...agent.dependsOn]
      while (closureQueue.length > 0) {
        const depName = closureQueue.shift()
        if (depName === undefined) break
        if (seenInClosure.has(depName)) continue
        seenInClosure.add(depName)
        const dep = agentByName.get(depName)
        if (dep === undefined) {
          issues.push({
            code: 'agent-dependency-not-found',
            message: `agent '${agent.name}' (used by node '${node.id}') depends on unknown agent '${depName}'`,
            pointer: node.id,
          })
          continue
        }
        for (const s of dep.skills) {
          if (!skillNames.has(s)) {
            issues.push({
              code: 'skill-not-found',
              message: `dependent agent '${dep.name}' (closure of '${agent.name}', used by node '${node.id}') references unknown skill '${s}'`,
              pointer: node.id,
            })
          }
        }
        // RFC-031: same plugin-name reference check across the closure.
        if (pluginsKnown !== undefined && pluginsEnabled !== undefined) {
          for (const p of dep.plugins ?? []) {
            if (!pluginsKnown.has(p)) {
              issues.push({
                code: 'plugin-not-found',
                message: `dependent agent '${dep.name}' (closure of '${agent.name}', used by node '${node.id}') references unknown plugin '${p}'`,
                pointer: node.id,
              })
            } else if (!pluginsEnabled.has(p)) {
              issues.push({
                code: 'plugin-disabled',
                message: `dependent agent '${dep.name}' (closure of '${agent.name}', used by node '${node.id}') references disabled plugin '${p}'`,
                pointer: node.id,
              })
            }
          }
        }
        for (const next of dep.dependsOn) closureQueue.push(next)
      }
      // RFC-060 PR-E: agent-multi removed; its sourcePort + shardingStrategy
      // validation rules deleted. wrapper-fanout (validated above in rule 4d)
      // is now the sole fan-out mechanism.
    }
    if (node.kind === 'output') {
      const bindings = readBindings(node, 'ports')
      for (const b of bindings) {
        if (!nodeById.has(b.bind.nodeId)) {
          issues.push({
            code: 'binding-node-missing',
            message: `output node '${node.id}' port '${b.name}' binds to unknown node '${b.bind.nodeId}'`,
            pointer: node.id,
          })
        } else {
          const outs = outputPorts.get(b.bind.nodeId) ?? new Set()
          if (!outs.has(b.bind.portName)) {
            issues.push({
              code: 'binding-port-missing',
              message: `output node '${node.id}' port '${b.name}' binds to unknown port '${b.bind.portName}' on '${b.bind.nodeId}'`,
              pointer: node.id,
            })
          }
        }
      }
    }
    if (node.kind === 'wrapper-loop') {
      const bindings = readBindings(node, 'outputBindings')
      for (const b of bindings) {
        if (!nodeById.has(b.bind.nodeId)) {
          issues.push({
            code: 'binding-node-missing',
            message: `wrapper-loop '${node.id}' outputBinding '${b.name}' references unknown node '${b.bind.nodeId}'`,
            pointer: node.id,
          })
        } else {
          const outs = outputPorts.get(b.bind.nodeId) ?? new Set()
          if (!outs.has(b.bind.portName)) {
            issues.push({
              code: 'binding-port-missing',
              message: `wrapper-loop '${node.id}' outputBinding '${b.name}' references unknown port '${b.bind.portName}' on '${b.bind.nodeId}'`,
              pointer: node.id,
            })
          }
        }
      }
      // exitCondition must reference a real node + port. At runtime
      // readPortAtIteration returns '' for a dangling reference, which silently
      // satisfies a port-empty/-count condition and exits the loop early (no
      // error surfaced). Node existence is always checked. The port check only
      // runs when the node's output ports are genuinely known — for an
      // agent-single that means its agent is in the validation context (always
      // true for validateWorkflowById; absent for standalone def validation,
      // where we must not false-positive). See
      // scheduler-boundary-loop-exit-condition-validation.test.ts.
      const exitCond = (node as Record<string, unknown>).exitCondition
      if (exitCond !== null && typeof exitCond === 'object') {
        const ec = exitCond as Record<string, unknown>
        const exitNodeId = typeof ec.nodeId === 'string' ? ec.nodeId : undefined
        const exitPortName = typeof ec.portName === 'string' ? ec.portName : undefined
        if (exitNodeId !== undefined && !nodeById.has(exitNodeId)) {
          issues.push({
            code: 'wrapper-loop-exit-node-missing',
            message: `wrapper-loop '${node.id}' exitCondition references unknown node '${exitNodeId}'`,
            pointer: node.id,
          })
        } else if (exitNodeId !== undefined && exitPortName !== undefined) {
          const exitNode = nodeById.get(exitNodeId)
          const portsKnown =
            exitNode?.kind === 'agent-single'
              ? agentByName.has(readString(exitNode, 'agentName') ?? '')
              : true
          if (portsKnown && !(outputPorts.get(exitNodeId) ?? new Set<string>()).has(exitPortName)) {
            issues.push({
              code: 'wrapper-loop-exit-port-missing',
              message: `wrapper-loop '${node.id}' exitCondition references unknown port '${exitPortName}' on node '${exitNodeId}'`,
              pointer: node.id,
            })
          }
        }
      }
    }
  }

  // Input key uniqueness (part of rule 4).
  const seenKeys = new Set<string>()
  for (const inp of inputs) {
    if (seenKeys.has(inp.key)) {
      issues.push({
        code: 'input-key-duplicate',
        message: `duplicate input key '${inp.key}'`,
        pointer: inp.key,
      })
    }
    seenKeys.add(inp.key)
  }

  // 4d. upload-input-targetDir (RFC-020) -----------------------------------
  // `kind: 'upload'` inputs land user files into a worktree-relative
  // directory; we refuse traversal / absolute paths here so a bad workflow
  // never makes it to the multipart route's hot path.
  for (const inp of inputs) {
    if (inp.kind !== 'upload') continue
    const td = readString(inp, 'targetDir')
    if (td === undefined || td.length === 0) {
      issues.push({
        code: 'upload-input-target-dir-missing',
        message: `upload input '${inp.key}' missing targetDir`,
        pointer: inp.key,
      })
      continue
    }
    if (td.includes('..') || td.startsWith('/') || /^[A-Za-z]:[\\/]/.test(td)) {
      issues.push({
        code: 'upload-input-target-dir-invalid',
        message: `upload input '${inp.key}' targetDir '${td}' must be a repo-relative path without '..' or absolute prefixes`,
        pointer: inp.key,
      })
    }
  }

  // Input-node ↔ workflow.inputs[] bijection (RFC-004).
  // Error:   input node references an inputKey that no inputs[] entry declares.
  // Warning: inputs[] declares a key that no input node references (allows the
  //          user to keep a launcher field around temporarily without deleting
  //          its declaration).
  const declaredKeys = new Set(inputs.map((i) => i.key))
  const inputNodeKeys = new Set<string>()
  for (const node of nodes) {
    if (node.kind !== 'input') continue
    const key = readString(node, 'inputKey')
    if (key === undefined) continue
    inputNodeKeys.add(key)
    if (!declaredKeys.has(key)) {
      issues.push({
        code: 'input-key-not-declared',
        message: `input node '${node.id}' inputKey '${key}' not declared in workflow.inputs[]`,
        pointer: node.id,
      })
    }
  }
  for (const inp of inputs) {
    if (!inputNodeKeys.has(inp.key)) {
      issues.push({
        code: 'input-orphan-declared',
        message: `workflow.inputs[] declares key '${inp.key}' but no input node references it`,
        pointer: inp.key,
        severity: 'warning',
      })
    }
  }

  // 4c. wrapper-children-outside-bounds (RFC-016) --------------------------
  // Non-blocking warning: when a wrapper has a persisted `size` (set by
  // RFC-016 auto-fit or user resize), every node listed in wrapper.nodeIds
  // should also visually sit inside the rect at (wrapper.position,
  // wrapper.position + size). Hand-edited YAML or stale rows from a pre-
  // RFC-016 export can drift; the editor's ValidationPanel surfaces an
  // inline "Auto-fit" link that clears wrapper.size to fix the drift.
  for (const node of nodes) {
    if (node.kind !== 'wrapper-git' && node.kind !== 'wrapper-loop') continue
    const rec = node as Record<string, unknown>
    const size = rec.size as { width?: unknown; height?: unknown } | undefined
    if (size === undefined || typeof size.width !== 'number' || typeof size.height !== 'number') {
      continue
    }
    const pos = node.position ?? { x: 0, y: 0 }
    const innerIds = readStringArray(node, 'nodeIds')
    for (const innerId of innerIds) {
      const inner = nodeById.get(innerId)
      if (inner === undefined) continue
      const ip = inner.position ?? { x: 0, y: 0 }
      const outside =
        ip.x < pos.x || ip.y < pos.y || ip.x > pos.x + size.width || ip.y > pos.y + size.height
      if (outside) {
        issues.push({
          code: 'wrapper-children-outside-bounds',
          message: `wrapper '${node.id}' contains inner node '${innerId}' positioned outside its visual bounds — fit to children to fix`,
          pointer: node.id,
          severity: 'warning',
        })
        // One warning per wrapper is enough — auto-fit fixes them all.
        break
      }
    }
  }

  // 4b. review (RFC-005) -----------------------------------------------------
  // - inputSource must reference an existing (node, port).
  // - sourcePort must be declared kind ∈ {markdown, markdown_file} on the
  //   producing agent (only agents declare outputKinds; wrappers/input/output
  //   are explicitly not eligible upstreams in v1).
  // - rerunnableOnReject / rerunnableOnIterate must be subsets of the set of
  //   nodes reachable upstream from the review's input node (BFS along
  //   reversed edges).
  // - rerunnableOnReject empty: NOT a warning. The runtime
  //   (`review.ts:1254 — "direct upstream always rerunnable, regardless
  //   of config"`) always adds the review's direct upstream into the
  //   rerun set, so an empty array is fully functional (reject re-runs
  //   the direct upstream agent). The legacy warning here told users
  //   "reject will have nothing to re-run" which is a false claim about
  //   runtime behavior — see 2026-05-22 UI bug report. Users who want
  //   transitive cascade still list extra ancestor nodes explicitly.
  {
    const reverseAdj = new Map<string, string[]>()
    for (const e of edges) {
      const list = reverseAdj.get(e.target.nodeId) ?? []
      list.push(e.source.nodeId)
      reverseAdj.set(e.target.nodeId, list)
    }
    for (const node of nodes) {
      if (node.kind !== 'review') continue
      const inputSource = (node as Record<string, unknown>).inputSource
      if (
        inputSource === undefined ||
        inputSource === null ||
        typeof inputSource !== 'object' ||
        typeof (inputSource as Record<string, unknown>).nodeId !== 'string' ||
        typeof (inputSource as Record<string, unknown>).portName !== 'string'
      ) {
        issues.push({
          code: 'review-input-source-missing',
          message: `review node '${node.id}' missing or malformed inputSource`,
          pointer: node.id,
        })
        continue
      }
      const srcNodeId = (inputSource as Record<string, unknown>).nodeId as string
      const srcPort = (inputSource as Record<string, unknown>).portName as string
      const src = nodeById.get(srcNodeId)
      if (src === undefined) {
        issues.push({
          code: 'review-input-source-missing',
          message: `review node '${node.id}' inputSource references unknown node '${srcNodeId}'`,
          pointer: node.id,
        })
        continue
      }
      const outs = outputPorts.get(src.id) ?? new Set()
      if (!outs.has(srcPort)) {
        issues.push({
          code: 'review-input-source-missing',
          message: `review node '${node.id}' inputSource references unknown port '${srcPort}' on '${srcNodeId}'`,
          pointer: node.id,
        })
        continue
      }
      // markdown kind enforcement — only agent nodes carry outputKinds.
      //
      // RFC-060 PR-C: kind comparison switches from hardcoded literals to
      // parseKind-based shape checks. Accepts {markdown, markdown_file,
      // path<md>, path<markdown>} (markdown_file folds to path<md> at
      // parse time, so the alias survives). Rejects list<T> with the
      // separate `review-input-list-kind-not-supported` code — per-item
      // review must live INSIDE a wrapper-fanout.
      if (src.kind === 'agent-single') {
        const agentName = readString(src, 'agentName') ?? ''
        const agent = agentByName.get(agentName)
        const kind = agent?.outputKinds?.[srcPort]
        const parsed: ParsedKind | null = kind !== undefined ? tryParseKind(kind) : null
        // RFC-081: delegate the "markdownish" decision to the single predicate.
        const isMarkdownish = parsed !== null && isReviewableBodyKind(parsed)
        if (parsed?.kind === 'list') {
          // RFC-079: a list<markdownish> input (list<path<md>> / list<markdown>)
          // puts the review in MULTI-DOCUMENT mode — each item is archived as
          // its own reviewable doc_version. That is now allowed (it used to be
          // a hard `review-input-list-kind-not-supported` reject). A list whose
          // item is NOT a markdown document still can't be reviewed.
          if (!isMultiDocReviewInput(kind ?? '')) {
            issues.push({
              code: 'review-input-list-item-not-markdown',
              message: `review node '${node.id}' inputSource '${srcNodeId}.${srcPort}' has list kind '${kind}' whose item is not a markdown document; multi-document review requires list<path<md>> | list<markdown>.`,
              pointer: node.id,
            })
          }
        } else if (!isMarkdownish) {
          issues.push({
            code: 'review-input-source-not-markdown',
            message: `review node '${node.id}' inputSource '${srcNodeId}.${srcPort}' must be declared kind: markdown | path<md> | markdown_file on agent '${agentName}'`,
            pointer: node.id,
          })
        }
      } else {
        // Non-agent upstream — we don't model markdown kind on these in v1.
        issues.push({
          code: 'review-input-source-not-markdown',
          message: `review node '${node.id}' inputSource must come from an agent node (got kind '${src.kind}')`,
          pointer: node.id,
        })
      }
      // rerunnable subsets must be reachable upstream of inputSource.
      const reachable = collectReachableUpstream(srcNodeId, reverseAdj)
      // The direct upstream itself is always rerunnable; include it.
      reachable.add(srcNodeId)
      const rerunReject = readStringArray(node, 'rerunnableOnReject')
      const rerunIter = readStringArray(node, 'rerunnableOnIterate')
      for (const id of rerunReject) {
        if (!reachable.has(id)) {
          issues.push({
            code: 'review-rerunnable-out-of-scope',
            message: `review node '${node.id}' rerunnableOnReject id '${id}' is not in the reachable upstream of inputSource '${srcNodeId}'`,
            pointer: node.id,
          })
        }
      }
      for (const id of rerunIter) {
        if (!reachable.has(id)) {
          issues.push({
            code: 'review-rerunnable-out-of-scope',
            message: `review node '${node.id}' rerunnableOnIterate id '${id}' is not in the reachable upstream of inputSource '${srcNodeId}'`,
            pointer: node.id,
          })
        }
      }
      // (rerunnableOnReject empty is intentional + functional — runtime
      //  re-runs the direct upstream regardless. No warning emitted.)
    }
  }

  // 4b.5 RFC-069 — agent-level clarify attachment multiplicity (NodeKind-
  // agnostic pre-pass). Runs before §4c/§4d so attachment errors surface
  // first and per-NodeKind topology checks can assume baseline attachment
  // correctness. Closes RFC-064 §7.1 gap: workflows with only cross-clarify
  // nodes (no self-clarify) where an agent attached to ≥ 2 cross-clarify
  // previously slipped through silently.
  issues.push(...validateAgentClarifyMultiplicity({ nodes, edges }))

  // 4c. clarify (RFC-023) -----------------------------------------------------
  // - exactly one inbound edge on the `questions` port (the reverse-drag mints
  //   exactly one).
  // - inbound source must be an agent-single node (RFC-060 PR-E removed
  //   agent-multi; clarify-target-not-agent fires for anything else).
  // - no two clarify nodes connected to the same agent.
  // - clarify.answers must not loop back to the clarify node itself.
  // - bare clarify (not inside a wrapper-loop) emits a warning to nudge users
  //   toward bounding the ask-back count via the loop wrapper's max_iterations.
  // - clarify.answers with zero outbound edges emits a warning (the injection
  //   path is implicit via clarify_session rows, but a disconnected output is
  //   visually confusing).
  {
    const loopMembership = buildLoopMembership(nodes)
    for (const node of nodes) {
      if (node.kind !== 'clarify') continue

      // inbound on 'questions'
      const inboundOnQuestions = edges.filter(
        (e) => e.target.nodeId === node.id && e.target.portName === 'questions',
      )
      if (inboundOnQuestions.length === 0) {
        issues.push({
          code: 'clarify-questions-port-missing',
          message: `clarify node '${node.id}' has no inbound edge on 'questions' port; drag from the clarify input handle onto an agent to wire it`,
          pointer: node.id,
        })
      }

      // inbound source must be agent-{single,multi}; bookkeeping duplicates too
      const agentSourceIds = new Set<string>()
      for (const e of inboundOnQuestions) {
        const src = nodeById.get(e.source.nodeId)
        if (src === undefined) {
          issues.push({
            code: 'clarify-input-source-missing',
            message: `clarify node '${node.id}' inbound edge references unknown node '${e.source.nodeId}'`,
            pointer: node.id,
          })
          continue
        }
        if (src.kind !== 'agent-single') {
          issues.push({
            code: 'clarify-target-not-agent',
            message: `clarify node '${node.id}' must connect to an agent-single node (got kind '${src.kind}' on '${src.id}')`,
            pointer: node.id,
          })
          continue
        }
        agentSourceIds.add(src.id)
      }

      // RFC-069: G1 `clarify-multiple-source-agents` + `clarify-multiple-
      // clarify-on-same-agent` moved to validateAgentClarifyMultiplicity()
      // pre-pass — see §4b.5 above. agentSourceIds derived set retained
      // because it documents the per-kind attachment topology even though
      // no §4c-local rule consumes it post-RFC-069 (the dedup walk above
      // also runs the `clarify-input-source-missing` / `clarify-target-
      // not-agent` per-edge emits we keep).

      // self-loop on answers
      const answersOut = edges.filter(
        (e) => e.source.nodeId === node.id && e.source.portName === 'answers',
      )
      for (const e of answersOut) {
        if (e.target.nodeId === node.id) {
          issues.push({
            code: 'clarify-self-loop',
            message: `clarify node '${node.id}' has an answers edge pointing back to itself`,
            pointer: node.id,
          })
        }
      }

      // warning: not inside a wrapper-loop
      if (!loopMembership.has(node.id)) {
        issues.push({
          code: 'clarify-no-iteration-cap',
          message: `clarify node '${node.id}' is not inside a wrapper-loop — agent may ask back indefinitely; consider wrapping in a wrapper-loop with max_iterations`,
          pointer: node.id,
          severity: 'warning',
        })
      }

      // warning: answers port disconnected
      if (answersOut.length === 0) {
        issues.push({
          code: 'clarify-answers-port-disconnected',
          message: `clarify node '${node.id}' has no outbound edge on 'answers' port; answer injection still flows via the session, but the canvas hides the data flow`,
          pointer: node.id,
          severity: 'warning',
        })
      }
    }
  }

  // 4d. clarify-cross-agent (RFC-056) -----------------------------------------
  // - exactly one inbound edge on the `questions` port; source must be an
  //   agent-single (RFC-060 PR-E removed agent-multi entirely; the only
  //   way to attach cross-clarify to a fanned-out questioner is to wrap
  //   it in a wrapper-fanout — questioner placement inside fanout is a
  //   follow-up RFC).
  // - no outbound edges OTHER than from the two legal output ports
  //   (`to_designer`, `to_questioner`).
  // - `to_designer` must be wired (warning if missing — the node still parks
  //   awaiting_human at runtime, but submit then has nowhere to send Q&A).
  // - `to_designer` target should be a topological upstream ancestor of the
  //   questioner; runtime tolerates other targets but the canvas-author intent
  //   is "feed back to the agent that produced what was reviewed".
  // - `to_questioner` should be wired to questioner.__clarify_response__
  //   (auto-mints alongside the reverse-drag); warning if user deletes it.
  // - designer agent === questioner agent (same agent.md name) → warning
  //   "consider RFC-023 self-clarify instead".
  {
    const reverseAdj = new Map<string, string[]>()
    for (const e of edges) {
      const list = reverseAdj.get(e.target.nodeId) ?? []
      list.push(e.source.nodeId)
      reverseAdj.set(e.target.nodeId, list)
    }
    const crossLoopMembership = buildLoopMembership(nodes)
    for (const node of nodes) {
      if (node.kind !== 'clarify-cross-agent') continue

      // inbound on 'questions'
      const inboundOnQuestions = edges.filter(
        (e) => e.target.nodeId === node.id && e.target.portName === 'questions',
      )
      // RFC-063 G2: collect questioner candidates into a Set so duplicate edges
      // from the same agent don't inflate the count, and so we can flag
      // multi-questioner configurations. Downstream rules (ancestor, self-review,
      // auto-edge) consume a single questionerId — when there are ≥ 2 candidates
      // we pick the dictionary-minimum for stable downstream evaluation while
      // G2 surfaces the multiplicity error.
      const questionerCandidateIds = new Set<string>()
      const questionerAgentNamesById = new Map<string, string | undefined>()
      let questionerId: string | undefined
      let questionerAgentName: string | undefined
      if (inboundOnQuestions.length === 0) {
        issues.push({
          code: 'cross-clarify-input-source-missing',
          message: `clarify-cross-agent node '${node.id}' has no inbound edge on 'questions' port; reverse-drag from the input handle onto an agent-single questioner to wire it`,
          pointer: node.id,
        })
      } else {
        for (const e of inboundOnQuestions) {
          const src = nodeById.get(e.source.nodeId)
          if (src === undefined) {
            issues.push({
              code: 'cross-clarify-input-source-missing',
              message: `clarify-cross-agent node '${node.id}' inbound edge references unknown node '${e.source.nodeId}'`,
              pointer: node.id,
            })
            continue
          }
          if (src.kind !== 'agent-single') {
            issues.push({
              code: 'cross-clarify-target-not-agent-single',
              message: `clarify-cross-agent node '${node.id}' must connect to an agent-single questioner (got kind '${src.kind}' on '${src.id}')`,
              pointer: node.id,
            })
            continue
          }
          questionerCandidateIds.add(src.id)
          questionerAgentNamesById.set(src.id, readString(src, 'agentName'))
        }
        // RFC-069: G2 `cross-clarify-multiple-questioners` moved to
        // validateAgentClarifyMultiplicity() pre-pass — see §4b.5.
        // questionerCandidateIds is retained because downstream rules (ancestor,
        // self-review-warning, auto-edge-deleted) consume the dictionary-minimum
        // candidate as a stable questioner id.
        if (questionerCandidateIds.size >= 1) {
          questionerId = [...questionerCandidateIds].sort()[0]
          questionerAgentName = questionerAgentNamesById.get(questionerId!)
        }
      }

      // any outgoing edge MUST originate from one of the two legal output ports.
      const outboundEdges = edges.filter((e) => e.source.nodeId === node.id)
      for (const e of outboundEdges) {
        if (e.source.portName !== 'to_designer' && e.source.portName !== 'to_questioner') {
          issues.push({
            code: 'cross-clarify-has-downstream',
            message: `clarify-cross-agent node '${node.id}' has an outgoing edge from non-system port '${e.source.portName}'; only 'to_designer' and 'to_questioner' are allowed`,
            pointer: node.id,
          })
        }
      }

      // `to_designer` wired? (warning if not)
      const toDesignerOut = outboundEdges.filter((e) => e.source.portName === 'to_designer')
      if (toDesignerOut.length === 0) {
        issues.push({
          code: 'cross-clarify-manual-edge-missing',
          message: `clarify-cross-agent node '${node.id}' has no outbound edge on 'to_designer' port; submit will have no designer to trigger a rerun on`,
          pointer: node.id,
          severity: 'warning',
        })
      }

      // RFC-063 G3: a single cross-clarify must direct to_designer at most one
      // designer agent. RFC-056 §6 "multi-source banner" mode (multiple
      // cross-clarify nodes pointing to the same designer) is the inverse N:1
      // shape and stays legal — each cross-clarify's own to_designer target
      // set is still size 1.
      {
        const toDesignerTargetIds = new Set<string>()
        for (const e of toDesignerOut) {
          const tgt = nodeById.get(e.target.nodeId)
          if (tgt === undefined) continue // unknown-target already reported elsewhere
          if (tgt.kind !== 'agent-single') continue // non-agent target reported elsewhere
          toDesignerTargetIds.add(tgt.id)
        }
        if (toDesignerTargetIds.size > 1) {
          const sorted = [...toDesignerTargetIds].sort()
          issues.push({
            code: 'cross-clarify-multiple-designers',
            message: `clarify-cross-agent node '${node.id}' has 'to_designer' edges to multiple agents (${sorted.join(', ')}); only one designer agent allowed per cross-clarify node`,
            pointer: node.id,
          })
        }
      }

      // warning: not inside a wrapper-loop (mirrors RFC-023 same-node
      // 'clarify-no-iteration-cap'). Without an enclosing loop's
      // max_iterations the questioner can keep raising clarify rounds and
      // never converge — the editor's cross-clarify inspector surfaces the
      // same hint via the In-Loop status chip.
      if (!crossLoopMembership.has(node.id)) {
        issues.push({
          code: 'cross-clarify-no-iteration-cap',
          message: `clarify-cross-agent node '${node.id}' is not inside a wrapper-loop — questioner may keep asking indefinitely; consider wrapping in a wrapper-loop with max_iterations`,
          pointer: node.id,
          severity: 'warning',
        })
      }

      // ancestor relation for each to_designer target (warning if not an ancestor).
      if (questionerId !== undefined) {
        const ancestors = collectReachableUpstream(questionerId, reverseAdj)
        for (const e of toDesignerOut) {
          if (e.target.nodeId === questionerId) continue // self-target = self-review case, handled below
          if (!ancestors.has(e.target.nodeId)) {
            issues.push({
              code: 'cross-clarify-target-not-ancestor',
              message: `clarify-cross-agent node '${node.id}' to_designer target '${e.target.nodeId}' is not a topological upstream ancestor of questioner '${questionerId}'; the designer rerun feedback loop may not close`,
              pointer: node.id,
              severity: 'warning',
            })
          }
        }
      }

      // `to_questioner` auto-edge present? Looks for an edge from this node's
      // to_questioner port back to questioner.__clarify_response__. The
      // reverse-drag mints it; user-deletion is allowed (the runtime injects
      // answers via cross_clarify_sessions, not via this edge) but the canvas
      // hides the closed feedback loop and that warrants a warning.
      const toQuestionerOut = outboundEdges.filter((e) => e.source.portName === 'to_questioner')
      const properlyWiredAutoEdge = toQuestionerOut.some(
        (e) => e.target.nodeId === questionerId && e.target.portName === '__clarify_response__',
      )
      if (!properlyWiredAutoEdge && questionerId !== undefined) {
        issues.push({
          code: 'cross-clarify-auto-edge-deleted',
          message: `clarify-cross-agent node '${node.id}' has no 'to_questioner' → '${questionerId}.__clarify_response__' edge; answer injection still flows via the session, but the canvas hides the feedback loop`,
          pointer: node.id,
          severity: 'warning',
        })
      }

      // designer === questioner same agent.md → warning to consider RFC-023.
      if (questionerAgentName !== undefined && questionerAgentName.length > 0) {
        for (const e of toDesignerOut) {
          const tgt = nodeById.get(e.target.nodeId)
          if (tgt === undefined) continue
          if (tgt.kind !== 'agent-single') continue
          const designerAgentName = readString(tgt, 'agentName')
          if (designerAgentName === questionerAgentName) {
            issues.push({
              code: 'cross-clarify-self-review-warning',
              message: `clarify-cross-agent node '${node.id}' wires the same agent '${designerAgentName}' as both designer and questioner; consider RFC-023 self-clarify instead`,
              pointer: node.id,
              severity: 'warning',
            })
          }
        }
      }
    }
  }

  // 4d-bis. clarify / cross-clarify channel system-port edge integrity ------
  // The answer-injection target ports (`__clarify_response__`,
  // `__external_feedback__`) and the cross output source ports (`to_questioner`,
  // `to_designer`) are wired EXCLUSIVELY by the reverse/forward drag helpers as
  // fixed channel pairs. `buildScopeUpstreams` (scheduler.ts) strips EVERY edge
  // touching them, so a stray plain-DATA edge onto one of these ports is
  // silently removed from the dispatch graph — erasing the node's real upstream
  // dependency and turning it into a FALSE dispatch root (premature execution).
  // The canvas (`isValidConnection` → `isStrayClarifyChannelDrop`) blocks this
  // on drop; THIS is the authoritative gate that also catches YAML import /
  // hand-edits the canvas can't. Incident (2026-06): an upstream output dropped
  // onto an agent's `__clarify_response__` made the agent run before its real
  // predecessor. Each channel-port edge must be the canonical pair shape.
  //
  // Pre-index each clarify / cross-clarify node's "asker" agents — the nodes
  // whose `__clarify__` source feeds the node's `questions` port. A canonical
  // answer-injection edge must point the answer BACK at that same asker;
  // buildScopeUpstreams strips the edge either way, so an answer aimed at a
  // different agent makes that agent a false dispatch root even though the
  // source side is valid (Codex P2: target-not-paired-agent).
  const clarifyAskersByNode = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (edge.source.portName !== '__clarify__' || edge.target.portName !== 'questions') continue
    const tgtKind = nodeById.get(edge.target.nodeId)?.kind
    if (tgtKind !== 'clarify' && tgtKind !== 'clarify-cross-agent') continue
    const set = clarifyAskersByNode.get(edge.target.nodeId) ?? new Set<string>()
    set.add(edge.source.nodeId)
    clarifyAskersByNode.set(edge.target.nodeId, set)
  }
  for (const edge of edges) {
    const src = nodeById.get(edge.source.nodeId)
    if (src === undefined) continue // unknown source node reported elsewhere
    const tgt = nodeById.get(edge.target.nodeId)
    const sp = edge.source.portName
    const tp = edge.target.portName
    // (a) the answer-injection TARGET ports (`__clarify_response__`,
    // `__external_feedback__`) are AGENT system ports — the generic port-missing
    // check (above) only validates output/wrapper targets, so without this a
    // hand-edited `cross.to_designer → review.__external_feedback__` would pass
    // and the runtime would try to rerun a non-agent node as the designer.
    if (
      (tp === '__clarify_response__' || tp === '__external_feedback__') &&
      tgt !== undefined &&
      tgt.kind !== 'agent-single'
    ) {
      issues.push({
        code: 'system-port-illegal-target',
        message: `edge '${edge.id}': '${tp}' is an agent answer-injection port, but target '${edge.target.nodeId}' is kind '${tgt.kind}' (must be agent-single); the scheduler strips this edge and the runtime would resolve the wrong node`,
        pointer: edge.target.nodeId,
      })
    }
    // accept only the channel source AND (for `__clarify_response__`) inject the
    // answer back into the asking agent that owns the channel.
    if (tp === '__clarify_response__') {
      const okSource =
        (src.kind === 'clarify' && sp === 'answers') ||
        (src.kind === 'clarify-cross-agent' && sp === 'to_questioner')
      if (!okSource) {
        issues.push({
          code: 'system-port-illegal-source',
          message: `edge '${edge.id}': port '__clarify_response__' on '${edge.target.nodeId}' may only be fed by a clarify node's 'answers' port or a clarify-cross-agent node's 'to_questioner' port (got '${edge.source.nodeId}.${sp}', kind '${src.kind}'); a plain data edge here is silently dropped by the scheduler and makes '${edge.target.nodeId}' a false dispatch root`,
          pointer: edge.target.nodeId,
        })
      } else {
        // Source is canonical — verify the answer returns to the SAME agent that
        // asked. `askers` empty ⇒ the channel's `__clarify__ → questions` edge is
        // missing, already reported by the per-node clarify/cross rules; skip to
        // avoid a confusing double error.
        const askers = clarifyAskersByNode.get(edge.source.nodeId)
        if (askers !== undefined && askers.size > 0 && !askers.has(edge.target.nodeId)) {
          const owners = [...askers].map((a) => `'${a}'`).join(' / ')
          issues.push({
            code: 'system-port-mispaired-target',
            message: `edge '${edge.id}': '${edge.source.nodeId}' answers must be injected into the agent that asked it (${owners}), not '${edge.target.nodeId}'; buildScopeUpstreams strips this edge, so the wrong target launches as a false dispatch root`,
            pointer: edge.target.nodeId,
          })
        }
      }
    }
    if (tp === '__external_feedback__') {
      const ok = src.kind === 'clarify-cross-agent' && sp === 'to_designer'
      if (!ok) {
        issues.push({
          code: 'system-port-illegal-source',
          message: `edge '${edge.id}': port '__external_feedback__' on '${edge.target.nodeId}' may only be fed by a clarify-cross-agent node's 'to_designer' port (got '${edge.source.nodeId}.${sp}', kind '${src.kind}'); a plain data edge here is silently dropped by the scheduler and makes '${edge.target.nodeId}' a false dispatch root`,
          pointer: edge.target.nodeId,
        })
      }
    }
    // (c) the clarify / cross-clarify `questions` input may ONLY be fed by an
    // agent's `__clarify__` port. Runtime channel discovery keys on the
    // `__clarify__` source port, so a normal output (or a clarify node) wired
    // into `questions` leaves the channel unrecognized — and the existing
    // per-node check only requires the source to be agent-single, not that the
    // source PORT is `__clarify__`. Mirrors the canvas guard, which rejects any
    // drop onto a `questions` handle.
    if (
      tp === 'questions' &&
      (tgt?.kind === 'clarify' || tgt?.kind === 'clarify-cross-agent') &&
      sp !== '__clarify__'
    ) {
      issues.push({
        code: 'system-port-illegal-source',
        message: `edge '${edge.id}': the 'questions' port on ${tgt.kind} '${edge.target.nodeId}' may only be fed by an agent's '__clarify__' port (got '${edge.source.nodeId}.${sp}'); runtime channel discovery keys on '__clarify__', so any other source leaves the clarify channel broken`,
        pointer: edge.target.nodeId,
      })
    }
    // (d) the agent `__clarify__` ask port may ONLY feed a clarify / cross
    // `questions` port (the complement of rule (c) — mirrors the canvas guard
    // which rejects `__clarify__` as a stray source). Any other target leaves
    // a dangling ask channel the runtime never discovers.
    if (
      sp === '__clarify__' &&
      !((tgt?.kind === 'clarify' || tgt?.kind === 'clarify-cross-agent') && tp === 'questions')
    ) {
      issues.push({
        code: 'system-port-illegal-target',
        message: `edge '${edge.id}': the '__clarify__' ask port on '${edge.source.nodeId}' may only feed a clarify / clarify-cross-agent node's 'questions' port (got target '${edge.target.nodeId}.${tp}')`,
        pointer: edge.source.nodeId,
      })
    }
    // (e) a clarify node's `answers` output may ONLY feed an agent's
    // `__clarify_response__` injection port. A normal downstream consumer wired
    // to `answers` would dispatch the moment the clarify node settles (it has no
    // structural upstream), i.e. before the asking agent has actually run.
    if (src.kind === 'clarify' && sp === 'answers' && tp !== '__clarify_response__') {
      issues.push({
        code: 'system-port-illegal-target',
        message: `edge '${edge.id}': clarify node '${edge.source.nodeId}' 'answers' port may only feed an agent's '__clarify_response__' port (got target '${edge.target.nodeId}.${tp}')`,
        pointer: edge.source.nodeId,
      })
    }
    // (b) reserved cross output SOURCE ports may ONLY appear as the canonical
    // `clarify-cross-agent → injection-port` edge. Gated on the PORT NAME, not
    // src.kind: buildScopeUpstreams strips `to_questioner` / `to_designer` by
    // source-port name regardless of the source node's kind, so a non-cross
    // node that (mis)declares such an output is dropped from dispatch too — its
    // target would still become a false root. The full canonical shape (right
    // source kind AND right injection target) is required, closing both the
    // wrong-source-node and wrong-target gaps.
    if (
      sp === 'to_questioner' &&
      !(src.kind === 'clarify-cross-agent' && tp === '__clarify_response__')
    ) {
      issues.push({
        code: 'system-port-illegal-target',
        message: `edge '${edge.id}': reserved port 'to_questioner' on '${edge.source.nodeId}' (kind '${src.kind}') may only appear as a clarify-cross-agent node feeding a questioner's '__clarify_response__' port (got target '${edge.target.nodeId}.${tp}'); a plain data edge here is silently dropped by the scheduler and makes '${edge.target.nodeId}' a false dispatch root`,
        pointer: edge.source.nodeId,
      })
    }
    if (
      sp === 'to_designer' &&
      !(src.kind === 'clarify-cross-agent' && tp === '__external_feedback__')
    ) {
      issues.push({
        code: 'system-port-illegal-target',
        message: `edge '${edge.id}': reserved port 'to_designer' on '${edge.source.nodeId}' (kind '${src.kind}') may only appear as a clarify-cross-agent node feeding a designer's '__external_feedback__' port (got target '${edge.target.nodeId}.${tp}'); a plain data edge here is silently dropped by the scheduler and makes '${edge.target.nodeId}' a false dispatch root`,
        pointer: edge.source.nodeId,
      })
    }
  }

  // 4d. RFC-060 — wrapper-fanout cross-cutting validation -----------------
  // Runs AFTER reference-resolution so agentByName is populated; also
  // depends on innerToWrapper and outputPorts from rule 1 + the loop above.
  for (const node of nodes) {
    if (node.kind !== 'wrapper-fanout') continue

    // multiple-aggregators-in-fanout: v1 allows exactly 0 or 1.
    const aggCount = countFanoutAggregators(
      { $schema_version: 4, inputs: [], nodes, edges },
      node.id,
      agentByName,
    )
    if (aggCount > 1) {
      issues.push({
        code: 'multiple-aggregators-in-fanout',
        message: `wrapper-fanout '${node.id}' contains ${aggCount} aggregator agents; v1 supports at most 1 (RFC-060 design §4.3)`,
        pointer: node.id,
      })
    }
  }

  // 4e. RFC-060 — boundary edge validation --------------------------------
  for (const edge of edges) {
    if (edge.boundary === undefined) continue
    if (edge.boundary === 'wrapper-input') {
      const wrapper = nodeById.get(edge.source.nodeId)
      if (wrapper === undefined || wrapper.kind !== 'wrapper-fanout') {
        issues.push({
          code: 'boundary-input-source-not-wrapper',
          message: `edge '${edge.id}' boundary='wrapper-input' source.nodeId '${edge.source.nodeId}' is not a wrapper-fanout node`,
          pointer: edge.id,
        })
        continue
      }
      const declared = readWrapperFanoutInputs(wrapper).some((p) => p.name === edge.source.portName)
      if (!declared) {
        issues.push({
          code: 'boundary-input-port-not-declared',
          message: `edge '${edge.id}' boundary='wrapper-input' source.portName '${edge.source.portName}' is not declared in wrapper-fanout '${wrapper.id}' inputs[]`,
          pointer: edge.id,
        })
      }
      const wrapperInner = new Set(readStringArray(wrapper, 'nodeIds'))
      if (!wrapperInner.has(edge.target.nodeId)) {
        issues.push({
          code: 'boundary-input-target-not-inner',
          message: `edge '${edge.id}' boundary='wrapper-input' target.nodeId '${edge.target.nodeId}' is not in wrapper-fanout '${wrapper.id}' nodeIds[]`,
          pointer: edge.id,
        })
      }
    } else if (edge.boundary === 'wrapper-output') {
      const wrapper = nodeById.get(edge.target.nodeId)
      if (wrapper === undefined || wrapper.kind !== 'wrapper-fanout') {
        issues.push({
          code: 'boundary-output-target-not-wrapper',
          message: `edge '${edge.id}' boundary='wrapper-output' target.nodeId '${edge.target.nodeId}' is not a wrapper-fanout node`,
          pointer: edge.id,
        })
        continue
      }
      const wrapperInner = new Set(readStringArray(wrapper, 'nodeIds'))
      if (!wrapperInner.has(edge.source.nodeId)) {
        issues.push({
          code: 'boundary-output-source-not-inner',
          message: `edge '${edge.id}' boundary='wrapper-output' source.nodeId '${edge.source.nodeId}' is not in wrapper-fanout '${wrapper.id}' nodeIds[]`,
          pointer: edge.id,
        })
        continue
      }
      // The source must be the aggregator agent. We look up by agentName
      // (agent-single) and check role === 'aggregator'.
      const srcNode = nodeById.get(edge.source.nodeId)
      if (srcNode === undefined) continue
      const srcAgentName = readString(srcNode, 'agentName') ?? ''
      const srcAgent = agentByName.get(srcAgentName)
      if (srcNode.kind !== 'agent-single' || srcAgent?.role !== 'aggregator') {
        issues.push({
          code: 'boundary-output-source-must-be-aggregator',
          message: `edge '${edge.id}' boundary='wrapper-output' source '${edge.source.nodeId}' must be an aggregator agent-single node (RFC-060 §5.3.1)`,
          pointer: edge.id,
        })
      }
    }
  }

  // 5. prompt-template --------------------------------------------------------
  for (const node of nodes) {
    if (node.kind !== 'agent-single') continue
    const template = readString(node, 'promptTemplate')
    if (template === undefined || template === '') continue
    const refs = extractTemplateVars(template)
    const inboundPorts = inbound.get(node.id) ?? new Set<string>()
    // RFC-060 PR-E: agent-multi removed; sourcePort handling deleted. Inside
    // wrapper-fanout, the inner agent-single picks up its shard value via a
    // boundary-input edge — that edge already lives in the graph, so the
    // standard inbound-port set captures the reference correctly.
    for (const ref of refs) {
      if (BUILTIN_VARS.has(ref)) continue
      if (!inboundPorts.has(ref)) {
        issues.push({
          code: 'prompt-template-unresolved',
          message: `node '${node.id}' prompt references {{${ref}}} but has no matching inbound port`,
          pointer: node.id,
        })
      }
    }
  }

  const hasError = issues.some((i) => (i.severity ?? 'error') === 'error')
  return { ok: !hasError, issues }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// RFC-060 PR-E: shardingInvalidMessage removed alongside RFC-055
// agent-multi shardingStrategy validator rule.

interface WrapperFanoutInputView {
  name: string
  kind: string
  isShardSource?: boolean
}

function readWrapperFanoutInputs(node: unknown): WrapperFanoutInputView[] {
  if (typeof node !== 'object' || node === null) return []
  const raw = (node as Record<string, unknown>).inputs
  if (!Array.isArray(raw)) return []
  const out: WrapperFanoutInputView[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.name !== 'string' || rec.name.length === 0) continue
    if (typeof rec.kind !== 'string' || rec.kind.length === 0) continue
    const view: WrapperFanoutInputView = { name: rec.name, kind: rec.kind }
    if (rec.isShardSource === true) view.isShardSource = true
    out.push(view)
  }
  return out
}

function readString(node: unknown, key: string): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

function readNumber(node: unknown, key: string): number | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : undefined
}

function readStringArray(node: unknown, key: string): string[] {
  if (typeof node !== 'object' || node === null) return []
  const v = (node as Record<string, unknown>)[key]
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

interface Binding {
  name: string
  bind: { nodeId: string; portName: string }
}

function readBindings(node: unknown, key: string): Binding[] {
  if (typeof node !== 'object' || node === null) return []
  const arr = (node as Record<string, unknown>)[key]
  if (!Array.isArray(arr)) return []
  const out: Binding[] = []
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const name = rec.name
    const bind = rec.bind
    if (typeof name !== 'string') continue
    if (typeof bind !== 'object' || bind === null) continue
    const bindRec = bind as Record<string, unknown>
    if (typeof bindRec.nodeId !== 'string' || typeof bindRec.portName !== 'string') continue
    out.push({ name, bind: { nodeId: bindRec.nodeId, portName: bindRec.portName } })
  }
  return out
}

function buildLoopMembership(nodes: WorkflowDefinition['nodes']): Map<string, string> {
  const map = new Map<string, string>()
  for (const node of nodes) {
    if (node.kind !== 'wrapper-loop') continue
    for (const inner of readStringArray(node, 'nodeIds')) {
      map.set(inner, node.id)
    }
  }
  return map
}

/**
 * Returns every ancestor node id reachable from `start` by walking reversed
 * edges (i.e. "who feeds into start, transitively"). Excludes `start` itself.
 * Used by RFC-005 review-rerunnable-out-of-scope check.
 */
function collectReachableUpstream(start: string, reverseAdj: Map<string, string[]>): Set<string> {
  const out = new Set<string>()
  const stack: string[] = [...(reverseAdj.get(start) ?? [])]
  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined) break
    if (out.has(next)) continue
    out.add(next)
    for (const parent of reverseAdj.get(next) ?? []) {
      if (!out.has(parent)) stack.push(parent)
    }
  }
  return out
}

/** Standard DFS-based cycle detection. */
function hasCycle(edges: Array<{ from: string; to: string }>, nodeIds: string[]): boolean {
  const adj = new Map<string, string[]>()
  for (const id of nodeIds) adj.set(id, [])
  for (const e of edges) {
    const list = adj.get(e.from)
    if (list !== undefined) list.push(e.to)
  }
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const id of nodeIds) color.set(id, WHITE)
  function visit(id: string): boolean {
    color.set(id, GRAY)
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? WHITE
      if (c === GRAY) return true
      if (c === WHITE && visit(next)) return true
    }
    color.set(id, BLACK)
    return false
  }
  for (const id of nodeIds) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      if (visit(id)) return true
    }
  }
  return false
}

const TEMPLATE_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

export function extractTemplateVars(template: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = TEMPLATE_RE.exec(template)) !== null) {
    out.add(m[1] ?? '')
  }
  return [...out].filter((s) => s !== '')
}

/**
 * RFC-069: NodeKind-agnostic pre-pass for agent-level clarify attachment
 * multiplicity rules. Invoked from validateWorkflowDef §4b.5 — runs before
 * §4c (self-clarify) and §4d (clarify-cross-agent) so attachment errors are
 * reported first and per-NodeKind topology checks downstream can assume
 * baseline attachment topology correctness.
 *
 * Three rule types emitted (all FAIL severity):
 *
 *   1. `clarify-multiple-clarify-on-same-agent` — agent has ≥ 2 outbound
 *      `__clarify__` edges to distinct clarify NodeKind targets (self-clarify
 *      and clarify-cross-agent combined). Closes RFC-064 §7.1 gap: workflows
 *      with ONLY cross-clarify nodes (no self-clarify) where an agent attached
 *      to ≥ 2 cross-clarify nodes previously slipped through silently.
 *
 *   2. `clarify-multiple-source-agents` — self-clarify node `questions` port
 *      has ≥ 2 distinct agent-single source NodeIds (RFC-063 G1).
 *
 *   3. `cross-clarify-multiple-questioners` — clarify-cross-agent node
 *      `questions` port has ≥ 2 distinct agent-single source NodeIds
 *      (RFC-063 G2).
 *
 * Not handled here:
 *
 *   - G3 `cross-clarify-multiple-designers` — `to_designer` outbound edge
 *     rule on clarify-cross-agent (designer-side multiplicity), not agent
 *     attachment. Stays in §4d alongside the other to_designer checks.
 *   - per-NodeKind topology rules (self-loop / not-in-loop / ancestor /
 *     input-source-missing / target-not-agent) — stay in their case blocks.
 */
export function validateAgentClarifyMultiplicity(args: {
  nodes: WorkflowDefinition['nodes']
  edges: WorkflowDefinition['edges']
}): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = []
  const nodesById = new Map(args.nodes.map((n) => [n.id, n]))

  // Rule 1: agent has ≥ 2 outbound `__clarify__` edges to distinct targets.
  // Walk all edges, group by source NodeId, dedup target NodeIds so duplicate
  // edges to the same target don't inflate the count (matches original §4c
  // semantics where each clarify iteration filtered "OTHER" clarify edges).
  // Note: source NodeKind is intentionally not constrained here — rule 1 fires
  // even when source is non-agent (e.g. wrapper-git outputting on `__clarify__`,
  // an upstream config error). The per-NodeKind `clarify-input-must-be-agent`
  // / `cross-clarify-target-not-agent-single` checks report the source-kind
  // error separately; both errors coexist correctly.
  const clarifyTargetIdsByAgent = new Map<string, Set<string>>()
  for (const e of args.edges) {
    if (e.source.portName !== CLARIFY_SOURCE_PORT_NAME) continue
    const set = clarifyTargetIdsByAgent.get(e.source.nodeId) ?? new Set<string>()
    set.add(e.target.nodeId)
    clarifyTargetIdsByAgent.set(e.source.nodeId, set)
  }
  for (const [agentId, targetSet] of clarifyTargetIdsByAgent) {
    if (targetSet.size < 2) continue
    const sortedTargets = [...targetSet].sort()
    // Pointer = dictionary-min target so editor can jump to a concrete node.
    // Message echoes the original §4c template byte-for-byte (only the
    // emitter has changed); the dict-min target replaces the original
    // "current iterated node" since the pre-pass is NodeKind-agnostic.
    issues.push({
      code: 'clarify-multiple-clarify-on-same-agent',
      message: `agent '${agentId}' already has a clarify channel; remove the other clarify node before adding '${sortedTargets[0]}'`,
      pointer: sortedTargets[0],
    })
  }

  // Rule 2 + 3: clarify NodeKind node has ≥ 2 distinct agent-single sources
  // on its `questions` port. G1 (self-clarify) + G2 (clarify-cross-agent)
  // folded — they share predicate structure; the code/message branch by
  // NodeKind to preserve byte-level message templates from RFC-063.
  for (const node of args.nodes) {
    if (node.kind !== 'clarify' && node.kind !== 'clarify-cross-agent') continue
    const sourceAgents = new Set<string>()
    for (const e of args.edges) {
      if (e.target.nodeId !== node.id) continue
      if (e.target.portName !== 'questions') continue
      const srcNode = nodesById.get(e.source.nodeId)
      if (srcNode === undefined) continue
      // Only agent-single sources count — non-agent sources are reported by
      // the per-NodeKind `clarify-target-not-agent` / `cross-clarify-target-
      // not-agent-single` rules and would otherwise inflate the source set
      // with kind-error nodes.
      if (srcNode.kind !== 'agent-single') continue
      sourceAgents.add(srcNode.id)
    }
    if (sourceAgents.size <= 1) continue
    const sorted = [...sourceAgents].sort()
    if (node.kind === 'clarify') {
      issues.push({
        code: 'clarify-multiple-source-agents',
        message: `clarify node '${node.id}' has inbound 'questions' edges from multiple agents (${sorted.join(', ')}); only one agent may be attached to a clarify node`,
        pointer: node.id,
      })
    } else {
      issues.push({
        code: 'cross-clarify-multiple-questioners',
        message: `clarify-cross-agent node '${node.id}' has inbound 'questions' edges from multiple agents (${sorted.join(', ')}); only one questioner agent allowed per cross-clarify node`,
        pointer: node.id,
      })
    }
  }

  return issues
}
