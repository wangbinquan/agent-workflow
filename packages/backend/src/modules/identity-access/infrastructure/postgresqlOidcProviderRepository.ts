import { and, eq, ne, sql } from 'drizzle-orm'
import { authLoginPolicy, oidcProviders, userIdentities } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  InsertOidcProviderRecord,
  OidcProviderPersistenceRecord,
  OidcProviderRepository,
  OidcProviderWriteResult,
  PatchOidcProviderRecord,
} from '../application/ports/oidcProviderPersistence'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'

type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

function mapRow(row: typeof oidcProviders.$inferSelect): OidcProviderPersistenceRecord {
  return { ...row }
}

function failed<T>(code: Exclude<OidcProviderWriteResult<T>, { readonly ok: true }>['code']) {
  return { ok: false as const, code }
}

function isSlugUniqueError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as {
      readonly code?: unknown
      readonly constraint?: unknown
      readonly message?: unknown
      readonly cause?: unknown
    }
    if (
      candidate.code === '23505' &&
      (candidate.constraint === 'oidc_providers_slug_unique' ||
        /oidc_providers_slug_unique|oidc_providers.*slug/i.test(String(candidate.message ?? '')))
    ) {
      return true
    }
    current = candidate.cause
  }
  return false
}

async function serializable<T>(
  db: PostgresqlDatabaseClient,
  body: (transaction: PostgresqlTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (transaction) => {
        await transaction.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(transaction)
      })
    } catch (error) {
      if (await retryPostgresqlSerialization(attempt, error)) continue
      throw error
    }
  }
}

export class PostgresqlOidcProviderRepository implements OidcProviderRepository {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async list(): Promise<ReadonlyArray<OidcProviderPersistenceRecord>> {
    return (await this.db.select().from(oidcProviders)).map(mapRow)
  }

  async listEnabled(): Promise<ReadonlyArray<OidcProviderPersistenceRecord>> {
    return (await this.db.select().from(oidcProviders).where(eq(oidcProviders.enabled, true))).map(
      mapRow,
    )
  }

  async findById(id: string): Promise<OidcProviderPersistenceRecord | null> {
    const row = await this.db
      .select()
      .from(oidcProviders)
      .where(eq(oidcProviders.id, id))
      .limit(1)
      .get()
    return row === undefined ? null : mapRow(row)
  }

  async findBySlug(slug: string): Promise<OidcProviderPersistenceRecord | null> {
    const row = await this.db
      .select()
      .from(oidcProviders)
      .where(eq(oidcProviders.slug, slug))
      .limit(1)
      .get()
    return row === undefined ? null : mapRow(row)
  }

  async insert(
    record: InsertOidcProviderRecord,
  ): Promise<OidcProviderWriteResult<OidcProviderPersistenceRecord>> {
    try {
      return await serializable(this.db, async (transaction) => {
        const duplicate = await transaction
          .select({ id: oidcProviders.id })
          .from(oidcProviders)
          .where(eq(oidcProviders.slug, record.slug))
          .limit(1)
          .get()
        if (duplicate !== undefined) return failed('oidc-slug-taken')
        await transaction.insert(oidcProviders).values(record).run()
        return { ok: true as const, value: record }
      })
    } catch (error) {
      if (isSlugUniqueError(error)) return failed('oidc-slug-taken')
      throw error
    }
  }

  async patch(input: {
    readonly id: string
    readonly updates: PatchOidcProviderRecord
    readonly subjectClaimChanges: boolean
  }): Promise<OidcProviderWriteResult<OidcProviderPersistenceRecord>> {
    try {
      return await serializable(this.db, async (transaction) => {
        const current = await transaction
          .select()
          .from(oidcProviders)
          .where(eq(oidcProviders.id, input.id))
          .get()
        if (current === undefined) return failed('oidc-provider-not-found')

        if (input.updates.slug !== undefined && input.updates.slug !== current.slug) {
          const duplicate = await transaction
            .select({ id: oidcProviders.id })
            .from(oidcProviders)
            .where(eq(oidcProviders.slug, input.updates.slug))
            .limit(1)
            .get()
          if (duplicate !== undefined) return failed('oidc-slug-taken')
        }

        if (current.enabled && input.updates.enabled === false) {
          const policy = await transaction
            .select({ passwordLoginEnabled: authLoginPolicy.passwordLoginEnabled })
            .from(authLoginPolicy)
            .where(eq(authLoginPolicy.id, 'global'))
            .get()
          const otherEnabled = await transaction
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
          const linked = await transaction
            .select({ id: userIdentities.id })
            .from(userIdentities)
            .where(eq(userIdentities.providerId, input.id))
            .limit(1)
            .get()
          if (linked !== undefined) return failed('subject-claim-locked-by-identities')
        }

        await transaction
          .update(oidcProviders)
          .set(input.updates)
          .where(eq(oidcProviders.id, input.id))
          .run()
        return { ok: true as const, value: mapRow({ ...current, ...input.updates }) }
      })
    } catch (error) {
      if (isSlugUniqueError(error)) return failed('oidc-slug-taken')
      throw error
    }
  }

  async remove(input: {
    readonly id: string
    readonly force: boolean
  }): Promise<OidcProviderWriteResult<undefined>> {
    return await serializable(this.db, async (transaction) => {
      const current = await transaction
        .select()
        .from(oidcProviders)
        .where(eq(oidcProviders.id, input.id))
        .get()
      if (current === undefined) return failed('oidc-provider-not-found')

      if (current.enabled) {
        const policy = await transaction
          .select({ passwordLoginEnabled: authLoginPolicy.passwordLoginEnabled })
          .from(authLoginPolicy)
          .where(eq(authLoginPolicy.id, 'global'))
          .get()
        const otherEnabled = await transaction
          .select({ id: oidcProviders.id })
          .from(oidcProviders)
          .where(and(eq(oidcProviders.enabled, true), ne(oidcProviders.id, input.id)))
          .limit(1)
          .get()
        if (policy?.passwordLoginEnabled === false && otherEnabled === undefined) {
          return failed('last-enabled-oidc-required')
        }
      }

      const linked = await transaction
        .select({ id: userIdentities.id })
        .from(userIdentities)
        .where(eq(userIdentities.providerId, input.id))
        .limit(1)
        .get()
      if (linked !== undefined && !input.force) return failed('provider-still-linked')
      if (input.force) {
        await transaction
          .delete(userIdentities)
          .where(eq(userIdentities.providerId, input.id))
          .run()
      }
      await transaction.delete(oidcProviders).where(eq(oidcProviders.id, input.id)).run()
      return { ok: true as const, value: undefined }
    })
  }
}
