import { and, eq, sql } from 'drizzle-orm'
import type {
  CodeHostProvider,
  OwnCodeHostPushCredentialSummary,
  RepositoryTransportMappingV1,
} from '@agent-workflow/shared'
import { RepositoryTransportMappingV1Schema } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { repositoryTransportConnections, userRepositoryTransportCredentials } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import type {
  RepositoryTransportConnectionProjectionInput,
  RepositoryTransportCredentialRepository,
  StoredPersonalRepositoryTransportCredential,
  StoredRepositoryTransportConnection,
} from '../ports/repositoryTransportCredentialRepository'

function parseStringArray(raw: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return []
  return [...new Set(value)]
}

function parseMappings(raw: string): RepositoryTransportMappingV1[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  const parsed = RepositoryTransportMappingV1Schema.array().max(32).safeParse(value)
  return parsed.success ? parsed.data : []
}

function changed(result: unknown): boolean {
  return (result as { changes?: number }).changes === 1
}

function connectionOf(
  row: typeof repositoryTransportConnections.$inferSelect,
): StoredRepositoryTransportConnection {
  return {
    provider: row.provider,
    connectionGeneration: row.connectionGeneration,
    endpointBindingDigest: row.endpointBindingDigest,
    apiBaseUrl: row.apiBaseUrl,
    rejectUnauthorized: row.rejectUnauthorized,
    transportMappings: parseMappings(row.transportMappingsJson),
    allowedHttpBaseUrls: parseStringArray(row.allowedHttpBaseUrlsJson),
    globalTokenEnc: row.globalTokenEnc,
    globalTokenHint: row.globalTokenHint,
    credentialRevision: row.credentialRevision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }
}

