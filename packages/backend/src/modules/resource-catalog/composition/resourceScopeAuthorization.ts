import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import {
  createResourceScopeAccessParticipant,
  type ResourceScopeAccessParticipant,
} from '../application/participants/resourceAuthorization'
import { resourceScopeAccessReads } from '../infrastructure/aggregateAdapters/resourceScopeAuthorization'

/** Bootstrap-only composition seam for memory's atomic resource-scope access port（两个 provider 同一份）。 */
export function composeResourceScopeAccessParticipant(): ResourceScopeAccessParticipant<DatabaseTransaction> {
  return createResourceScopeAccessParticipant(resourceScopeAccessReads)
}

/** 旧名保留为装配别名，PG 装配收敛后删除。 */
export const composePostgresqlResourceScopeAccessParticipant = composeResourceScopeAccessParticipant
export type PostgresqlResourceScopeAccessParticipant =
  ResourceScopeAccessParticipant<DatabaseTransaction>
