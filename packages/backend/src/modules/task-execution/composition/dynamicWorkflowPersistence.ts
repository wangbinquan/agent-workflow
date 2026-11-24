// RFC-359 W4-B1 —— 动态工作流持久化只有一份实现；两个具名工厂只做绑定（bootstrap 收敛后一并删）。

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'
import { DrizzleDynamicWorkflowPersistence } from '../infrastructure/dynamicWorkflowPersistence'
import type { AgentExecutionQueriesFactory } from '../infrastructure/executionResourceReads'

/** RFC-568: bootstrap also hands over Resource Catalog's agent read factory. */
export function composeDynamicWorkflowPersistence(
  db: PersistenceDb,
  createAgentExecutionQueries: AgentExecutionQueriesFactory,
): DynamicWorkflowPersistence {
  return new DrizzleDynamicWorkflowPersistence(db, createAgentExecutionQueries)
}
