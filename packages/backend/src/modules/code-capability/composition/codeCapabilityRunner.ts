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
  type StageRunContext,
  type StageResult,
  type StageRunners,
} from '@/modules/code-capability/application/stageEngine'
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
  signal?: AbortSignal
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
