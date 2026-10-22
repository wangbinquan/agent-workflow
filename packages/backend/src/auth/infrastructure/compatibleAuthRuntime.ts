import type { AuthRuntime } from '../application/authRuntime'
import { createAuthRuntimeFor } from '../composition'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export interface CompatibleAuthRuntimeBinding {
  readonly db: PersistenceDb
  readonly auth?: never
}

export type CompatibleAuthRuntimeInput = PersistenceDb | CompatibleAuthRuntimeBinding

/** Compatibility inputs all resolve to the shared Promise runtime. */
export function compatibleAuthRuntimeOf(
  input: AuthRuntime | CompatibleAuthRuntimeInput | { readonly auth: AuthRuntime },
): AuthRuntime {
  if ('lookupActiveSession' in input && 'getLoginPolicy' in input) return input
  if ('auth' in input && input.auth !== undefined) return input.auth
  return createAuthRuntimeFor({ db: 'db' in input ? input.db : input })
}
