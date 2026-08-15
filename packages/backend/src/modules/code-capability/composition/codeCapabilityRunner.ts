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
    invoke: notImplemented('invoke'),
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
