// RFC-304 §2.5 — the two template layers, and what each is allowed to carry.
//
// The split is a PERMISSION model wearing the clothes of a data model:
//
//   department (framework) — scripts + hooks. These run as the daemon, with the
//                            daemon's whole credential surface, so writing one
//                            additionally requires `scripts:author` (C2).
//   group      (binding)   — which agent fills which AI slot, prompts, params.
//                            No scripts, no hooks. That absence is what lets a
//                            group lead own their binding without being handed
//                            the daemon.
//
// The binding TABLE has no columns for scripts or hooks, so the boundary holds
// even against a raw SQL writer. This module is the second line: it refuses the
// fields on the write path, so a caller sending them gets told, rather than
// having them silently dropped and wondering why their hook never ran.
//
// Parameter resolution used to live here as well, as a second implementation
// alongside `traceCapabilityParams` in @agent-workflow/shared. It has been
// deleted rather than kept in sync: this one was never called, so the two could
// disagree indefinitely without anything failing, and the surviving one knows
// more (the whole param TABLE, not just a list of key names). Provenance — the
// "which value won and from where" that support questions turn on — moved
// across with it.

/**
 * Fields only a framework may carry. A binding write naming any of them is
 * REJECTED rather than stripped: silently dropping a hook someone wrote is how
 * a team ends up believing their gate is running when it never was.
 */
export const FRAMEWORK_ONLY_FIELDS = [
  'scripts',
  'scriptsJson',
  'hooks',
  'hooksJson',
  'paramSchema',
  'paramSchemaJson',
  'stageContractVer',
] as const

export type BindingWriteRejection = {
  code: 'binding-carries-framework-only-field'
  field: string
  message: string
}

/**
 * Check a binding write payload for department-layer fields.
 *
 * Takes the raw object, before schema parsing: a zod schema that simply omits
 * unknown keys would strip these silently, which is the outcome this exists to
 * prevent.
 */
export function rejectFrameworkOnlyFields(payload: unknown): BindingWriteRejection[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return []
  const out: BindingWriteRejection[] = []
  for (const field of FRAMEWORK_ONLY_FIELDS) {
    if (!Object.hasOwn(payload, field)) continue
    out.push({
      code: 'binding-carries-framework-only-field',
      field,
      message:
        `'${field}' belongs to the capability framework (department layer), not to a binding. ` +
        `Scripts and hooks run with the daemon's credentials, so editing them requires the ` +
        `scripts:author permission on the framework itself.`,
    })
  }
  return out
}

/** Whether an actor may write a framework: resource write access AND scripts:author. */
export function canWriteFramework(input: {
  hasResourceWrite: boolean
  hasScriptsAuthor: boolean
}): boolean {
  // Both, not either. Resource write alone would let a binding owner who was
  // granted the framework reach the daemon's surface; `scripts:author` alone
  // would bypass the resource ACL entirely.
  return input.hasResourceWrite && input.hasScriptsAuthor
}

export type ReadinessState = 'disabled' | 'misconfigured' | 'ready'

export interface ReadinessIssue {
  /** Machine code so the UI can offer the matching one-click fix. */
  code:
    | 'no-binding'
    | 'no-trigger'
    | 'code-host-unconfigured'
    | 'agent-not-visible'
    | 'framework-missing'
    | 'no-wake-source'
  /** One human line naming what is missing. */
  detail: string
}

export interface ReadinessInput {
  enabled: boolean
  hasBinding: boolean
  frameworkExists: boolean
  hasTrigger: boolean
  codeHostConfigured: boolean
  /** Agent slots whose agent is missing or invisible to this repo's audience. */
  invisibleAgentSlots: readonly string[]
  /**
   * Whether a wake source exists. Required only for capabilities that have no
   * other way to be woken — `ci-fix` in particular (AC-14d): without this it
   * would show `ready` while nothing could ever start it.
   */
  requiresWakeSource: boolean
  hasWakeSource: boolean
}

/**
 * Derive a cell's readiness.
 *
 * Every non-ready answer carries the SPECIFIC missing pieces, because the
 * failure this state exists to prevent is "configured, silent, and no way to
 * tell why" — the most common reason a platform like this gets abandoned.
 */
export function deriveReadiness(input: ReadinessInput): {
  state: ReadinessState
  issues: readonly ReadinessIssue[]
} {
  if (!input.enabled) return { state: 'disabled', issues: [] }

  const issues: ReadinessIssue[] = []
  if (!input.hasBinding) {
    issues.push({ code: 'no-binding', detail: 'no capability binding is selected for this repo' })
  } else if (!input.frameworkExists) {
    // Only meaningful once a binding exists; reporting both would send the user
    // looking for a framework they never chose.
    issues.push({
      code: 'framework-missing',
      detail: 'the selected binding references a framework that no longer exists',
    })
  }
  if (!input.hasTrigger) {
    issues.push({ code: 'no-trigger', detail: 'no webhook trigger is wired for this repo' })
  }
  if (!input.codeHostConfigured) {
    issues.push({
      code: 'code-host-unconfigured',
      detail: 'no code-host connection is configured, so results cannot be published',
    })
  }
  for (const slot of input.invisibleAgentSlots) {
    issues.push({
      code: 'agent-not-visible',
      detail: `the agent bound to slot '${slot}' is missing or not visible here`,
    })
  }
  if (input.requiresWakeSource && !input.hasWakeSource) {
    issues.push({
      code: 'no-wake-source',
      detail: 'this capability has no pipeline event or wake entry point, so nothing can start it',
    })
  }

  return issues.length === 0 ? { state: 'ready', issues: [] } : { state: 'misconfigured', issues }
}
