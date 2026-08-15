import { canonicalStoredAccess } from '../../domain/userAccessPolicy'
import type { ResolvedAuthoritySubject } from '../../public/types'
import type { CurrentSubjectAccessResolver } from '../../public/participants'
import type { IdentityAccessObserver } from '../ports/identityAccessObserver'
import type { UserAccessReadRepository } from '../ports/userAccessRepository'

export interface InvalidStoredGrantObservation {
  readonly userId: string
  readonly code: string
  readonly permission: unknown
}

export interface ResolveAuthorityDeps {
  readonly repository: UserAccessReadRepository
  readonly observer?: IdentityAccessObserver
}

export class ResolveAuthority implements CurrentSubjectAccessResolver {
  constructor(private readonly deps: ResolveAuthorityDeps) {}

  async execute(userId: string): Promise<ResolvedAuthoritySubject | null> {
    this.deps.observer?.authorityReresolution(userId)
    const snapshot = await this.deps.repository.findAccessSnapshot(userId)
    if (snapshot === null || snapshot.user.status !== 'active') return null
    const { user, grants } = snapshot
    const canonical = canonicalStoredAccess({
      role: user.role,
      storedPermissions: grants.map((grant) => grant.permission),
    })
    for (const diagnostic of canonical.diagnostics) {
      this.deps.observer?.invalidStoredGrant({
        userId,
        code: diagnostic.code,
        permission: diagnostic.permission,
      })
    }
    return {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      additionalPermissions: canonical.additionalPermissions,
      accessRevision: user.accessRevision,
    }
  }

  resolveCurrentSubject(userId: string): Promise<ResolvedAuthoritySubject | null> {
    return this.execute(userId)
  }
}
