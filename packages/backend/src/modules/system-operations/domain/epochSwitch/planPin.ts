// RFC-626 §4.2: the plan a direct run started to execute.
//
// The first thing the execution step of an automatic upgrade does is pin its approved plan.
// From then on the run writes fixed, write-once artifacts (the frozen preflight, the frozen
// content manifest, the backup) that a different plan could not overwrite, so the automatic
// loop stops re-planning as soon as the pin exists and reads the pinned plan back instead.
//
// The pin also says which binary pinned it. A session that resumes compares these four values
// with the running binary before it opens the new database: the approved plan and the run
// registered in the target both come from the binary that pinned, and a binary with another
// converter or target contract cannot continue them. The comparison reads only this small
// file — not the plan document, whose strict form a changed binary may be unable to parse.
import { z } from 'zod'
import { EpochDigestSchema } from './model'

/** Relative to `runs/<runId>/`. Written once. */
export const PLAN_PIN_ARTIFACT = 'plan-pinned.json'

/**
 * The failure of a run that the running binary cannot continue because the binary that began
 * it had another converter or target contract. The suffix is what makes the automatic session
 * start a new run (`classifyAutoUpgradeRun`), instead of stopping at an internal error that
 * every restart would meet again.
 */
export const CONVERSION_MATERIAL_CHANGED = 'v3-conversion-material-changed-new-run-required'

// Not strict: a key this binary does not know leaves the values it compares readable.
export const PlanPinSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  planDigest: EpochDigestSchema,
  approvalDigest: EpochDigestSchema,
  candidateBuild: z.string().min(1),
  converterVersion: z.string().min(1),
  targetContractDigest: EpochDigestSchema,
  /** The structure digest of the new database for its provider. */
  targetPlanDigest: EpochDigestSchema,
})
export type PlanPin = z.infer<typeof PlanPinSchema>
export type PinnedMaterial = Pick<
  PlanPin,
  'candidateBuild' | 'converterVersion' | 'targetContractDigest' | 'targetPlanDigest'
>
const MATERIAL = [
  'candidateBuild',
  'converterVersion',
  'targetContractDigest',
  'targetPlanDigest',
] as const satisfies readonly (keyof PinnedMaterial)[]

/** Null when the bytes are not a pin this binary can read. */
export function parsePlanPin(bytes: Uint8Array): PlanPin | null {
  try {
    const parsed = PlanPinSchema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The values of the pin that differ from the running binary's. A pin that cannot be read was
 * written by a binary this one knows nothing about: every value counts as different.
 */
export function pinnedMaterialDifferences(
  pin: PlanPin | null,
  current: PinnedMaterial,
): readonly (keyof PinnedMaterial)[] {
  return MATERIAL.filter((name) => pin === null || pin[name] !== current[name])
}
