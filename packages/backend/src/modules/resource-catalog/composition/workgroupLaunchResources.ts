// RFC-557: moved from task-execution `composition/`, next to `agentLaunchResources.ts`; the assembly root hands the
// result to Task Execution's workgroup launch resource port.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { AgentLaunchResourceIntegrityParticipant } from '../public/participants'

import { createWorkgroupLaunchResourceOperations } from '../infrastructure/workgroupLaunchResourceOperations'
import type { WorkgroupRouteLaunchResources } from '../application/adapters/task-execution-adapter'

/**
 * 组合根取工作组启动资源面的**唯一入口**（与 `agentLaunchResources.ts` 同形）：
 * 根不许深挖 `infrastructure/`，也不该自己拼 ACL 读法。
 */
export function composeWorkgroupLaunchResourceOperations(input: {
  readonly db: PersistenceDb
  readonly integrity: AgentLaunchResourceIntegrityParticipant
}): WorkgroupRouteLaunchResources {
  return createWorkgroupLaunchResourceOperations(input)
}
