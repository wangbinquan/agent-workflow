// RFC-304 — the `script` stage kind, as the round engine runs it.
//
// The stage engine dispatched `program`, `ai` and `invoke`, and answered
// `script` with `notImplemented`. Only `CI_FIX_CONTRACT` declares script stages
// — its first FOUR — so `ci-fix` died at stage zero with "is kind 'script',
// which has no runner registered yet", in every deployment, always.
//
// Nothing about it was undecided. The four slots (`collect`, `classify`,
// `arbitrate`, `select`) are exactly the framework's script slots; the runner
// (`runMonitorScript`) already executes those same four for the monitor loop;
// the result schemas already exist and map one-to-one onto what each stage
// `produces`. Every piece was built and none of them were joined — the same
// shape as the three joins the system-mock E2E turned up (plan §2ter).
//
// ## Why the scripts are the deterministic half
//
// This is the RFC's constitution rather than a style preference: what to fix,
// how to classify a failure, and which agent gets the work are decided by
// PROGRAMS, and the model is called only where judgement is unavoidable. A
// `ci-fix` round is thirteen stages of which exactly one is AI. Running these
// four as scripts is what makes the other twelve reproducible — so a stage
// whose script is missing must REFUSE rather than fall back to asking a model,
// which would quietly convert a deterministic pipeline into a nondeterministic
// one and still look like it worked.

import {
  runMonitorScript,
  type MonitorScriptDefinition,
  type MonitorScriptEnvironment,
} from '@/modules/code-capability/application/monitorScripts'
import type { MonitorScriptSet } from '@/modules/code-capability/application/monitorLoop'
import type {
  StageResult,
  StageRunContext,
} from '@/modules/code-capability/application/stageEngine'
import {
  AgentPlanSchema,
  ClassifiedIssuesSchema,
  CollectResultSchema,
  WorkPackagesSchema,
} from '@/modules/code-capability/domain/monitorContracts'
import type { StageContract } from '@/modules/code-capability/domain/stageContract'
import type { ZodType } from 'zod'

/**
 * What each slot's output is checked against.
 *
 * Keyed by SLOT rather than by stage name: the slot is what the framework
 * author writes, and it is the same vocabulary the monitor loop already uses,
 * so one team's `classify` means the same thing in both places.
 */
const SCHEMA_BY_SLOT: Readonly<Record<string, ZodType<unknown>>> = {
  collect: CollectResultSchema,
  classify: ClassifiedIssuesSchema,
  arbitrate: WorkPackagesSchema,
  select: AgentPlanSchema,
}

export interface ScriptStageEnvironment {
  /** The framework's scripts for this repository's binding. */
  scripts: MonitorScriptSet
  /** Built per stage, because `runDir` and the nonce are per invocation. */
  makeEnv: (stageName: string) => MonitorScriptEnvironment
  signal?: AbortSignal
}

/**
 * One implementation per `script` stage of a contract.
 *
 * Derived from the CONTRACT rather than from a hand-written list, so a script
 * stage added to a contract later gets an implementation automatically instead
 * of reintroducing the "no runner registered" failure this file exists to end.
 */
export function buildScriptStages(
  contract: StageContract,
  env: ScriptStageEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  const out: Record<string, (ctx: StageRunContext) => Promise<StageResult>> = {}

  for (const stage of contract.stages) {
    if (stage.kind !== 'script') continue
    const slot = stage.scriptSlot
    const produces = stage.produces[0]

    out[stage.name] = async (ctx: StageRunContext): Promise<StageResult> => {
      const definition = env.scripts[slot as keyof MonitorScriptSet] as
        | MonitorScriptDefinition
        | undefined
      if (definition === undefined) {
        // Named, and it names the LAYER too: a script lives on the framework
        // (department) layer, which needs `scripts:author` — so a group lead
        // reading this knows the fix is not theirs to make.
        return {
          status: 'failed',
          error: `stage '${stage.name}' needs the framework's '${slot}' script and this capability's framework does not define one — add it to the framework (department layer, requires 'scripts:author')`,
        }
      }
      if (produces === undefined) {
        return {
          status: 'failed',
          error: `stage '${stage.name}' declares no output, so there is nothing to record`,
        }
      }

      const schema = SCHEMA_BY_SLOT[slot]
      if (schema === undefined) {
        // A contract naming a slot with no schema would otherwise accept any
        // JSON at all — which is precisely the determinism this design buys.
        return {
          status: 'failed',
          error: `stage '${stage.name}' uses script slot '${slot}', which has no result contract`,
        }
      }

      // The stage's own `requires` become the script's input, so an author
      // reads exactly what the contract promised them and nothing else. Passing
      // the whole artifact bag would let a script quietly depend on something
      // its contract never declared, and that dependency would break the first
      // time the stage order changed.
      const input: Record<string, unknown> = {}
      for (const key of stage.requires) input[key] = ctx.artifacts[key]

      const outcome = await runMonitorScript({
        definition: { ...definition, name: slot as MonitorScriptDefinition['name'] },
        schema,
        env: env.makeEnv(stage.name),
        input,
        ...(env.signal === undefined ? {} : { signal: env.signal }),
      })

      if (outcome.status === 'blocked') {
        return { status: 'failed', error: `stage '${stage.name}': ${outcome.reason}` }
      }
      return { status: 'done', produced: { [produces]: outcome.value } }
    }
  }

  return out
}
