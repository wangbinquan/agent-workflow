// RFC-304 — the stage contract: what a capability's round actually runs.
//
// Every capability has ONE stage sequence, defined in platform code and
// versioned. That is the deterministic-scheduling constitution in structural
// form: the sequence is not a prompt an agent improvises against, and it is not
// a workflow a user edits — it is written down, reviewed, and version-stamped,
// and only the stages marked `kind: 'ai'` involve a model at all.
//
// Two things here are load-bearing and easy to lose:
//
// 1. `StageDef` is a DISCRIMINATED UNION, so a stage can only carry the fields
//    its own kind defines. The first draft mentioned `invoke` in a comment while
//    the actual union stayed three-armed — which meant `self-review` (the
//    "audit your own change" step both requirement-delivery and ci-fix depend
//    on) neither typechecked nor had anywhere to execute. A union arm is the
//    difference between a documented feature and a real one.
//
// 2. `requires` / `produces` are DEVELOPMENT-time assertions, not runtime
//    validation. The sequence is fixed, so nothing can mis-wire it at runtime;
//    what they catch is a human adding or reordering a stage whose inputs no
//    upstream stage produces. They replace "remember the stage order".

/** The five capabilities the platform ships (proposal §2). */
export const CODE_CAPABILITIES = [
  'mr-review',
  'mr-comment-fix',
  'requirement',
  'ci-fix',
  'mr-monitor',
] as const
export type CodeCapability = (typeof CODE_CAPABILITIES)[number]

/**
 * A JSON Schema object. Kept structural rather than importing a validator's
 * type: the contract only needs to carry it to the determinism guard, and
 * pinning a library type here would leak that choice into every capability
 * definition.
 */
export type AiEnvelopeSchema = Readonly<Record<string, unknown>>

export interface StageBase {
  /** Public contract — hooks mount by this name, so renaming one breaks hooks. */
  name: string
  /**
   * A parallel segment: hooks fire once before and once after the WHOLE
   * segment, not per shard. Per-shard hook firing would multiply a
   * prepare-worktree side effect by the shard count.
   */
  parallel?: boolean
  /** Artifacts this stage reads. Checked against upstream `produces`. */
  requires: readonly string[]
  /** Artifacts this stage publishes for downstream stages. */
  produces: readonly string[]
}

export type StageDef = StageBase &
  (
    | {
        /**
         * Plain platform code. MUST NOT dispatch an agent — that is the
         * constitution's "program where a program suffices", and it is enforced
         * by a source-level negative scan (AC-10), not by convention.
         */
        kind: 'program'
      }
    | { kind: 'script'; scriptSlot: string }
    | {
        kind: 'ai'
        /**
         * REQUIRED. Constitution R3: an AI stage's output is sealed by an
         * envelope schema, and anything that does not conform is retried or
         * re-run rather than passed downstream. A schema-less AI stage would be
         * a hole straight through the determinism guarantee, so the type makes
         * it impossible to declare one.
         */
        aiSchema: AiEnvelopeSchema
        agentSlot: string
      }
    | {
        kind: 'invoke'
        /**
         * Run another capability's stages `[from, to]` inline. The sub-sequence
         * does NOT publish to the MR — its findings feed the parent's next
         * stage. Hooks inside it mount as `<parentStage>/<subStage>`.
         */
        invokes: { capability: CodeCapability; from: string; to: string }
      }
  )

export interface StageContract {
  capability: CodeCapability
  /** Bumped whenever the stage set or a stage's semantics change (T8). */
  version: number
  stages: readonly StageDef[]
}

export type StageContractIssue = {
  code:
    | 'stage-name-duplicate'
    | 'stage-requires-unsatisfied'
    | 'invoke-target-unknown'
    | 'invoke-range-unknown'
    | 'invoke-range-inverted'
    | 'invoke-cycle'
  stageName: string
  message: string
}

/** Look up a capability's contract; used to resolve `invoke` targets. */
export type StageContractRegistry = (capability: CodeCapability) => StageContract | undefined

