// RFC-359 W4-B6 —— 源码控制发布凭据持久化：一份实现，两个 provider 共用。
// 多语句写走统一事务原语；application / public 面只拿到 Promise 形态的封闭记录。

import { and, count, eq } from 'drizzle-orm'
import { RepositoryTransportMappingV1Schema } from '@agent-workflow/shared'
import type { CodeHostProvider, RepositoryTransportMappingV1 } from '@agent-workflow/shared'

import {
  codeHostConnections,
  repositoryTransportConnections,
  userRepositoryTransportCredentials,
} from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  affectedRows,
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type {
  RepositoryTransportConnectionProjectionInput,
  RepositoryTransportConnectionProjectionSource,
  RepositoryTransportConnectionMutationFence,
  RepositoryTransportCredentialRepository,
  StoredPersonalRepositoryTransportCredential,
  StoredRepositoryTransportConnection,
} from '../ports/repositoryTransportCredentialRepository'

function configuredConnectionOf(
  row: typeof codeHostConnections.$inferSelect,
): RepositoryTransportConnectionProjectionSource {
  return {
    provider: row.provider,
    connectionGeneration: row.connectionGeneration,
    baseUrl: row.baseUrl,
    rejectUnauthorized: row.rejectUnauthorized,
    repositoryUrlPrefixesJson: row.repositoryUrlPrefixesJson,
    transportMappingsJson: row.transportMappingsJson,
    tokenEnc: row.tokenEnc,
    tokenHint: row.tokenHint,
    lastTestJson: row.lastTestJson,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }
}

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

