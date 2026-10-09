// RFC-359 W4-B1 —— 动态工作流持久化只有一份实现；两个具名工厂只做绑定（bootstrap 收敛后一并删）。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'
import { DrizzleDynamicWorkflowPersistence } from '../infrastructure/dynamicWorkflowPersistence'
import type { TaskHostWriteBinding } from '../infrastructure/hostExecutionWriteTransaction'
import { createSelectedDynamicWorkflowWritePurposes } from '../infrastructure/taskHostDynamicWorkflowWritePurposes'

export function composeDynamicWorkflowPersistence(
  db: ProviderNeutralDatabase,
  options: { readonly hostWrites?: TaskHostWriteBinding } = {},
): DynamicWorkflowPersistence {
  const native = new DrizzleDynamicWorkflowPersistence(db)
  if (options.hostWrites === undefined) return native
  return Object.freeze(
    Object.assign(native, {
      writeMode: 'host-selected' as const,
      writePurposes: createSelectedDynamicWorkflowWritePurposes({
        db,
        hostWrites: options.hostWrites,
      }),
    }),
  )
}
