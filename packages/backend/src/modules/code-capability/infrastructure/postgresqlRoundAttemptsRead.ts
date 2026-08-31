// RFC-349 — PostgreSQL projection for bounded AI attempt history.

import { eq } from 'drizzle-orm'

import { codeAiAttempts } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { RoundAttemptsReadPort } from '../application/ports/roundAttemptsRead'

export function createPostgresqlRoundAttemptsRead(
  db: PostgresqlDatabaseClient,
): RoundAttemptsReadPort {
  return {
    async load(roundId, limit) {
      const rows = await db
        .select({
          attemptId: codeAiAttempts.id,
          stageName: codeAiAttempts.stageName,
          shardKey: codeAiAttempts.shardKey,
          rerunSeq: codeAiAttempts.rerunSeq,
          attemptSeq: codeAiAttempts.attemptSeq,
          status: codeAiAttempts.status,
          validationOutcome: codeAiAttempts.validationOutcome,
          sessionRef: codeAiAttempts.sessionRef,
          nodeRunId: codeAiAttempts.nodeRunId,
          startedAt: codeAiAttempts.startedAt,
          endedAt: codeAiAttempts.endedAt,
        })
        .from(codeAiAttempts)
        .where(eq(codeAiAttempts.roundId, roundId))
        .orderBy(codeAiAttempts.startedAt, codeAiAttempts.rerunSeq, codeAiAttempts.attemptSeq)
        .limit(limit)
      return rows
    },
  }
}
