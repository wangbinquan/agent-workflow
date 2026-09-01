// RFC-349 — SQLite projection for bounded AI attempt history.

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeAiAttempts } from '@/db/schema'
import type { RoundAttemptsReadPort } from '../application/ports/roundAttemptsRead'

export function createSqliteRoundAttemptsRead(db: DbClient): RoundAttemptsReadPort {
  return {
    async load(roundId, limit) {
      return await db
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
    },
  }
}
