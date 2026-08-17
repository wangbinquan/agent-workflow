// RFC-307 T1 — projecting a stage contract into the graph a person can look at.
//
// The user's complaint that started this RFC: "I have no flow I can execute or
// look at, I don't even know what it actually looks like." RFC-304 shipped five
// capabilities whose sequences are fully specified in `capabilityRegistry.ts`
// — and rendered them in the UI as a single opaque box.
//
// The DAG was already there. `StageBase.requires` / `.produces` name the
// artifacts flowing between stages, which is exactly an edge list; nothing had
// ever read them that way. So this file adds no new source of truth — it is a
// PROJECTION, and that word is load-bearing:
//
//   · The contract stays the only place a sequence is defined. Change a stage
//     and the picture changes with it, because the picture is derived rather
//     than drawn. A hand-maintained diagram is a second copy, and this repo has
//     watched hand-maintained copies drift with nobody noticing
//     (`docs/dev-gotchas.md`).
//   · Nothing here is persisted and nothing enters `workflow_definitions` —
//     RFC-304's D3 ruled stage sequences out of the workflow table, and a
//     read-side projection does not reopen that.
//
// Pure and IO-free on purpose: the whole thing is a function of the contract, so
// it is exhaustively testable and the route that serves it needs no database.

import {
  type CodeCapabilityId,
  type StageContract,
  type StageContractRegistry,
  type StageDef,
} from './stageContract'

/** What kind of thing runs at this step — the four arms of `StageDef`. */
export type StageGraphNodeKind = StageDef['kind']

export interface StageGraphNode {
  /** The stage name. Hooks mount by this, and so does the runtime status join. */
  name: string
  kind: StageGraphNodeKind
  /** Position in the sequence, so a renderer can lay stages out in run order. */
  index: number
  requires: readonly string[]
  produces: readonly string[]
  /** A parallel segment (sharded review). Hooks fire once per segment, not per shard. */
  parallel: boolean
  /**
   * Keys a `pre` hook here may hand back, straight from the contract.
   *
   * Carried into the graph rather than looked up separately because it is the
   * answer to the question the UI has to ask at every hook insertion point:
   * "can a hook here return anything, and what?" An empty list is a real
   * answer — "this hook may read the worktree and abort, but may not inject" —
   * and is not the same as the question never having been asked.
   */
  injectable: readonly string[]
  /**
   * Artifacts this stage publishes that intentionally leave the sequence.
   *
   * The renderer draws these as endpoints. Without it a branch terminus and a
   * stage whose consumer got dropped look identical — a node with an outgoing
   * declaration and no outgoing edge.
   */
  terminal: readonly string[]
  /** Which binding slot supplies this stage's agent. Only for `kind: 'ai'`. */
  agentSlot?: string
  /** Which framework slot supplies this stage's script. Only for `kind: 'script'`. */
  scriptSlot?: string
  /** The sub-sequence this stage runs inline. Only for `kind: 'invoke'`. */
  invokes?: {
    capability: CodeCapabilityId
    from: string
    to: string
    /** Sub-sequence stage names in order, when the target contract resolves. */
    stages: readonly string[]
  }
}

export interface StageGraphEdge {
  id: string
  from: string
  to: string
  /** The artifact that makes this an edge — what actually flows along it. */
  artifact: string
}

export interface StageGraph {
  capability: CodeCapabilityId
  /** The contract version this picture was projected from (T9 staleness check). */
  version: number
  nodes: readonly StageGraphNode[]
  edges: readonly StageGraphEdge[]
}

/**
 * The producer of an artifact, as the runtime sees it: the NEAREST upstream
 * stage that produces it.
 *
 * Nearest rather than all, because a re-produced artifact is an overwrite. If
 * `collect` produces `diff` and a later `refresh` produces `diff` again, a
 * consumer after `refresh` reads the refreshed one — drawing an edge from
 * `collect` as well would show data flowing along a path the run never takes.
 */
function nearestProducer(stages: readonly StageDef[], upto: number, artifact: string): number {
  for (let i = upto - 1; i >= 0; i -= 1) {
    if (stages[i]?.produces.includes(artifact) === true) return i
  }
  return -1
}

/**
 * Project a contract into nodes and edges.
 *
 * `registry` is optional and used only to expand an `invoke` stage's target
 * sub-sequence for display. Without it the invoke node still renders — it just
 * names its target rather than listing its steps — because a picture that
 * refuses to draw when one lookup is unavailable is worse than a partial one.
 */
