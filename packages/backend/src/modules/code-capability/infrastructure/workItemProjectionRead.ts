// RFC-395 U-5: preserve the historical query windows and DTOs over immutable packages.
import type { CodeHistoryReader } from '../application/ports/historyReader'
import {
  decodeCursor,
  deriveRoundStatus,
  encodeCursor,
  ROUNDS_PER_ITEM,
  WORK_ITEM_PAGE_LIMIT,
} from '../application/codeMatrixQuery'
import type { WorkItemProjectionReadPort } from '../application/ports/workItemProjectionRead'
import { ROUND_WINDOW, roundWindow } from '../domain/stateViewScale'

export function createWorkItemProjectionRead(
  history: CodeHistoryReader,
): WorkItemProjectionReadPort {
  return {
    async readPage(input) {
      const limit = Math.max(1, Math.min(input.limit ?? WORK_ITEM_PAGE_LIMIT, 100))
      const roundLimit = Math.max(1, Math.min(input.roundLimit ?? ROUNDS_PER_ITEM, ROUND_WINDOW))
      if (limit >= 0 && !Number.isInteger(limit))
        throw new RangeError('code-history-limit-not-integer')
      const cursor = input.cursor == null ? null : decodeCursor(input.cursor)
      const [workItems, allRounds, allStages] = await Promise.all([
        history.rows('code_work_items'),
        history.rows('code_work_rounds'),
        history.rows('code_round_stages'),
      ])
      const rows = workItems
        .filter(
          (row) =>
            (input.codeHostEndpointId === undefined ||
              row.code_host_endpoint_id === input.codeHostEndpointId) &&
            (input.stableProjectId === undefined ||
              row.stable_project_id === input.stableProjectId) &&
            (input.capability === undefined || row.capability === input.capability) &&
            // The frozen query deliberately uses only the timestamp, even when ids tie.
            (cursor === null || row.created_at < cursor.createdAt),
        )
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, limit + 1)
      const page = rows.slice(0, limit)
      const items = page.map((row) => {
        if (roundLimit >= 0 && !Number.isInteger(roundLimit))
          throw new RangeError('code-history-limit-not-integer')
        const rounds = allRounds
          .filter((round) => round.work_item_id === row.id)
          .sort((a, b) => b.round_seq - a.round_seq)
        return {
          workItemId: row.id,
          capability: row.capability,
          anchorKind: row.anchor_kind,
          anchorId: row.anchor_id,
          status: row.status,
          epoch: row.epoch,
          rounds: rounds.slice(0, roundLimit).map((round) => ({
            roundId: round.id,
            roundSeq: round.round_seq,
            status: deriveRoundStatus(round.outcome, round.ended_at),
            outcome: round.outcome,
            stageContractVer: round.stage_contract_ver,
            baselineSha: round.baseline_sha,
            startedAt: round.started_at,
            endedAt: round.ended_at,
            stages: allStages
              .filter((stage) => stage.round_id === round.id)
              .sort((a, b) => a.stage_seq - b.stage_seq)
              .map((stage) => ({
                stageName: stage.stage_name,
                stageSeq: stage.stage_seq,
                kind: stage.stage_kind,
                status: stage.status,
                error: stage.error,
                startedAt: stage.started_at,
                endedAt: stage.ended_at,
              })),
          })),
          roundsHidden: roundWindow({ total: rounds.length, limit: roundLimit }).hidden,
        }
      })
      const last = page.at(-1)
      return {
        items,
        nextCursor:
          rows.length > limit && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
      }
    },
  }
}
