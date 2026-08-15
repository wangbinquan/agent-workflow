// RFC-304 T7 — resolving a repository's stage hooks, and actually firing them.
//
// `application/hookRunner.ts` shipped with PR-1a, complete and tested, and
// nothing called it. That is not a small gap: every stage file in this module
// justifies its own existence by saying the engine fires hooks at each stage
// BOUNDARY, and that a sequence collapsed into fewer stages would silently
// remove a team's injection and blocking points. With no caller, the sequence
// had thirteen boundaries and zero hooks — the claim the design rests on was
// false, and nothing failed, because an absent mechanism never errors.
//
// ## Where a hook comes from
//
// The department layer (§2.5). A repository's cell names a binding, the binding
// names a framework, and the framework carries the hooks — scripts that run as
// the daemon, which is exactly why they live on the layer whose write
// permission requires `scripts:author` and not on the binding a group lead can
// edit.
//
// ## Why a malformed hooks column does not fail the round
//
// It disables the hooks and says so. The alternative — refusing to review
// anything until someone fixes a JSON column — takes the platform down for
// every MR in the repository because one framework was edited badly. A team
// whose gate has stopped gating needs to know; a team whose reviews have
// stopped entirely needs it less.

import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { capabilityBindings, capabilityFrameworks, repoCapabilityConfig } from '@/db/schema'
import type { CapabilityHook } from '@/modules/code-capability/application/hookRunner'

export interface ResolvedHooks {
  hooks: readonly CapabilityHook[]
  /** The framework's declared contract version, for the T8 migration check. */
  stageContractVer: number
  /**
   * Why there are no hooks, when that is a fault rather than a choice.
   *
   * Null when the repository simply has none configured — the common case, and
   * not something to report.
   */
  problem: string | null
}

const NONE: ResolvedHooks = { hooks: [], stageContractVer: 1, problem: null }

/**
 * Parse one hook entry, or reject it by name.
 *
 * Per entry rather than all-or-nothing: one malformed hook in a framework of
 * five should not silently disarm the other four, and it must be named, because
 * "hooks did not run" with no further detail is unactionable.
 */
function parseHook(
  value: unknown,
  index: number,
  frameworkVer: number,
): { ok: true; hook: CapabilityHook } | { ok: false; why: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, why: `hook #${index} is not an object` }
  }
  const raw = value as Record<string, unknown>
  const stage = raw.stage
  const phase = raw.phase
  const script = raw.script
  const language = raw.language

  if (typeof stage !== 'string' || stage === '') {
    return { ok: false, why: `hook #${index} does not name a stage` }
  }
  if (phase !== 'pre' && phase !== 'post') {
    return {
      ok: false,
      why: `hook #${index} (${stage}) has phase '${String(phase)}', not pre/post`,
    }
  }
  if (typeof script !== 'string' || script.trim() === '') {
    return { ok: false, why: `hook #${index} (${stage}) has no script body` }
  }
  if (typeof language !== 'string' || language === '') {
    return { ok: false, why: `hook #${index} (${stage}) does not name a script language` }
  }

  return {
    ok: true,
    hook: {
      stage,
      phase,
      script,
      language: language as CapabilityHook['language'],
      // The framework's version unless the hook pins its own: the T8 check
      // compares this against what the platform runs, and defaulting to the
      // CURRENT version would make the check vacuous.
      stageContractVer:
        typeof raw.stageContractVer === 'number' ? raw.stageContractVer : frameworkVer,
      ...(raw.blocking === true ? { blocking: true } : {}),
      ...(typeof raw.env === 'object' && raw.env !== null
        ? { env: raw.env as Record<string, string> }
        : {}),
    },
  }
}

/**
 * The hooks configured for one repository's capability.
 *
 * Returns none — not an error — when the repository has no cell, no binding, or
 * a framework with an empty hooks list. Those are ordinary states: most
 * repositories never write a hook.
 */
export async function resolveCapabilityHooks(
  db: DbClient,
  input: { repoId: string; capability: string },
): Promise<ResolvedHooks> {
  const [cell] = await db
    .select({ bindingId: repoCapabilityConfig.bindingId })
    .from(repoCapabilityConfig)
    .where(
      // `and(...)`, never `&&`: a JS `&&` between two drizzle conditions
      // evaluates to the SECOND one, so the repo filter would silently vanish
      // and every repository would inherit whichever cell sorted first.
      and(
        eq(repoCapabilityConfig.repoId, input.repoId),
        eq(repoCapabilityConfig.capability, input.capability),
      ),
    )
  if (cell?.bindingId == null) return NONE

  const [binding] = await db
    .select({ frameworkId: capabilityBindings.frameworkId })
    .from(capabilityBindings)
    .where(eq(capabilityBindings.id, cell.bindingId))
  if (binding === undefined) return NONE

  const [framework] = await db
    .select({
      hooksJson: capabilityFrameworks.hooksJson,
      stageContractVer: capabilityFrameworks.stageContractVer,
    })
    .from(capabilityFrameworks)
    .where(eq(capabilityFrameworks.id, binding.frameworkId))
  if (framework === undefined) return NONE

  let parsed: unknown
  try {
    parsed = JSON.parse(framework.hooksJson)
  } catch {
    return {
      hooks: [],
      stageContractVer: framework.stageContractVer,
      problem: `the framework's hooks are not valid JSON, so no hook ran this round`,
    }
  }
  if (!Array.isArray(parsed)) {
    return {
      hooks: [],
      stageContractVer: framework.stageContractVer,
      problem: `the framework's hooks are not a list, so no hook ran this round`,
    }
  }

  const hooks: CapabilityHook[] = []
  const rejected: string[] = []
  for (const [index, entry] of parsed.entries()) {
    const result = parseHook(entry, index, framework.stageContractVer)
    if (result.ok) hooks.push(result.hook)
    else rejected.push(result.why)
  }

  return {
    hooks,
    stageContractVer: framework.stageContractVer,
    problem: rejected.length === 0 ? null : rejected.join('; '),
  }
}

/** Hooks mounted on one stage and phase, in declaration order. */
export function hooksFor(
  hooks: readonly CapabilityHook[],
  stageName: string,
  phase: 'pre' | 'post',
): readonly CapabilityHook[] {
  return hooks.filter((h) => h.stage === stageName && h.phase === phase)
}
