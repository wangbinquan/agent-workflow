import type { ZodTypeAny } from 'zod'

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
/**
 * The NAME of a capability — a closed string union, not a runtime credential.
 *
 * Named `…Id` rather than `…Capability` on purpose: this repo reserves the
 * `Capability` suffix (alongside `Actor`, `Authority`, `Claim`, `Token`) for
 * runtime authority objects, which the architecture preflight requires to be
 * minted by an owner factory, frozen, and tracked in a private registry. This
 * is none of those things — it identifies which stage sequence to run. Renaming
 * it back would claim a guarantee it does not provide.
 */
export type CodeCapabilityId = (typeof CODE_CAPABILITIES)[number]

/**
 * The ONLY way an arbitrary string becomes a `CodeCapabilityId`.
 *
 * A `value as CodeCapabilityId` cast would let any string — a typo in a binding,
 * a field from a webhook payload — pose as a capability the platform ships,
 * and the type system would stop being evidence of anything. Returning
 * `undefined` forces the caller to say what happens when it is not one, which
 * is a configuration fault worth reporting rather than a stage failure.
 */
export function parseCodeCapabilityId(value: string): CodeCapabilityId | undefined {
  return (CODE_CAPABILITIES as readonly string[]).includes(value)
    ? (value as CodeCapabilityId)
    : undefined
}

/**
 * The schema an AI stage's envelope must satisfy.
 *
 * A zod schema, not a hand-written JSON Schema object (design §4.1 deviation):
 * this repo has no JSON Schema validator, and its established practice is
 * zod-as-source with `zodToJsonSchema` for export (see `mcp/resourceSchemas.ts`).
 * Writing JSON Schema by hand here would mean a second schema system and a new
 * dependency for one RFC. The model still receives JSON Schema text — it is
 * derived, not authored.
 */
export type AiEnvelopeSchema = ZodTypeAny

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
  /**
   * The subset of `produces` that intentionally LEAVES the sequence — nothing
   * downstream reads it, and that is correct.
   *
   * Added by RFC-307, when drawing the sequence made the question askable for
   * the first time. Projecting the contract into a graph turns "produces
   * something nobody reads" from an invisible property into a node with no
   * outgoing edge, and the three the platform ships turned out to be three
   * DIFFERENT legitimate shapes:
   *
   *   · a branch terminus — `mr-comment-fix` splits on `form` into a suggestion
   *     tail and a patch tail; `published` ends the first one while the array
   *     continues into the second;
   *   · a round terminus — `requirement`'s `clarify` settles the round
   *     `awaiting` and the human's answer resumes at `comprehend` in the NEXT
   *     round, so `clarification` has no downstream stage by construction;
   *   · consumed off-channel — `ci-fix`'s `select` hands `agentPlan` to the
   *     dispatcher (which agent the `fix` stage runs), not to a later stage.
   *
   * Declaring them is what keeps the check meaningful. Exempting every
   * unconsumed artifact would make it fire never; requiring a declaration means
   * a consumer dropped in a refactor still gets caught, because the artifact
   * would be neither read nor declared. The renderer also uses this to draw an
   * endpoint instead of a dangling node.
   */
  terminal?: readonly string[]
  /**
   * Keys a `pre` hook on this stage may inject (design §4.3 F6 — e.g.
   * `promptSuffix`, `extraContext`). Absent means a hook here may still write
   * the worktree and abort, but may not hand data back.
   *
   * An allowlist rather than free-form merge: without it a hook could redefine
   * any artifact the sequence depends on, and "program stages are
   * deterministic" would hold only until someone wrote a creative hook.
   */
  injectable?: readonly string[]
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
        invokes: {
          capability: CodeCapabilityId
          from: string
          to: string
          /**
           * The parent artifact holding the worktree the sub-sequence reads,
           * and the one holding the LEFT side of its diff.
           *
           * Explicit because the design says the invoke contract must carry
           * them (§invoke): the sub-sequence is handed a diff, and a diff has
           * two sides. The right side is not named here because it is not a
           * parent artifact — it is a SNAPSHOT of the parent worktree frozen at
           * the moment of the invoke.
           *
           * Why the snapshot matters, in the design's own terms: `ci-fix` makes
           * its change in the parent worktree and then self-reviews. If each
           * review shard built its tree from the baseline — which is what
           * `mr-review`'s own rule says — every reviewer would read the code as
           * it was BEFORE the fix, and the self-review would be reviewing
           * nothing. Freezing the parent tree gives a right-hand side that is
           * both the real change and immutable, so shards stay isolated from
           * each other and the run is reproducible.
           */
          worktreeFrom: string
          diffLeftFrom: string
        }
        /**
         * `produces` name → the sub-sequence's artifact name.
         *
         * Required rather than inferred, because the two vocabularies are
         * genuinely different: `mr-review` calls its output `findings`, and to
         * a `requirement` round that same value is `selfFindings` — findings
         * about its OWN work, not about somebody's merge request. Matching by
         * name would silently produce `undefined` for every renamed output, and
         * the parent's next stage would read an empty review as a clean one.
         */
        collect: Readonly<Record<string, string>>
      }
  )

export interface StageContract {
  capability: CodeCapabilityId
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
export type StageContractRegistry = (capability: CodeCapabilityId) => StageContract | undefined

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
  goal: CodeCapabilityId,
  registry: StageContractRegistry,
  visited: Set<CodeCapabilityId>,
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
