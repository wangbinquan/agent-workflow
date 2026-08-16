// RFC-304 — the single assembly point for the code-capability runner.
//
// Everything the runner needs (the db handle, the contract registry, the stage
// runners) is wired HERE and nowhere else, so the public interface stays a
// verb and the scheduler never learns the module's internals.
//
// PR-1b registers program-stage runners only. `script`, `ai` and `invoke`
// arrive with the capabilities that need them — and each returns a stated
// failure rather than silently succeeding, because a stage that quietly did
// nothing is the failure mode this whole RFC exists to avoid.

import type { DbClient } from '@/db/client'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import {
  parseCodeCapabilityId,
  type CodeCapabilityId,
  type StageContract,
} from '@/modules/code-capability/domain/stageContract'
import {
  runStageSequence,
  type StageHooks,
  type StageRunContext,
  type StageResult,
  type StageRunners,
} from '@/modules/code-capability/application/stageEngine'
import { invokeSubSequence } from '@/modules/code-capability/application/invokeSubSequence'
import {
  injectableKeysFor,
  runCapabilityHook,
  type CapabilityHook,
} from '@/modules/code-capability/application/hookRunner'
import type {
  CodeCapabilityRunner,
  CodeRoundExecutionInput,
  CodeRoundExecutionResult,
} from '@/modules/code-capability/public/types'

/** A stage kind that has no implementation yet fails loudly, never silently. */
const notImplemented =
  (kind: string) =>
  async (ctx: StageRunContext): Promise<StageResult> => ({
    status: 'failed',
    error: `stage '${ctx.stage.name}' is kind '${kind}', which has no runner registered yet`,
  })

export interface CodeCapabilityRunnerDeps {
  db: DbClient
  /**
   * Program-stage implementations, keyed by stage name. A capability's own PR
   * registers its stages here; an unregistered name fails the round rather
   * than skipping the stage.
   */
  programStages?: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  /**
   * Where a capability's contract comes from. Defaults to the built-in
   * registry. Injectable because a group's binding will eventually select which
   * contract version a repo runs (PR-2) — the runner should not hard-code the
   * assumption that there is exactly one contract per capability forever.
   */
  lookupContract?: (capability: CodeCapabilityId) => StageContract | undefined
  /** AI-stage implementations, keyed by stage name (PR-4a onward). */
  aiStages?: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
  /**
   * Stage implementations for capabilities this one INVOKES, keyed by
   * capability then stage name (RFC-304 §6.3 `self-review`).
   *
   * Keyed by capability rather than merged into the maps above, because stage
   * names collide across contracts on purpose — `prepare-worktree` means
   * something in `requirement` and something else in `mr-review`. One flat map
   * would silently resolve a sub-stage to the parent's implementation, and the
   * sub-sequence would run against the wrong tree while looking healthy.
   */
  invokedStages?: Readonly<
    Partial<
      Record<
        CodeCapabilityId,
        {
          program?: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
          ai?: Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>>
        }
      >
    >
  >
  /**
   * Artifacts the resumed prefix would have produced (RFC-304 §6.2).
   *
   * A confirming round skips the stages that posted the change; whatever the
   * remaining stages read has to be supplied here, recomputed from durable
   * state — the trigger context on the task row, the artifact store — rather
   * than remembered from a process that has exited.
   *
   * On the runner's assembly rather than the public round contract: the
   * artifact vocabulary is this module's own, and putting an open
   * `unknown`-valued map on the public surface is exactly what the
   * architecture preflight forbids.
   */
  inheritedArtifacts?: Readonly<Record<string, unknown>>
  /**
   * A team's stage hooks, and what they need to run.
   *
   * Absent means no hooks fire — which is the ordinary case, since most
   * repositories never write one. It must NOT be the case in production for a
   * repository that HAS written one: every stage in this module justifies being
   * a separate stage by saying a hook fires at its boundary, and a runner
   * assembled without this makes that claim false while nothing fails.
   */
  hooks?: CapabilityHookWiring
  signal?: AbortSignal
}

export interface CapabilityHookWiring {
  hooks: readonly CapabilityHook[]
  /** The contract version the platform runs; a hook declaring another is refused. */
  currentStageContractVer: number
  /** Scratch directory for hook scripts and their spilled inputs. */
  runDir: string
  interpreterPath: string
  /** Identity a hook reads through `AW_CWI_*` (design §4.3 F10). */
  workItem: {
    anchorKind: string
    anchorId: string
    baselineSha: string | null
  }
  timeoutMs?: number
  /**
   * Where a non-blocking hook's failure goes.
   *
   * A non-blocking hook that fails must not stop the round (design §4.3 F8) —
   * but it must not vanish either, or a team's lint gate can rot for months
   * while the reviews keep coming back clean.
   */
  onHookProblem?: (problem: { stage: string; phase: 'pre' | 'post'; reason: string }) => void
}

