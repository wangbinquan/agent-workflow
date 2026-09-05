// RFC-232 — minimum owner identity projection for task list rows.
//
// The scheduled-task list has no pagination, so the SQL bind count must stay
// bounded independently of row count. The caller still receives one complete
// map: backend chunks are an implementation detail, never a truncated result.

import type { OwnerIdentity } from '@agent-workflow/shared'

import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import {
  OWNER_IDENTITY_SQL_BATCH_SIZE,
  type OwnerIdentityQueries,
} from '@/modules/identity-access/public/operations'

export { OWNER_IDENTITY_SQL_BATCH_SIZE }

type LegacySqliteOwnerIdentitySource = Parameters<typeof composeOwnerIdentityQueries>[0]

function isOwnerIdentityQueries(
  source: LegacySqliteOwnerIdentitySource | OwnerIdentityQueries,
): source is OwnerIdentityQueries {
  return (
    typeof source === 'object' &&
    source !== null &&
    'loadOwnerIdentities' in source &&
    typeof source.loadOwnerIdentities === 'function'
  )
}

export async function loadOwnerIdentities(
  source: LegacySqliteOwnerIdentitySource | OwnerIdentityQueries,
  ownerUserIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, OwnerIdentity>> {
  const queries = isOwnerIdentityQueries(source) ? source : composeOwnerIdentityQueries(source)
  return new Map(await queries.loadOwnerIdentities(ownerUserIds))
}
