import {
  NEW_CLARIFY_TRIGGER_CAUSES,
  type HandlerRunView,
  type ResolveHandlerInput,
  type RunLineageView,
} from '@agent-workflow/shared'
import type { LegacyRunSeq, RunSelectionReader } from '../../../application/ports/runSelection'
import { legacyNodeRunOrderAnchor } from './legacyOrder'

/** Epoch-1 lineage rows: rows minted before RFC-374 have no seq. */
export interface LegacyResolveHandlerInput extends Omit<ResolveHandlerInput, 'runs'> {
  readonly runs: readonly (Omit<RunLineageView, 'seq'> & { readonly seq: LegacyRunSeq })[]
}

/** 澄清窗口跨帧，保留缺失 anchor 的旧 NULL-seq 回退和下次 clarify cause 上界。 */
export async function resolveHandlerRunHistory(
  selection: RunSelectionReader<LegacyRunSeq>,
  taskId: string,
  input: LegacyResolveHandlerInput,
): Promise<HandlerRunView | null> {
  if (input.effectiveTargetNodeId === null || input.triggerRunId === null) return null
  const anchor = legacyNodeRunOrderAnchor(input.runs, input.triggerRunId)
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
export function resolveHandlerRun(input: LegacyResolveHandlerInput) {
  return resolveHandlerRunHistory(createRunHistorySnapshot('', input.runs), '', input)
}