export function createCodeCapabilityRunner(deps: CodeCapabilityRunnerDeps): CodeCapabilityRunner {
  const runners: StageRunners = {
    program: async (ctx) => {
      const impl = deps.programStages?.[ctx.stage.name]
      if (impl === undefined) {
        return {
          status: 'failed',
          error: `program stage '${ctx.stage.name}' has no registered implementation`,
        }
      }
      return await impl(ctx)
    },
    script: notImplemented('script'),
    ai: async (ctx) => {
      const impl = deps.aiStages?.[ctx.stage.name]
      if (impl === undefined) {
        return {
          status: 'failed',
          error: `ai stage '${ctx.stage.name}' has no registered implementation`,
        }
      }
      return await impl(ctx)
    },
    invoke: async (ctx) => {
      if (ctx.stage.kind !== 'invoke') {
        return { status: 'failed', error: `stage '${ctx.stage.name}' is not an invoke stage` }
      }
      const target = ctx.stage.invokes.capability
      const supplied = deps.invokedStages?.[target]
      if (supplied === undefined) {
        // Loud rather than silent: a `self-review` that quietly did nothing
        // would let a requirement round open a merge request claiming it had
        // been reviewed.
        return {
          status: 'failed',
          error: `stage '${ctx.stage.name}' invokes '${target}', whose stage implementations were not supplied to the runner`,
        }
      }

      const out = await invokeSubSequence({
        db: deps.db,
        roundId: ctx.roundId,
        parentStage: ctx.stage.name,
        invokes: ctx.stage.invokes,
        seedArtifacts: ctx.artifacts,
        runners: {
          program: async (sub) => {
            const impl = supplied.program?.[sub.stage.name]
            return impl === undefined
              ? {
                  status: 'failed',
                  error: `invoked program stage '${sub.stage.name}' has no registered implementation`,
                }
              : await impl(sub)
          },
          ai: async (sub) => {
            const impl = supplied.ai?.[sub.stage.name]
            return impl === undefined
              ? {
                  status: 'failed',
                  error: `invoked ai stage '${sub.stage.name}' has no registered implementation`,
                }
              : await impl(sub)
          },
          script: notImplemented('script'),
          // No nesting. An invoke inside an invoke has no defined hook naming
          // and no reason to exist yet; refusing beats inventing semantics
          // nobody has thought through.
          invoke: notImplemented('nested invoke'),
        },
        ...(deps.lookupContract === undefined ? {} : { lookupContract: deps.lookupContract }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      })

      if (out.outcome === 'failed') return { status: 'failed', error: out.error }
      if (out.outcome === 'blocked') {
        return { status: 'failed', error: `blocked at '${out.blockedStage}': ${out.reason}` }
      }
      if (out.outcome === 'canceled') {
        return { status: 'failed', error: `canceled at '${out.canceledStage}'` }
      }

      // Only the declared outputs cross back. Merging the whole sub-artifact set
      // would let the invoked capability's `worktree` or `target` overwrite the
      // parent's — same names, different meanings.
      const produced: Record<string, unknown> = {}
      for (const name of ctx.stage.produces) {
        const source = ctx.stage.collect[name]
        if (source === undefined) {
          return {
            status: 'failed',
            error: `stage '${ctx.stage.name}' declares output '${name}' but its \`collect\` map does not say which sub-artifact it comes from`,
          }
        }
        const value = out.artifacts[source]
        if (value === undefined) {
          // A declared output the sub-sequence never produced. Loud, because
          // the parent's next stage would otherwise read an empty review as a
          // clean one.
          return {
            status: 'failed',
            error: `stage '${ctx.stage.name}' expected '${source}' from '${target}', which produced nothing under that name`,
          }
        }
        produced[name] = value
      }
      return { status: 'done', produced }
    },
  }

  return {
    async runRound(input: CodeRoundExecutionInput): Promise<CodeRoundExecutionResult> {
      const lookup = deps.lookupContract ?? lookupStageContract
      // Parsed, never cast: `input.capability` arrives as a plain string from
      // the task snapshot, and a cast would let a typo in a binding pose as a
      // capability the platform ships.
      const capability = parseCodeCapabilityId(input.capability)
      const contract = capability === undefined ? undefined : lookup(capability)
      if (contract === undefined) {
        // A configuration fault, not a stage failure: naming a capability the
        // platform does not ship means the binding is wrong, and saying so
        // beats failing at whatever stage happens to be first.
        return { outcome: 'unknown-capability', capability: input.capability }
      }

      const out = await runStageSequence({
        db: deps.db,
        roundId: input.roundId,
        contract,
        runners,
        resumeFromStage: input.resumeFromStage,
        ...(deps.inheritedArtifacts === undefined
          ? {}
          : { inheritedArtifacts: { ...deps.inheritedArtifacts } }),
        ...(deps.hooks !== undefined ? { hooks: buildStageHooks(deps.hooks, input) } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      })

      switch (out.outcome) {
        case 'done':
          return {
            outcome: 'done',
            summary: `${input.capability}: ${contract.stages.length} stage(s)`,
          }
        case 'failed':
          return { outcome: 'failed', failedStage: out.failedStage, error: out.error }
        case 'blocked':
          return { outcome: 'blocked', blockedStage: out.blockedStage, reason: out.reason }
        case 'canceled':
          return { outcome: 'canceled', canceledStage: out.canceledStage }
        case 'awaiting':
          return {
            outcome: 'awaiting',
            awaitingStage: out.awaitingStage,
            resumeAt: out.resumeAt,
            reason: out.reason,
          }
      }
    },
  }
}

/**
 * Turn a team's configured hooks into the pre/post callbacks the engine fires.
 *
 * The mapping from `HookOutcome` to engine behaviour is where the design's
 * §4.3 F8 distinction lives, and it is the whole reason a hook is worth having:
 *
 *   blocked            → the sequence stops. A team's gate said no, and that is
 *                        a decision, not an error.
 *   failed-nonblocking → recorded, the round continues. An optional lint hook
 *                        going red must not strand somebody's MR.
 *   needs-migration    → recorded, NOT run. Running a hook against a contract it
 *                        was not written for feeds it a shape it cannot read;
 *                        skipping it silently means a team's gate quietly stops
 *                        gating. Reporting is the only honest third option.
 */
function buildStageHooks(wiring: CapabilityHookWiring, input: CodeRoundExecutionInput): StageHooks {
  const envFor = (): Parameters<typeof runCapabilityHook>[0]['env'] => ({
    worktreePath: input.worktreePath,
    runDir: wiring.runDir,
    repos: input.repos.map((r) => ({ name: r.name, path: r.path })),
    interpreterPath: wiring.interpreterPath,
    workItem: {
      capability: input.capability,
      anchorKind: wiring.workItem.anchorKind,
      anchorId: wiring.workItem.anchorId,
      roundId: input.roundId,
      roundSeq: input.roundSeq,
      baselineSha: wiring.workItem.baselineSha,
    },
    envelopeNonce: input.envelopeNonce,
    ...(wiring.timeoutMs !== undefined ? { timeoutMs: wiring.timeoutMs } : {}),
  })

  const report = (stage: string, phase: 'pre' | 'post', reason: string): void => {
    wiring.onHookProblem?.({ stage, phase, reason })
  }

  return {
    async pre(ctx) {
      const mounted = wiring.hooks.filter((h) => h.stage === ctx.stage.name && h.phase === 'pre')
      const injected: Record<string, string> = {}

      for (const hook of mounted) {
        const outcome = await runCapabilityHook({
          hook,
          stage: ctx.stage,
          env: envFor(),
          currentStageContractVer: wiring.currentStageContractVer,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })

        switch (outcome.status) {
          case 'blocked':
            return { block: outcome.reason }
          case 'failed-nonblocking':
            report(hook.stage, 'pre', outcome.reason)
            break
          case 'needs-migration':
            report(
              hook.stage,
              'pre',
              `this hook is written against stage contract v${outcome.declared} but the platform runs v${outcome.current}, so it did not run — migrate it`,
            )
            break
          case 'ok':
            // Already allowlist-filtered by the runner. Merged across hooks in
            // declaration order, so a later hook on the same stage deliberately
            // wins — the alternative (first writer wins) makes an added hook
            // look broken.
            Object.assign(injected, outcome.injected)
            for (const key of outcome.droppedKeys) {
              report(
                hook.stage,
                'pre',
                `injected key '${key}' is not in this stage's allowlist (${injectableKeysFor(ctx.stage, 'pre').join(', ') || 'none'}) and was dropped`,
              )
            }
            break
        }
      }

      return Object.keys(injected).length > 0 ? { inject: injected } : undefined
    },

    async post(ctx) {
      const mounted = wiring.hooks.filter((h) => h.stage === ctx.stage.name && h.phase === 'post')
      for (const hook of mounted) {
        const outcome = await runCapabilityHook({
          hook,
          stage: ctx.stage,
          env: envFor(),
          currentStageContractVer: wiring.currentStageContractVer,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
        // A `post` hook cannot block: the stage has already run and its result
        // is already the sequence's. Reporting a blocking post-hook's refusal
        // as a problem is honest; pretending it stopped anything would not be.
        if (outcome.status === 'blocked' || outcome.status === 'failed-nonblocking') {
          report(hook.stage, 'post', outcome.reason)
        } else if (outcome.status === 'needs-migration') {
          report(
            hook.stage,
            'post',
            `this hook is written against stage contract v${outcome.declared} but the platform runs v${outcome.current}, so it did not run — migrate it`,
          )
        }
      }
    },
  }
}
