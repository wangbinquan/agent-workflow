// RFC-359 W4-B1 —— 动态工作流持久化只有一份实现；两个具名工厂只做绑定（bootstrap 收敛后一并删）。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'
import { DrizzleDynamicWorkflowPersistence } from '../infrastructure/dynamicWorkflowPersistence'

export function composeDynamicWorkflowPersistence(
  db: ProviderNeutralDatabase,
): DynamicWorkflowPersistence {
  return new DrizzleDynamicWorkflowPersistence(db)
}

export const composeSqliteDynamicWorkflowPersistence = composeDynamicWorkflowPersistence
export const composePostgresqlDynamicWorkflowPersistence = composeDynamicWorkflowPersistence
