// RFC-349 — runtime-management owns provider-selected realtime composition.

import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { DbClient } from '@/db/client'
import type { DirectAuthorityAdmission } from '@/modules/identity-access/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createRealtimeChannelAccess } from './application/realtimeChannelAccess'
import { createRealtimeCredentialAccess } from './application/realtimeCredentialAccess'
import { PostgresqlRealtimeStore } from './infrastructure/postgresqlRealtimeStore'
import { SqliteRealtimeStore } from './infrastructure/sqliteRealtimeStore'
import type { RealtimeCompositionPolicy, RealtimeRuntime } from './public/participants'

export type { RealtimeCompositionPolicy } from './public/participants'

function composeRealtimeRuntime(input: {
  readonly auth: AuthRuntime
  readonly directAuthority: DirectAuthorityAdmission
  readonly channels: ReturnType<typeof createRealtimeChannelAccess>
}): RealtimeRuntime {
  return Object.freeze({
    credentials: createRealtimeCredentialAccess(input),
    channels: input.channels,
  })
}

export function composeSqliteRealtimeRuntime(input: {
  readonly db: DbClient
  readonly auth: AuthRuntime
  readonly directAuthority: DirectAuthorityAdmission
  readonly policy: RealtimeCompositionPolicy
}): RealtimeRuntime {
  return composeRealtimeRuntime({
    auth: input.auth,
    directAuthority: input.directAuthority,
    channels: createRealtimeChannelAccess(new SqliteRealtimeStore(input.db), input.policy),
  })
}

export function composePostgresqlRealtimeRuntime(input: {
  readonly db: PostgresqlDatabaseClient
  readonly auth: AuthRuntime
  readonly directAuthority: DirectAuthorityAdmission
  readonly policy: RealtimeCompositionPolicy
}): RealtimeRuntime {
  return composeRealtimeRuntime({
    auth: input.auth,
    directAuthority: input.directAuthority,
    channels: createRealtimeChannelAccess(new PostgresqlRealtimeStore(input.db), input.policy),
  })
}
