// RFC-370 M0 — accounts for identities asserted by an external platform.
//
// A platform subject (issuer + subject) maps to exactly one aw user. The first
// sighting creates that user through the same initial-access staging as OIDC
// self-provisioning (initial grants and audit in one transaction); identities
// are never merged by email, and an email another account already uses is not
// copied. The default role is the login policy's default for externally
// admitted identities; the deployment's administrator subjects start as
// administrators. Later role changes belong to the Users page.
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Role } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { authLoginPolicy, externalIdentities, users } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  BufferedUserAccessTransaction,
  loadUserAccessState,
  persistUserAccessOperations,
  stageInitialUserAccess,
} from './userAccessPersistence'

export interface ExternalIdentitySighting {
  readonly issuer: string
  readonly subject: string
  readonly displayName: string | null
  readonly email: string | null
  readonly administrator: boolean
  readonly now: number
}

export interface ExternalIdentityProvisioning {
  /** The linked account's id, creating the account on first sighting. */
  resolve(sighting: ExternalIdentitySighting): Promise<string>
}

/** `user:<uuid>` → `cs-<uuid>`: stable, unique per subject and a valid username. */
export function externalIdentityUsername(issuer: string, subject: string): string {
  const local = subject.slice(subject.indexOf(':') + 1).toLowerCase()
  const prefix = issuer === 'crewstation' ? 'cs' : 'ext'
  const normalized = local.replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '')
  return `${prefix}-${normalized}`.slice(0, 64)
}

export function createExternalIdentityProvisioning(input: {
  readonly db: ProviderNeutralDatabase
  readonly id?: () => string
}): ExternalIdentityProvisioning {
  const session = databaseSessionFor(input.db)
  const id = input.id ?? ulid
  const linked = async (
    handle: ProviderNeutralDatabase,
    issuer: string,
    subject: string,
  ): Promise<string | null> =>
    (
      await handle
        .select({ userId: externalIdentities.userId })
        .from(externalIdentities)
        .where(and(eq(externalIdentities.issuer, issuer), eq(externalIdentities.subject, subject)))
        .limit(1)
    )[0]?.userId ?? null

  const create = (sighting: ExternalIdentitySighting): Promise<string> =>
    session.serializable(async (tx) => {
      const existing = await linked(tx, sighting.issuer, sighting.subject)
      if (existing !== null) return existing
      const policy = (
        await tx
          .select({ defaultRole: authLoginPolicy.oidcDefaultRole })
          .from(authLoginPolicy)
          .where(eq(authLoginPolicy.id, 'global'))
          .limit(1)
      )[0]
      if (policy === undefined) throw new Error('authentication policy singleton is missing')
      const emailOwner =
        sighting.email === null
          ? undefined
          : (
              await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.email, sighting.email))
                .limit(1)
            )[0]
      const username = externalIdentityUsername(sighting.issuer, sighting.subject)
      const userId = id()
      const readSet = { usernames: [username] }
      const transaction = new BufferedUserAccessTransaction(
        readSet,
        await loadUserAccessState(tx, readSet),
      )
      const role: Role = sighting.administrator ? 'admin' : policy.defaultRole
      stageInitialUserAccess(transaction, {
        user: {
          id: userId,
          username,
          email: emailOwner === undefined ? sighting.email : null,
          displayName: sighting.displayName ?? username,
          gitName: sighting.displayName ?? '',
          passwordHash: null,
          role,
          status: 'active',
          forcePasswordChange: false,
          createdBy: null,
          createdAt: sighting.now,
        },
        audit: { id: id(), actorUserId: null, actorKind: 'system', operationId: id() },
      })
      await persistUserAccessOperations(tx, transaction.operations)
      await tx.insert(externalIdentities).values({
        id: id(),
        issuer: sighting.issuer,
        subject: sighting.subject,
        userId,
        linkedAt: sighting.now,
      })
      return userId
    })

  return Object.freeze({
    async resolve(sighting: ExternalIdentitySighting) {
      const known = await linked(input.db, sighting.issuer, sighting.subject)
      if (known !== null) return known
      try {
        return await create(sighting)
      } catch (error) {
        // Two first requests of the same user race on the unique (issuer,
        // subject) / username constraints; the loser reads the winner's link.
        const winner = await linked(input.db, sighting.issuer, sighting.subject)
        if (winner !== null) return winner
        throw error
      }
    },
  })
}
