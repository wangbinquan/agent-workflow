import type { ProviderNeutralDatabase } from '@/db/query'
import type { AgentLaunchResourceIntegrityParticipant } from '@/modules/resource-catalog/public/participants'

import { createWorkgroupLaunchResourceOperations } from '../infrastructure/workgroupLaunchResourceOperations'
import type { PostgresqlWorkgroupRouteLaunchResources } from '../infrastructure/postgresqlTaskRouteLaunchOperations'

/**
 * 组合根取工作组启动资源面的**唯一入口**（与 `agentLaunchResources.ts` 同形）：
 * 根不许深挖 `infrastructure/`，也不该自己拼 ACL 读法。
 */
export function composeWorkgroupLaunchResourceOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly integrity: AgentLaunchResourceIntegrityParticipant
}): PostgresqlWorkgroupRouteLaunchResources {
  return createWorkgroupLaunchResourceOperations(input)
}
