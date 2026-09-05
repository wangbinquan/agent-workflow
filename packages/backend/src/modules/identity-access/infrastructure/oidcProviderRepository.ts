// RFC-359 W4-B4 —— OIDC provider 仓库：一份实现，两个 provider 共用。
// 写路径走统一原语的 `serializable`（PG：SERIALIZABLE + 序列化失败重试；SQLite：独占事务），
// slug 撞库由引擎能力矩阵归类 + 约束名核对，不再各写一套驱动错误形状。

import { and, eq, ne } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { authLoginPolicy, oidcProviders, userIdentities } from '@/db/schema'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
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

/** 是否为 `oidc_providers.slug` 的唯一约束冲突（其它唯一约束不算）。 */
function isSlugUniqueError(db: ProviderNeutralDatabase, error: unknown): boolean {
  if (engineOf(db).classifyError(error) !== 'unique-violation') return false
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as {
      readonly constraint?: unknown
      readonly message?: unknown
      readonly cause?: unknown
    }
    if (
      candidate.constraint === 'oidc_providers_slug_unique' ||
      /oidc_providers_slug_unique|oidc_providers\.slug|oidc_providers.*slug/i.test(
        String(candidate.message ?? ''),
      )
    ) {
      return true
    }
    current = candidate.cause
  }
  return false
}

export class DrizzleOidcProviderRepository implements OidcProviderRepository {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async list(): Promise<ReadonlyArray<OidcProviderPersistenceRecord>> {
    return (await this.db.select().from(oidcProviders)).map(mapRow)
  }

  async listEnabled(): Promise<ReadonlyArray<OidcProviderPersistenceRecord>> {
    return (await this.db.select().from(oidcProviders).where(eq(oidcProviders.enabled, true))).map(
      mapRow,
    )
  }

  async findById(id: string): Promise<OidcProviderPersistenceRecord | null> {
    const row = (
      await this.db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1)
    )[0]
    return row === undefined ? null : mapRow(row)
  }

  async findBySlug(slug: string): Promise<OidcProviderPersistenceRecord | null> {
    const row = (
      await this.db.select().from(oidcProviders).where(eq(oidcProviders.slug, slug)).limit(1)
    )[0]
    return row === undefined ? null : mapRow(row)
  }

  async insert(
    record: InsertOidcProviderRecord,
  ): Promise<OidcProviderWriteResult<OidcProviderPersistenceRecord>> {
    try {
      return await databaseSessionFor(this.db).serializable(async (transaction) => {
        const duplicate = (
          await transaction
            .select({ id: oidcProviders.id })
            .from(oidcProviders)
            .where(eq(oidcProviders.slug, record.slug))
            .limit(1)
        )[0]
        if (duplicate !== undefined) return failed('oidc-slug-taken')
        await transaction.insert(oidcProviders).values(record)
        return { ok: true as const, value: record }
      })
    } catch (error) {
      if (isSlugUniqueError(this.db, error)) return failed('oidc-slug-taken')
      throw error
    }
  }

  async patch(input: {
    readonly id: string
    readonly updates: PatchOidcProviderRecord
    readonly subjectClaimChanges: boolean
  }): Promise<OidcProviderWriteResult<OidcProviderPersistenceRecord>> {
    try {
      return await databaseSessionFor(this.db).serializable(async (transaction) => {
        const current = (
          await transaction
            .select()
            .from(oidcProviders)
            .where(eq(oidcProviders.id, input.id))
            .limit(1)
        )[0]
        if (current === undefined) return failed('oidc-provider-not-found')

        if (input.updates.slug !== undefined && input.updates.slug !== current.slug) {
          const duplicate = (
            await transaction
              .select({ id: oidcProviders.id })
              .from(oidcProviders)
              .where(eq(oidcProviders.slug, input.updates.slug))
              .limit(1)
          )[0]
          if (duplicate !== undefined) return failed('oidc-slug-taken')
        }

        if (current.enabled && input.updates.enabled === false) {
          const policy = (
            await transaction
              .select({ passwordLoginEnabled: authLoginPolicy.passwordLoginEnabled })
              .from(authLoginPolicy)
              .where(eq(authLoginPolicy.id, 'global'))
              .limit(1)
          )[0]
          const otherEnabled = (
            await transaction
              .select({ id: oidcProviders.id })
              .from(oidcProviders)
              .where(and(eq(oidcProviders.enabled, true), ne(oidcProviders.id, input.id)))
              .limit(1)
          )[0]
          if (policy?.passwordLoginEnabled === false && otherEnabled === undefined) {
            return failed('last-enabled-oidc-required')
          }
        }

        if (input.subjectClaimChanges) {
          const linked = (
            await transaction
              .select({ id: userIdentities.id })
              .from(userIdentities)
              .where(eq(userIdentities.providerId, input.id))
              .limit(1)
          )[0]
          if (linked !== undefined) return failed('subject-claim-locked-by-identities')
        }

        await transaction
          .update(oidcProviders)
          .set(input.updates)
          .where(eq(oidcProviders.id, input.id))
        return { ok: true as const, value: mapRow({ ...current, ...input.updates }) }
      })
    } catch (error) {
      if (isSlugUniqueError(this.db, error)) return failed('oidc-slug-taken')
      throw error
    }
  }

  async remove(input: {
    readonly id: string
    readonly force: boolean
  }): Promise<OidcProviderWriteResult<undefined>> {
    return await databaseSessionFor(this.db).serializable(async (transaction) => {
      const current = (
        await transaction
          .select()
          .from(oidcProviders)
          .where(eq(oidcProviders.id, input.id))
          .limit(1)
      )[0]
      if (current === undefined) return failed('oidc-provider-not-found')

      if (current.enabled) {
        const policy = (
          await transaction
            .select({ passwordLoginEnabled: authLoginPolicy.passwordLoginEnabled })
            .from(authLoginPolicy)
            .where(eq(authLoginPolicy.id, 'global'))
            .limit(1)
        )[0]
        const otherEnabled = (
          await transaction
            .select({ id: oidcProviders.id })
            .from(oidcProviders)
            .where(and(eq(oidcProviders.enabled, true), ne(oidcProviders.id, input.id)))
            .limit(1)
        )[0]
        if (policy?.passwordLoginEnabled === false && otherEnabled === undefined) {
          return failed('last-enabled-oidc-required')
        }
      }

      const linked = (
        await transaction
          .select({ id: userIdentities.id })
          .from(userIdentities)
          .where(eq(userIdentities.providerId, input.id))
          .limit(1)
      )[0]
      if (linked !== undefined && !input.force) return failed('provider-still-linked')
      if (input.force) {
        await transaction.delete(userIdentities).where(eq(userIdentities.providerId, input.id))
      }
      await transaction.delete(oidcProviders).where(eq(oidcProviders.id, input.id))
      return { ok: true as const, value: undefined }
    })
  }
}