function personalOf(
  row: typeof userRepositoryTransportCredentials.$inferSelect,
): StoredPersonalRepositoryTransportCredential {
  return {
    userId: row.userId,
    provider: row.provider,
    credentialRef: `personal:${row.userId}:${row.provider}:${row.credentialRevision}`,
    connectionGeneration: row.connectionGeneration,
    endpointBindingDigest: row.endpointBindingDigest,
    tokenEnc: row.tokenEnc,
    tokenHint: row.tokenHint,
    credentialRevision: row.credentialRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class SQLiteRepositoryTransportCredentialRepository implements RepositoryTransportCredentialRepository {
  constructor(private readonly db: DbClient) {}

  listConnections(): readonly StoredRepositoryTransportConnection[] {
    return this.db.select().from(repositoryTransportConnections).all().map(connectionOf)
  }

  findConnection(provider: CodeHostProvider): StoredRepositoryTransportConnection | null {
    const row = this.db
      .select()
      .from(repositoryTransportConnections)
      .where(eq(repositoryTransportConnections.provider, provider))
      .get()
    return row === undefined ? null : connectionOf(row)
  }

  findPersonal(
    userId: string,
    provider: CodeHostProvider,
  ): StoredPersonalRepositoryTransportCredential | null {
    const row = this.db
      .select()
      .from(userRepositoryTransportCredentials)
      .where(
        and(
          eq(userRepositoryTransportCredentials.userId, userId),
          eq(userRepositoryTransportCredentials.provider, provider),
        ),
      )
      .get()
    return row === undefined ? null : personalOf(row)
  }

  listPersonal(userId: string): readonly StoredPersonalRepositoryTransportCredential[] {
    return this.db
      .select()
      .from(userRepositoryTransportCredentials)
      .where(eq(userRepositoryTransportCredentials.userId, userId))
      .all()
      .map(personalOf)
  }

  putPersonal(input: {
    readonly userId: string
    readonly provider: CodeHostProvider
    readonly connectionGeneration: string
    readonly endpointBindingDigest: string
    readonly tokenEnc: string
    readonly tokenHint: string
    readonly now: number
  }): StoredPersonalRepositoryTransportCredential {
    return dbTxSync(this.db, (tx) => {
      const existing = tx
        .select()
        .from(userRepositoryTransportCredentials)
        .where(
          and(
            eq(userRepositoryTransportCredentials.userId, input.userId),
            eq(userRepositoryTransportCredentials.provider, input.provider),
          ),
        )
        .get()
      const credentialRevision = (existing?.credentialRevision ?? 0) + 1
      const createdAt = existing?.createdAt ?? input.now
      tx.insert(userRepositoryTransportCredentials)
        .values({
          userId: input.userId,
          provider: input.provider,
          connectionGeneration: input.connectionGeneration,
          endpointBindingDigest: input.endpointBindingDigest,
          tokenEnc: input.tokenEnc,
          tokenHint: input.tokenHint,
          credentialRevision,
          createdAt,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [
            userRepositoryTransportCredentials.userId,
            userRepositoryTransportCredentials.provider,
          ],
          set: {
            connectionGeneration: input.connectionGeneration,
            endpointBindingDigest: input.endpointBindingDigest,
            tokenEnc: input.tokenEnc,
            tokenHint: input.tokenHint,
            credentialRevision,
            updatedAt: input.now,
          },
        })
        .run()
      const row = tx
        .select()
        .from(userRepositoryTransportCredentials)
        .where(
          and(
            eq(userRepositoryTransportCredentials.userId, input.userId),
            eq(userRepositoryTransportCredentials.provider, input.provider),
          ),
        )
        .get()
      if (row === undefined) throw new Error('personal repository credential write disappeared')
      return personalOf(row)
    })
  }

  removePersonal(userId: string, provider: CodeHostProvider): boolean {
    return changed(
      this.db
        .delete(userRepositoryTransportCredentials)
        .where(
          and(
            eq(userRepositoryTransportCredentials.userId, userId),
            eq(userRepositoryTransportCredentials.provider, provider),
          ),
        )
        .run(),
    )
  }

  personalCount(provider: CodeHostProvider): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(userRepositoryTransportCredentials)
      .where(eq(userRepositoryTransportCredentials.provider, provider))
      .get()
    return row?.count ?? 0
  }

  synchronizeConnection(input: RepositoryTransportConnectionProjectionInput): void {
    const current = this.findConnection(input.provider)
    const bindingChanged =
      current !== null &&
      (current.connectionGeneration !== input.connectionGeneration ||
        current.endpointBindingDigest !== input.endpointBindingDigest)
    if (bindingChanged) {
      this.db
        .delete(userRepositoryTransportCredentials)
        .where(eq(userRepositoryTransportCredentials.provider, input.provider))
        .run()
    }
    const credentialRevision =
      current === null
        ? 1
        : current.globalTokenEnc === input.globalTokenEnc
          ? current.credentialRevision
          : current.credentialRevision + 1
    this.db
      .insert(repositoryTransportConnections)
      .values({
        provider: input.provider,
        connectionGeneration: input.connectionGeneration,
        endpointBindingDigest: input.endpointBindingDigest,
        apiBaseUrl: input.apiBaseUrl,
        rejectUnauthorized: input.rejectUnauthorized,
        transportMappingsJson: JSON.stringify(input.transportMappings),
        allowedHttpBaseUrlsJson: JSON.stringify(input.allowedHttpBaseUrls),
        globalTokenEnc: input.globalTokenEnc,
        globalTokenHint: input.globalTokenHint,
        credentialRevision,
        updatedAt: input.updatedAt,
        updatedBy: input.updatedBy,
      })
      .onConflictDoUpdate({
        target: repositoryTransportConnections.provider,
        set: {
          connectionGeneration: input.connectionGeneration,
          endpointBindingDigest: input.endpointBindingDigest,
          apiBaseUrl: input.apiBaseUrl,
          rejectUnauthorized: input.rejectUnauthorized,
          transportMappingsJson: JSON.stringify(input.transportMappings),
          allowedHttpBaseUrlsJson: JSON.stringify(input.allowedHttpBaseUrls),
          globalTokenEnc: input.globalTokenEnc,
          globalTokenHint: input.globalTokenHint,
          credentialRevision,
          updatedAt: input.updatedAt,
          updatedBy: input.updatedBy,
        },
      })
      .run()
  }

  removeConnection(provider: CodeHostProvider): boolean {
    return changed(
      this.db
        .delete(repositoryTransportConnections)
        .where(eq(repositoryTransportConnections.provider, provider))
        .run(),
    )
  }

  ownSummary(
    connection: StoredRepositoryTransportConnection,
    personal: StoredPersonalRepositoryTransportCredential | null,
  ): OwnCodeHostPushCredentialSummary {
    return {
      provider: connection.provider,
      displayBaseUrl: connection.apiBaseUrl,
      connectionGeneration: connection.connectionGeneration,
      endpointBindingDigest: connection.endpointBindingDigest,
      configured: personal !== null,
      tokenHint: personal?.tokenHint ?? null,
      updatedAt: personal?.updatedAt ?? null,
      stale:
        personal !== null &&
        (personal.connectionGeneration !== connection.connectionGeneration ||
          personal.endpointBindingDigest !== connection.endpointBindingDigest),
      fallback: 'platform-global',
    }
  }
}
