// RFC-520 — the resource-package authority registry (RFC-294 S12): an authority resolves to the actor its context was issued for;
// one that was never registered is foreign and is refused. Each assembly owns its own registry.
import type { Actor } from '@/auth/actor'
import type { ResourceRequestContext } from '../../public/participants'
import type { ResourceCurrentAuthorityResolver } from './resourceAuthorization'

export function createResourceAuthorityRegistry() {
  const actorsByAuthority = new WeakMap<ResourceRequestContext, Actor>()
  const resolver: ResourceCurrentAuthorityResolver = Object.freeze({
    resolve(authority: ResourceRequestContext) {
      const actor = actorsByAuthority.get(authority)
      if (actor === undefined) throw new Error('foreign-resource-package-authority')
      return actor
    },
  })
  return Object.freeze({
    resolver,
    register(authority: ResourceRequestContext, actor: Actor): void {
      actorsByAuthority.set(authority, actor)
    },
  })
}
