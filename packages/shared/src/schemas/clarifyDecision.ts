import { z } from 'zod'

/** User-authored context, not evidence verification, assignment or a scheduled task. */
export const ClarifyDecisionSchema = z
  .object({
    status: z.enum(['decided', 'provisional']).optional(),
    rationale: z.string().max(2000).optional(),
    tradeoff: z.string().max(2000).optional(),
    uncertainty: z.string().max(2000).optional(),
    validationOwner: z.string().max(200).optional(),
    revisitWhen: z.string().max(500).optional(),
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
  "Preserve the user's original wording and distinguish decisions from provisional assumptions, unverified facts, accepted tradeoffs and review arrangements.",
  'Use the actual Answer and its decision fields as the source of each claim. A custom answer replaces the offered alternatives; it does not inherit any policy from an unselected option. Missing, unselected and explicitly rejected are three different states.',
  'Unmarked answers remain unmarked: present them as current user choices with maturity unmarked, never under an already-decided heading. Only an explicit user-marked decided or provisional status sets maturity; confirming or submitting an answer does not set it. Preserve that status in EVERY later reference, including summaries, scope lists and implementation steps.',
  'Maturity labels and validation arrangements are optional. Do not invent a requirement to mark every choice, resolve every unknown or name every owner before using or implementing this result; clearly describe open consequences for the user to judge. Do not add an approval gate or a "before use" checklist the user did not request.',
  'Present model-inferred consequences separately from user-accepted tradeoffs; never claim that the user accepted a cost they did not state or select. A heading such as "model inference" does not permit inventing its premises: when a premise is unresolved, express the consequence conditionally or omit it.',
  'Unknown or undecided NEVER means no, disabled, absent or rejected. For example, "reminders are undecided" must not become "no reminders" even in a summary or inference; "do not auto-release" does not settle sign-in or recording; a TBD owner is not an ownerless process. A review trigger does not enable the policy being reviewed.',
  'Do not turn an unknown into a fact, invent evidence, assign an unnamed owner, or claim a review task has been scheduled. Explicitly retain missing validation ownership or timing when an item is provisional. User-stated review timing is a proposed arrangement unless the user also says it is scheduled.',
  'Keep the requested deliverable concise. When presenting a decision document, record each choice and its original notes once, with its exact maturity; avoid a second scope/checklist section that restates the same choices with stronger commitments. Provide other requested output normally, under the same evidence constraints.',
  'Before returning, check EVERY factual or policy claim against the answers, not only the quoted sections: is its premise stated, is its maturity unchanged, and are undecided mechanisms still undecided? Remove unsupported scope exclusions, unconditional consequences and extra prerequisites. Preserve the original user wording while correcting your own prose.',
].join('\n')
