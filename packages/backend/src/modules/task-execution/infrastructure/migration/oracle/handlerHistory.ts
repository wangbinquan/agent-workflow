import {
  NEW_CLARIFY_TRIGGER_CAUSES,
  nodeRunOrderAnchor,
  type ResolveHandlerInput,
  type HandlerRunView,
} from '@agent-workflow/shared'
import type { RunSelectionReader } from '../../../application/ports/runSelection'

/** 澄清窗口跨帧，保留缺失 anchor 的旧 NULL-seq 回退和下次 clarify cause 上界。 */
export async function resolveHandlerRunHistory(
  selection: RunSelectionReader,
  taskId: string,
  input: ResolveHandlerInput,
): Promise<HandlerRunView | null> {
  if (input.effectiveTargetNodeId === null || input.triggerRunId === null) return null
  const anchor = nodeRunOrderAnchor(input.runs, input.triggerRunId)
  const family = {
    nodeId: input.effectiveTargetNodeId,
    iteration: input.iteration,
    runIds: input.runs.filter((row) => row.loopIter === input.loopIter).map((row) => row.id),
    ...(input.shardKey === undefined ? {} : { shardKey: input.shardKey }),
  }
  const triggerCauses = new Set<string>(NEW_CLARIFY_TRIGGER_CAUSES)
  const following = await selection.familyHistory(taskId, family, { after: anchor })
  const upper = following.find(
    (row) => row.rerunCause !== null && triggerCauses.has(row.rerunCause),
  )
  const history = await selection.familyHistory(taskId, family, {
    from: anchor,
    topLevelOnly: true,
    ...(upper === undefined ? {} : { before: upper }),
  })
  const freshest = input.runs.find((row) => row.id === history.at(-1)?.id)
  return freshest === undefined
    ? null
    : { status: freshest.status, startedAt: freshest.startedAt, hasOutput: freshest.hasOutput }
}

import { createRunHistorySnapshot } from './historySnapshot'
export function resolveHandlerRun(input: ResolveHandlerInput) {
  return resolveHandlerRunHistory(createRunHistorySnapshot('', input.runs), '', input)
}
