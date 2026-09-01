import type { Actor } from '@/auth/actor'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import type {
  ResourceMemoryScopeRef,
  ResourceScopeAccess,
} from '@/modules/resource-catalog/public/types'

export type MaybePromise<T> = T | Promise<T>

/** Provider-specific transaction participant hidden behind Memory composition. */
export interface MemoryResourceScopeAccessParticipant<Transaction> {
  accessOf(
    transaction: Transaction,
    pair: Readonly<{ authority: RequestAuthority; actor: Actor }>,
    scope: ResourceMemoryScopeRef,
  ): MaybePromise<ResourceScopeAccess>
}
