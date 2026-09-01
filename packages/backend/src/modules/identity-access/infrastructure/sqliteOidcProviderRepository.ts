import { and, eq, ne } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { authLoginPolicy, oidcProviders, userIdentities } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import type {
  InsertOidcProviderRecord,
  OidcProviderPersistenceRecord,
  OidcProviderRepository,
  OidcProviderWriteResult,
  PatchOidcProviderRecord,
} from '../application/ports/oidcProviderPersistence'

function mapRow(row: typeof oidcProviders.$inferSelect): OidcProviderPersistenceRecord {
  return { ...row }
}

function failed<T>(code: Exclude<OidcProviderWriteResult<T>, { readonly ok: true }>['code']) {
  return { ok: false as const, code }
}

function sqliteUniqueError(error: unknown): boolean {
  return /UNIQUE constraint failed:\s*oidc_providers\.slug|oidc_providers_slug_unique/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

export class SqliteOidcProviderRepository implements OidcProviderRepository {
  constructor(private readonly db: DbClient) {}

  async list(): Promise<ReadonlyArray<OidcProviderPersistenceRecord>> {
    return (await this.db.select().from(oidcProviders)).map(mapRow)
  }

  async listEnabled(): Promise<ReadonlyArray<OidcProviderPersistenceRecord>> {
    return (await this.db.select().from(oidcProviders).where(eq(oidcProviders.enabled, true))).map(
      mapRow,
    )
  }

  async findById(id: string): Promise<OidcProviderPersistenceRecord | null> {
    const row = await this.db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1)
    return row[0] === undefined ? null : mapRow(row[0])
  }

  async findBySlug(slug: string): Promise<OidcProviderPersistenceRecord | null> {
    const row = await this.db
      .select()
      .from(oidcProviders)
      .where(eq(oidcProviders.slug, slug))
      .limit(1)
    return row[0] === undefined ? null : mapRow(row[0])
  }

  async insert(
    record: InsertOidcProviderRecord,
  ): Promise<OidcProviderWriteResult<OidcProviderPersistenceRecord>> {
    try {
      return dbTxSync(this.db, (transaction) => {
        const duplicate = transaction
          .select({ id: oidcProviders.id })
          .from(oidcProviders)
          .where(eq(oidcProviders.slug, record.slug))
          .limit(1)
          .get()
        if (duplicate !== undefined) return failed('oidc-slug-taken')
        transaction.insert(oidcProviders).values(record).run()
        return { ok: true as const, value: record }
      })
    } catch (error) {
      if (sqliteUniqueError(error)) return failed('oidc-slug-taken')
      throw error
    }
  }

  async patch(input: {
    readonly id: string
    readonly updates: PatchOidcProviderRecord
    readonly subjectClaimChanges: boolean
  }): Promise<OidcProviderWriteResult<OidcProviderPersistenceRecord>> {
    try {
      return dbTxSync(this.db, (transaction) => {
        const current = transaction
          .select()
          .from(oidcProviders)
          .where(eq(oidcProviders.id, input.id))
          .get()
        if (current === undefined) return failed('oidc-provider-not-found')

        if (input.updates.slug !== undefined && input.updates.slug !== current.slug) {
          const duplicate = transaction
            .select({ id: oidcProviders.id })
            .from(oidcProviders)
            .where(eq(oidcProviders.slug, input.updates.slug))
            .limit(1)
            .get()
          if (duplicate !== undefined) return failed('oidc-slug-taken')
        }

        if (current.enabled && input.updates.enabled === false) {
          const policy = transaction
            .select({ passwordLoginEnabled: authLoginPolicy.passwordLoginEnabled })
            .from(authLoginPolicy)
            .where(eq(authLoginPolicy.id, 'global'))
            .get()
          const otherEnabled = transaction
            .select({ id: oidcProviders.id })
            .from(oidcProviders)
            .where(and(eq(oidcProviders.enabled, true), ne(oidcProviders.id, input.id)))
            .limit(1)
            .get()
          if (policy?.passwordLoginEnabled === false && otherEnabled === undefined) {
            return failed('last-enabled-oidc-required')
          }
        }

        if (input.subjectClaimChanges) {
          const linked = transaction
            .select({ id: userIdentities.id })
            .from(userIdentities)
            .where(eq(userIdentities.providerId, input.id))
            .limit(1)
            .get()
          if (linked !== undefined) return failed('subject-claim-locked-by-identities')
        }

        transaction
          .update(oidcProviders)
          .set(input.updates)
          .where(eq(oidcProviders.id, input.id))
          .run()
        return { ok: true as const, value: mapRow({ ...current, ...input.updates }) }
      })
    } catch (error) {
      if (sqliteUniqueError(error)) return failed('oidc-slug-taken')
      throw error
    }
  }

  async remove(input: {
    readonly id: string
    readonly force: boolean
  }): Promise<OidcProviderWriteResult<undefined>> {
    return dbTxSync(this.db, (transaction) => {
      const current = transaction
        .select()
        .from(oidcProviders)
        .where(eq(oidcProviders.id, input.id))
        .get()
      if (current === undefined) return failed('oidc-provider-not-found')

      if (current.enabled) {
        const policy = transaction
          .select({ passwordLoginEnabled: authLoginPolicy.passwordLoginEnabled })
          .from(authLoginPolicy)
          .where(eq(authLoginPolicy.id, 'global'))
          .get()
        const otherEnabled = transaction
          .select({ id: oidcProviders.id })
          .from(oidcProviders)
          .where(and(eq(oidcProviders.enabled, true), ne(oidcProviders.id, input.id)))
          .limit(1)
          .get()
        if (policy?.passwordLoginEnabled === false && otherEnabled === undefined) {
          return failed('last-enabled-oidc-required')
        }
      }

      const linked = transaction
        .select({ id: userIdentities.id })
        .from(userIdentities)
        .where(eq(userIdentities.providerId, input.id))
        .limit(1)
        .get()
      if (linked !== undefined && !input.force) return failed('provider-still-linked')
      if (input.force) {
        transaction.delete(userIdentities).where(eq(userIdentities.providerId, input.id)).run()
      }
      transaction.delete(oidcProviders).where(eq(oidcProviders.id, input.id)).run()
      return { ok: true as const, value: undefined }
    })
  }
}