export function projectStageGraph(
  contract: StageContract,
  registry: StageContractRegistry = () => undefined,
): StageGraph {
  const stages = contract.stages
  const nodes: StageGraphNode[] = stages.map((stage, index) => {
    const base: StageGraphNode = {
      name: stage.name,
      kind: stage.kind,
      index,
      requires: stage.requires,
      produces: stage.produces,
      parallel: stage.parallel === true,
      injectable: stage.injectable ?? [],
      terminal: stage.terminal ?? [],
    }
    if (stage.kind === 'ai') return { ...base, agentSlot: stage.agentSlot }
    if (stage.kind === 'script') return { ...base, scriptSlot: stage.scriptSlot }
    if (stage.kind === 'invoke') {
      const target = registry(stage.invokes.capability)
      return {
        ...base,
        invokes: {
          capability: stage.invokes.capability,
          from: stage.invokes.from,
          to: stage.invokes.to,
          stages: target === undefined ? [] : subSequenceNames(target, stage.invokes),
        },
      }
    }
    return base
  })

  const edges: StageGraphEdge[] = []
  stages.forEach((stage, index) => {
    for (const artifact of stage.requires) {
      const producer = nearestProducer(stages, index, artifact)
      if (producer === -1) continue // Unsatisfied — reported by the soundness check, not drawn.
      const from = stages[producer]?.name
      if (from === undefined) continue
      edges.push({ id: `${from}->${stage.name}:${artifact}`, from, to: stage.name, artifact })
    }
  })

  return { capability: contract.capability, version: contract.version, nodes, edges }
}

function subSequenceNames(
  target: StageContract,
  range: { from: string; to: string },
): readonly string[] {
  const names = target.stages.map((s) => s.name)
  const from = names.indexOf(range.from)
  const to = names.indexOf(range.to)
  if (from === -1 || to === -1 || from > to) return []
  return names.slice(from, to + 1)
}

export type StageGraphSoundnessIssue = {
  code: 'produces-unconsumed' | 'requires-unproduced'
  stageName: string
  artifact: string
  message: string
}

/**
 * The other half of the contract's own self-check.
 *
 * `validateStageContract` already reports an artifact a stage requires that
 * nothing upstream produces. It does NOT report the mirror image: an artifact a
 * stage publishes that no downstream stage ever reads. That one is quieter and
 * at least as informative — a dead `produces` means either the consumer was
 * dropped in a refactor (a real defect, and one nothing else would catch) or
 * the declaration was copied from a neighbouring stage and was never true.
 *
 * Drawing the graph is what made this checkable: an unconsumed artifact is
 * exactly a node with an outgoing declaration and no outgoing edge.
 *
 * Three exemptions, each structural rather than convenient:
 *   · the LAST stage of a sequence — a round's final output has no downstream
 *     stage by construction;
 *   · anything an `invoke` stage `collect`s, since the sub-sequence's outputs
 *     are consumed by the PARENT contract, not within the target's own;
 *   · anything the stage DECLARES `terminal` — a branch end, a round end, or an
 *     artifact the dispatcher reads rather than a later stage. Declared, not
 *     inferred: exempting every unconsumed artifact would make this check fire
 *     never, whereas requiring the declaration still catches the case worth
 *     catching — a consumer dropped in a refactor leaves the artifact neither
 *     read nor declared.
 */
export function checkStageGraphSoundness(
  contract: StageContract,
  registry: StageContractRegistry = () => undefined,
): StageGraphSoundnessIssue[] {
  const issues: StageGraphSoundnessIssue[] = []
  const stages = contract.stages
  const lastIndex = stages.length - 1

  // Artifacts some other contract reaches in via `invoke` … collect.
  const collectedElsewhere = new Set<string>()
  for (const capability of registryCapabilities(registry)) {
    for (const stage of registry(capability)?.stages ?? []) {
      if (stage.kind !== 'invoke') continue
      if (stage.invokes.capability !== contract.capability) continue
      for (const source of Object.values(stage.collect)) collectedElsewhere.add(source)
    }
  }

  stages.forEach((stage, index) => {
    if (index === lastIndex) return
    for (const artifact of stage.produces) {
      if (collectedElsewhere.has(artifact)) continue
      if (stage.terminal?.includes(artifact) === true) continue
      // Consumed downstream, but only while it is still THIS stage's value —
      // a later stage re-producing it ends this one's reach.
      const overwritten = stages.findIndex(
        (s, i) => i > index && s.produces.includes(artifact) && !s.requires.includes(artifact),
      )
      const end = overwritten === -1 ? stages.length : overwritten
      const consumed = stages.some((s, i) => i > index && i < end && s.requires.includes(artifact))
      if (consumed) continue
      issues.push({
        code: 'produces-unconsumed',
        stageName: stage.name,
        artifact,
        message: `stage '${stage.name}' produces '${artifact}', which no downstream stage reads`,
      })
    }
  })

  for (const [index, stage] of stages.entries()) {
    for (const artifact of stage.requires) {
      if (nearestProducer(stages, index, artifact) !== -1) continue
      issues.push({
        code: 'requires-unproduced',
        stageName: stage.name,
        artifact,
        message: `stage '${stage.name}' requires '${artifact}', which no upstream stage produces`,
      })
    }
  }

  return issues
}

/** The capabilities a registry can resolve. Kept local so the check stays pure. */
function registryCapabilities(registry: StageContractRegistry): readonly CodeCapabilityId[] {
  const all: CodeCapabilityId[] = [
    'mr-review',
    'mr-comment-fix',
    'requirement',
    'ci-fix',
    'mr-monitor',
  ]
  return all.filter((capability) => registry(capability) !== undefined)
}
