import type { DbClient } from '@/db/client'
import type { ClarifyDirectiveStore } from '../application/ports/clarifyDirectiveStore'
import {
  getNodeClarifyDirectiveRow,
  listNodeClarifyDirectives,
  setNodeClarifyDirective,
} from './legacySqliteTaskClarifyDirective'

export function createSqliteClarifyDirectiveStore(db: DbClient): ClarifyDirectiveStore {
  const store: ClarifyDirectiveStore = {
    async get(input) {
      return (
        (await getNodeClarifyDirectiveRow(db, input.taskId, input.nodeId, input.shardKey)) ?? null
      )
    },
    async listNodeDirectives(taskId) {
      return Object.entries(await listNodeClarifyDirectives(db, taskId)).map(
        ([nodeId, directive]) => ({ nodeId, directive }),
      )
    },
    async set(input) {
      await setNodeClarifyDirective(
        db,
        input.taskId,
        input.nodeId,
        input.directive,
        input.setBy,
        input.shardKey,
        input.now,
      )
    },
  }
  return Object.freeze(store)
}
