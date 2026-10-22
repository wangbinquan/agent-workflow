// RFC-359 W4-B5 —— 轮次 AI 尝试历史的有界投影：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { RoundAttemptsReadPort } from '../application/ports/roundAttemptsRead'

export function createRoundAttemptsRead(db: PersistenceDb): RoundAttemptsReadPort {
  return {
    async load(roundId, limit) {
      const { codeAiAttempts } = tablesOf(db)
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
