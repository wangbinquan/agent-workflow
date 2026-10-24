import { z } from 'zod'
import { utf16MaxLength } from './utf16Length'

/** User-authored context, not evidence verification, assignment or a scheduled task. */
export const ClarifyDecisionSchema = z
  .object({
    status: z.enum(['decided', 'provisional']).optional(),
    rationale: z.string().check(utf16MaxLength(2000)).optional(),
    tradeoff: z.string().check(utf16MaxLength(2000)).optional(),
    uncertainty: z.string().check(utf16MaxLength(2000)).optional(),
    validationOwner: z.string().check(utf16MaxLength(200)).optional(),
    revisitWhen: z.string().check(utf16MaxLength(500)).optional(),
  })
  .transform(normalizeClarifyDecision)

export interface ClarifyDecision {
  status?: 'decided' | 'provisional'
  rationale?: string
  tradeoff?: string
  uncertainty?: string
  validationOwner?: string
  revisitWhen?: string
}

/** Preserve meaningful user wording; whitespace-only fields and empty objects are absent. */
export function normalizeClarifyDecision(
  value: ClarifyDecision | undefined,
): ClarifyDecision | undefined {
  if (!value) return undefined
  const result: ClarifyDecision = {}
  if (value.status) result.status = value.status
  for (const key of [
    'rationale',
    'tradeoff',
    'uncertainty',
    'validationOwner',
    'revisitWhen',
  ] as const) {
    if (value[key]?.trim()) result[key] = value[key]
  }
  return Object.keys(result).length ? result : undefined
}

export function clarifyDecisionsEqual(
  a: ClarifyDecision | undefined,
  b: ClarifyDecision | undefined,
): boolean {
  return JSON.stringify(normalizeClarifyDecision(a)) === JSON.stringify(normalizeClarifyDecision(b))
}

/** Deterministic readback, shared by self and cross clarify prompt rendering. */
export function summariseClarifyDecision(
  value: ClarifyDecision | undefined,
  includeUnmarkedStatus = false,
): string {
  const decision = normalizeClarifyDecision(value)
  const fields: [keyof ClarifyDecision, string][] = [
    ['status', 'Decision status (user marked)'],
    ['rationale', 'User rationale'],
    ['tradeoff', 'Accepted tradeoff'],
    ['uncertainty', 'Still unverified'],
    ['validationOwner', 'Validation owner (user named)'],
    ['revisitWhen', 'Revisit when'],
  ]
  const parts = fields
    .filter(([key]) => decision?.[key])
    .map(([key, label]) => `${label}: ${JSON.stringify(decision?.[key])}`)
  if (includeUnmarkedStatus && !decision?.status) {
    parts.unshift('Decision status: "unmarked" (the user has not marked decision maturity)')
  }
  return parts.join('; ')
}

export const CLARIFY_DECISION_OUTPUT_GUIDANCE = [
  'Produce the requested deliverable now. For a decision document use: a brief supplied context, then ONE entry per answer containing its maturity, original choice and original decision notes. Keep the notes under their own labels (rationale, accepted cost, unknowns, validation owner, review condition). This readback is sufficient; do not add a second scope list, implementation checklist or repeated summary of the same choices. For another requested deliverable, apply the same evidence rules in its appropriate format.',
  "The actual Answer and decision fields are authoritative. Preserve the user's original wording. A custom answer replaces offered alternatives. Missing, unselected and explicitly rejected are three different states. Unmarked answers remain unmarked; only the user-marked decided or provisional value sets maturity, including any later reference.",
  'Keep model-inferred consequences separately from accepted costs and make unresolved premises conditional. Unknown is not no: "reminders are undecided" must not become "no reminders". Not enabling one mechanism does not decide any other mechanism; retain choices already made elsewhere. Do not invent evidence, an unnamed owner, or a scheduled task; retain TBD owners and timing as open arrangements. Review triggers do not activate a policy.',
  'Maturity labels and validation arrangements are optional. Do not invent a requirement to mark every choice, settle unknowns or assign owners before proceeding. Describe any open consequence for the user to judge, without adding an approval gate. Finish the requested output envelope after this straightforward readback; do not repeatedly reformulate or expand it.',
].join('\n')
