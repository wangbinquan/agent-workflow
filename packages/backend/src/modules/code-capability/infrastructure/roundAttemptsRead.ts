// RFC-359 W4-B5 —— 轮次 AI 尝试历史的有界投影：一份实现，两个 provider 共用。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { codeAiAttempts } from '@/db/schema'
import type { RoundAttemptsReadPort } from '../application/ports/roundAttemptsRead'

export function createRoundAttemptsRead(db: ProviderNeutralDatabase): RoundAttemptsReadPort {
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
