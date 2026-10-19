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
export function summariseClarifyDecision(value: ClarifyDecision | undefined): string {
  const decision = normalizeClarifyDecision(value)
  if (!decision) return ''
  const fields: [keyof ClarifyDecision, string][] = [
    ['status', 'Decision status (user marked)'],
    ['rationale', 'User rationale'],
    ['tradeoff', 'Accepted tradeoff'],
    ['uncertainty', 'Still unverified'],
    ['validationOwner', 'Validation owner (user named)'],
    ['revisitWhen', 'Revisit when'],
  ]
  return fields
    .filter(([key]) => decision[key])
    .map(([key, label]) => `${label}: ${JSON.stringify(decision[key])}`)
    .join('; ')
}

export const CLARIFY_DECISION_OUTPUT_GUIDANCE =
  "Preserve the user's original wording and distinguish decisions from provisional assumptions, unverified facts, accepted tradeoffs and review arrangements. Do not turn an unknown into a fact, invent evidence, assign an unnamed owner, or claim a review task has been scheduled. Explicitly retain missing validation ownership or timing when an item is provisional."