async function synchronizeProjection(
  tx: DatabaseTransaction,
  input: RepositoryTransportConnectionProjectionInput,
): Promise<void> {
  const currentRows = await tx
    .select()
    .from(repositoryTransportConnections)
    .where(eq(repositoryTransportConnections.provider, input.provider))
    .limit(1)
    .all()
  const current = currentRows[0] === undefined ? null : connectionOf(currentRows[0])
  const bindingChanged =
    current !== null &&
    (current.connectionGeneration !== input.connectionGeneration ||
      current.endpointBindingDigest !== input.endpointBindingDigest)
  if (bindingChanged) {
    await tx
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
  await tx
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

async function mutationFenceMatches(
  tx: DatabaseTransaction,
  provider: CodeHostProvider,
  expected: RepositoryTransportConnectionMutationFence,
): Promise<boolean> {
  const [currentRows, countRows] = await Promise.all([
    tx
      .select()
      .from(repositoryTransportConnections)
      .where(eq(repositoryTransportConnections.provider, provider))
      .limit(1)
      .all(),
    tx
      .select({ count: count() })
      .from(userRepositoryTransportCredentials)
      .where(eq(userRepositoryTransportCredentials.provider, provider))
      .limit(1)
      .all(),
  ])
  const current = currentRows[0]
  return (
    (current?.connectionGeneration ?? null) === expected.currentConnectionGeneration &&
    (current?.endpointBindingDigest ?? null) === expected.currentEndpointBindingDigest &&
    Number(countRows[0]?.count ?? 0) === expected.personalCredentialCount
  )
}

export class DrizzleRepositoryTransportCredentialRepository implements RepositoryTransportCredentialRepository {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async listConnections(): Promise<readonly StoredRepositoryTransportConnection[]> {
    return (await this.db.select().from(repositoryTransportConnections).all()).map(connectionOf)
  }

  async findConnection(
    provider: CodeHostProvider,
  ): Promise<StoredRepositoryTransportConnection | null> {
    const rows = await this.db
      .select()
      .from(repositoryTransportConnections)
      .where(eq(repositoryTransportConnections.provider, provider))
      .limit(1)
      .all()
    return rows[0] === undefined ? null : connectionOf(rows[0])
  }

  async findPersonal(
    userId: string,
    provider: CodeHostProvider,
  ): Promise<StoredPersonalRepositoryTransportCredential | null> {
    const rows = await this.db
      .select()
      .from(userRepositoryTransportCredentials)
      .where(
        and(
          eq(userRepositoryTransportCredentials.userId, userId),
          eq(userRepositoryTransportCredentials.provider, provider),
        ),
      )
      .limit(1)
      .all()
    return rows[0] === undefined ? null : personalOf(rows[0])
  }

  async listPersonal(
    userId: string,
  ): Promise<readonly StoredPersonalRepositoryTransportCredential[]> {
    return (
      await this.db
        .select()
        .from(userRepositoryTransportCredentials)
        .where(eq(userRepositoryTransportCredentials.userId, userId))
        .all()
    ).map(personalOf)
  }

  async putPersonal(input: {
    readonly userId: string
    readonly provider: CodeHostProvider
    readonly connectionGeneration: string
    readonly endpointBindingDigest: string
    readonly tokenEnc: string
    readonly tokenHint: string
    readonly now: number
  }): Promise<StoredPersonalRepositoryTransportCredential> {
    return await databaseSessionFor(this.db).transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(userRepositoryTransportCredentials)
        .where(
          and(
            eq(userRepositoryTransportCredentials.userId, input.userId),
            eq(userRepositoryTransportCredentials.provider, input.provider),
          ),
        )
        .limit(1)
        .all()
      const existing = existingRows[0]
      const credentialRevision = (existing?.credentialRevision ?? 0) + 1
      const createdAt = existing?.createdAt ?? input.now
      await tx
        .insert(userRepositoryTransportCredentials)
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
      const rows = await tx
        .select()
        .from(userRepositoryTransportCredentials)
        .where(
          and(
            eq(userRepositoryTransportCredentials.userId, input.userId),
            eq(userRepositoryTransportCredentials.provider, input.provider),
          ),
        )
        .limit(1)
        .all()
      const row = rows[0]
      if (row === undefined) throw new Error('personal repository credential write disappeared')
      return personalOf(row)
    })
  }

  async removePersonal(userId: string, provider: CodeHostProvider): Promise<boolean> {
    const result = await this.db
      .delete(userRepositoryTransportCredentials)
      .where(
        and(
          eq(userRepositoryTransportCredentials.userId, userId),
          eq(userRepositoryTransportCredentials.provider, provider),
        ),
      )
      .run()
    return affectedRows(result) === 1
  }

  async personalCount(provider: CodeHostProvider): Promise<number> {
    const rows = await this.db
      .select({ count: count() })
      .from(userRepositoryTransportCredentials)
      .where(eq(userRepositoryTransportCredentials.provider, provider))
      .limit(1)
      .all()
    return Number(rows[0]?.count ?? 0)
  }

  async listConfiguredConnections(): Promise<
    readonly RepositoryTransportConnectionProjectionSource[]
  > {
    return (await this.db.select().from(codeHostConnections).all()).map(configuredConnectionOf)
  }

  async findConfiguredConnection(
    provider: CodeHostProvider,
  ): Promise<RepositoryTransportConnectionProjectionSource | null> {
    const rows = await this.db
      .select()
      .from(codeHostConnections)
      .where(eq(codeHostConnections.provider, provider))
      .limit(1)
      .all()
    return rows[0] === undefined ? null : configuredConnectionOf(rows[0])
  }

  async synchronizeConfiguredConnection(
    connection: RepositoryTransportConnectionProjectionSource,
    projection: RepositoryTransportConnectionProjectionInput,
    expected: RepositoryTransportConnectionMutationFence,
  ): Promise<boolean> {
    return await databaseSessionFor(this.db).transaction(async (tx) => {
      if (!(await mutationFenceMatches(tx, connection.provider, expected))) return false
      await tx
        .insert(codeHostConnections)
        .values(connection)
        .onConflictDoUpdate({ target: codeHostConnections.provider, set: connection })
        .run()
      await synchronizeProjection(tx, projection)
      return true
    })
  }

  async removeConfiguredConnection(
    provider: CodeHostProvider,
    expected: RepositoryTransportConnectionMutationFence,
  ): Promise<'removed' | 'missing' | 'stale'> {
    return await databaseSessionFor(this.db).transaction(async (tx) => {
      if (!(await mutationFenceMatches(tx, provider, expected))) return 'stale'
      const result = await tx
        .delete(codeHostConnections)
        .where(eq(codeHostConnections.provider, provider))
        .run()
      await tx
        .delete(repositoryTransportConnections)
        .where(eq(repositoryTransportConnections.provider, provider))
        .run()
      return affectedRows(result) === 1 ? 'removed' : 'missing'
    })
  }

  async recordConfiguredConnectionTest(
    provider: CodeHostProvider,
    lastTestJson: string,
  ): Promise<void> {
    await this.db
      .update(codeHostConnections)
      .set({ lastTestJson })
      .where(eq(codeHostConnections.provider, provider))
      .run()
  }

  async synchronizeConnection(input: RepositoryTransportConnectionProjectionInput): Promise<void> {
    await databaseSessionFor(this.db).transaction(
      async (tx) => await synchronizeProjection(tx, input),
    )
  }

  async removeConnection(provider: CodeHostProvider): Promise<boolean> {
    const result = await this.db
      .delete(repositoryTransportConnections)
      .where(eq(repositoryTransportConnections.provider, provider))
      .run()
    return affectedRows(result) === 1
  }
}
