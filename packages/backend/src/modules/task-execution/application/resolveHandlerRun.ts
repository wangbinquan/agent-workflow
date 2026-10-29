import {
  NEW_CLARIFY_TRIGGER_CAUSES,
  type ResolveHandlerInput,
  type HandlerRunView,
} from '@agent-workflow/shared'
import { createRunHistorySnapshot, type RunHistoryReader } from './runHistory'

/** Clarify windows require a persisted sequence anchor and stop at the next trigger. */
export async function resolveHandlerRunHistory(
  selection: RunHistoryReader,
  taskId: string,
  input: ResolveHandlerInput,
): Promise<HandlerRunView | null> {
  if (input.effectiveTargetNodeId === null || input.triggerRunId === null) return null
  const anchor = input.runs.find((row) => row.id === input.triggerRunId)
  if (anchor === undefined) return null
  const family = {
    nodeId: input.effectiveTargetNodeId,
    iteration: input.iteration,
    runIds: input.runs.filter((row) => row.loopIter === input.loopIter).map((row) => row.id),
    ...(input.shardKey === undefined ? {} : { shardKey: input.shardKey }),
  }
  const triggerCauses = new Set<string>(NEW_CLARIFY_TRIGGER_CAUSES)
  const following = await selection.familyHistory(taskId, family, { after: anchor })
  const upper = following.find((row) => row.rerunCause != null && triggerCauses.has(row.rerunCause))
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

export function resolveHandlerRun(input: ResolveHandlerInput) {
  return resolveHandlerRunHistory(createRunHistorySnapshot('', input.runs), '', input)
}
