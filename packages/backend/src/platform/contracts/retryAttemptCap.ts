import { z } from 'zod'

/**
 * RFC-334 — exact cross-context policy value for neutral attempt-cap arithmetic.
 * Domain retry state and decisions deliberately do not belong in this contract.
 */
export const RetryAttemptCapPolicyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    followupBudget: z.number(),
    restartBudget: z.number(),
  })
  .strict()

export type RetryAttemptCapPolicyV1 = z.infer<typeof RetryAttemptCapPolicyV1Schema>

/** One below scheduler assembly's invariant-failure fuse. */
export const RETRY_ATTEMPT_CAP_CEILING = 99

function normalizeBudget(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

/**
 * Total neutral arithmetic shared by TaskExecution and DigitalEmployee.
 * It says only how many attempts are available, never how either domain retries.
 */
export function retryAttemptCap(followupBudget: number, restartBudget: number): number {
  const product = (1 + normalizeBudget(followupBudget)) * (1 + normalizeBudget(restartBudget))
  return Math.min(product, RETRY_ATTEMPT_CAP_CEILING)
}

export function retryAttemptCapFromPolicy(policy: RetryAttemptCapPolicyV1): number {
  return retryAttemptCap(policy.followupBudget, policy.restartBudget)
}
