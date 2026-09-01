import { and, desc, eq } from 'drizzle-orm'

import { employeeReactionRounds } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { EmployeeReactionRoundQueryPort } from '../public/types'

const SETTLED_ROUND_STATES = ['completed'] as const

export function createPostgresqlReactionRoundQueries(
  db: PostgresqlDatabaseClient,
): EmployeeReactionRoundQueryPort {
  return Object.freeze({
    async frozenPlan(roundRef: string) {
      const row = await db
        .select({
          caseId: employeeReactionRounds.caseId,
          planJson: employeeReactionRounds.planJson,
        })
        .from(employeeReactionRounds)
        .where(eq(employeeReactionRounds.id, roundRef))
        .limit(1)
        .get()
      return row === undefined ? null : { caseId: row.caseId, planJson: row.planJson }
    },
    async lastSettledRound(input: { readonly caseId: string; readonly workItemRef: string }) {
      const [settled] = SETTLED_ROUND_STATES
      const row = await db
        .select({ id: employeeReactionRounds.id })
        .from(employeeReactionRounds)
        .where(
          and(
            eq(employeeReactionRounds.caseId, input.caseId),
            eq(employeeReactionRounds.workItemRef, input.workItemRef),
            eq(employeeReactionRounds.state, settled),
          ),
        )
        .orderBy(desc(employeeReactionRounds.settledAt))
        .limit(1)
        .get()
      return row === undefined ? null : { roundRef: row.id }
    },
  })
}
