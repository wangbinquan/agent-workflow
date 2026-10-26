import type { CodeHistoryReader } from '../application/ports/historyReader'
import type { RoundAttemptsReadPort } from '../application/ports/roundAttemptsRead'

export function createRoundAttemptsRead(history: CodeHistoryReader): RoundAttemptsReadPort {
  return {
    async load(roundId, limit) {
      return (await history.rows('code_ai_attempts'))
        .filter((row) => row.round_id === roundId)
        .sort(
          (a, b) =>
            a.started_at - b.started_at ||
            a.rerun_seq - b.rerun_seq ||
            a.attempt_seq - b.attempt_seq,
        )
        .slice(0, Math.min(limit, 200))
        .map((row) => ({
          attemptId: row.id,
          stageName: row.stage_name,
          shardKey: row.shard_key,
          rerunSeq: row.rerun_seq,
          attemptSeq: row.attempt_seq,
          status: row.status,
          validationOutcome: row.validation_outcome,
          sessionRef: row.session_ref,
          nodeRunId: row.node_run_id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
        }))
    },
  }
}
