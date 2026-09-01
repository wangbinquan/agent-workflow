import type { AuthRuntime } from '../application/authRuntime'
import { createSqliteAuthRuntime } from '../composition'
import type { DbClient } from '@/db/client'

export interface LegacySqliteAuthRuntimeBinding {
  readonly db: DbClient
  readonly auth?: never
}

export type LegacySqliteAuthRuntimeInput = DbClient | LegacySqliteAuthRuntimeBinding

/** Explicit compatibility adapter for legacy SQLite tests and bootstrap WIP. */
export function legacySqliteAuthRuntimeOf(
  input: AuthRuntime | LegacySqliteAuthRuntimeInput | { readonly auth: AuthRuntime },
): AuthRuntime {
  if ('lookupActiveSession' in input && 'getLoginPolicy' in input) return input
  if ('auth' in input && input.auth !== undefined) return input.auth
  return createSqliteAuthRuntime({ db: 'db' in input ? input.db : input })
}