/**
 * Self-check a contract. Runs in tests and at registry build time — never on
 * the hot path, because a fixed sequence cannot become invalid at runtime.
 *
 * Returns every issue rather than throwing on the first: when someone reorders
 * a sequence, they usually break several `requires` at once, and reporting them
 * one per run turns a five-minute fix into five edit/run cycles.
 */
export function validateStageContract(
  contract: StageContract,
  registry: StageContractRegistry = () => undefined,
): StageContractIssue[] {
  const issues: StageContractIssue[] = []
  const seen = new Set<string>()
  const produced = new Set<string>()

  for (const stage of contract.stages) {
    if (seen.has(stage.name)) {
      issues.push({
        code: 'stage-name-duplicate',
        stageName: stage.name,
        // Hooks mount by name, so two stages sharing one would silently run a
        // hook twice — or against the wrong stage.
        message: `duplicate stage name '${stage.name}' (hooks mount by name)`,
      })
    }
    seen.add(stage.name)

    for (const need of stage.requires) {
      if (!produced.has(need)) {
        issues.push({
          code: 'stage-requires-unsatisfied',
          stageName: stage.name,
          message: `stage '${stage.name}' requires '${need}', which no upstream stage produces`,
        })
      }
    }

    if (stage.kind === 'invoke') {
      issues.push(...checkInvoke(contract, stage, registry))
    }

    for (const out of stage.produces) produced.add(out)
  }

  return issues
}

function checkInvoke(
  parent: StageContract,
  stage: StageDef & { kind: 'invoke' },
  registry: StageContractRegistry,
): StageContractIssue[] {
  const issues: StageContractIssue[] = []
  const target = registry(stage.invokes.capability)
  if (target === undefined) {
    issues.push({
      code: 'invoke-target-unknown',
      stageName: stage.name,
      message: `stage '${stage.name}' invokes unknown capability '${stage.invokes.capability}'`,
    })
    return issues
  }

  const names = target.stages.map((s) => s.name)
  const fromIdx = names.indexOf(stage.invokes.from)
  const toIdx = names.indexOf(stage.invokes.to)
  for (const [label, idx, value] of [
    ['from', fromIdx, stage.invokes.from],
    ['to', toIdx, stage.invokes.to],
  ] as const) {
    if (idx === -1) {
      issues.push({
        code: 'invoke-range-unknown',
        stageName: stage.name,
        message: `stage '${stage.name}' invokes ${label} stage '${value}', absent from '${target.capability}'`,
      })
    }
  }
  if (fromIdx !== -1 && toIdx !== -1 && fromIdx > toIdx) {
    issues.push({
      code: 'invoke-range-inverted',
      stageName: stage.name,
      message: `stage '${stage.name}' invokes an inverted range [${stage.invokes.from}, ${stage.invokes.to}]`,
    })
  }

  // Recursion: an invoke chain that reaches its own capability again would
  // never terminate. Walk the reachable set rather than testing only the direct
  // target — `a → b → a` is the shape a two-capability pair falls into.
  if (reachesCapability(target, parent.capability, registry, new Set([target.capability]))) {
    issues.push({
      code: 'invoke-cycle',
      stageName: stage.name,
      message: `stage '${stage.name}' invokes '${target.capability}', which reaches back to '${parent.capability}'`,
    })
  }
  return issues
}

function reachesCapability(
  from: StageContract,
  goal: CodeCapability,
  registry: StageContractRegistry,
  visited: Set<CodeCapability>,
): boolean {
  if (from.capability === goal) return true
  for (const stage of from.stages) {
    if (stage.kind !== 'invoke') continue
    const next = stage.invokes.capability
    if (next === goal) return true
    if (visited.has(next)) continue
    visited.add(next)
    const contract = registry(next)
    if (contract !== undefined && reachesCapability(contract, goal, registry, visited)) return true
  }
  return false
}
