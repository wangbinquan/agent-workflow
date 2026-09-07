import type { AuthRuntime } from '../application/authRuntime'
import { createAuthRuntimeFor } from '../composition'
import type { ProviderNeutralDatabase } from '@/db/query'

export interface CompatibleAuthRuntimeBinding {
  readonly db: ProviderNeutralDatabase
  readonly auth?: never
}

export type CompatibleAuthRuntimeInput = ProviderNeutralDatabase | CompatibleAuthRuntimeBinding

/** Compatibility inputs all resolve to the shared Promise runtime. */
export function compatibleAuthRuntimeOf(
  input: AuthRuntime | CompatibleAuthRuntimeInput | { readonly auth: AuthRuntime },
): AuthRuntime {
  if ('lookupActiveSession' in input && 'getLoginPolicy' in input) return input
  if ('auth' in input && input.auth !== undefined) return input.auth
  return createAuthRuntimeFor({ db: 'db' in input ? input.db : input })
}
