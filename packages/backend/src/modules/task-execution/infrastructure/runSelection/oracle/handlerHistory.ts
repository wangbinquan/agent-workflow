import type { ResolveHandlerInput } from '@agent-workflow/shared'
import { resolveHandlerRunHistory } from '../../../application/resolveHandlerRun'
import { createRunHistorySnapshot } from './historySnapshot'

/** 已有 lineage 快照不增加数据库查询。 */
export function resolveHandlerRun(input: ResolveHandlerInput) {
  return resolveHandlerRunHistory(createRunHistorySnapshot('', input.runs), '', input)
}
