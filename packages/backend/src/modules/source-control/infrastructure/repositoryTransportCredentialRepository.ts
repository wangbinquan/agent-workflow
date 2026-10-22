// RFC-359 W4-B6 —— 源码控制发布凭据持久化：一份实现，两个 provider 共用。
// 多语句写走统一事务原语；application / public 面只拿到 Promise 形态的封闭记录。

import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import { and, count, eq } from 'drizzle-orm'
import { RepositoryTransportMappingV1Schema } from '@agent-workflow/shared'
import type { CodeHostProvider, RepositoryTransportMappingV1 } from '@agent-workflow/shared'

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { affectedRows, databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type {
  RepositoryTransportConnectionProjectionInput,
  RepositoryTransportConnectionProjectionSource,
  RepositoryTransportConnectionMutationFence,
  RepositoryTransportCredentialRepository,
  StoredPersonalRepositoryTransportCredential,
  StoredRepositoryTransportConnection,
} from '../ports/repositoryTransportCredentialRepository'

function configuredConnectionOf(
  row: PersistenceTables['codeHostConnections']['$inferSelect'],
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
  row: PersistenceTables['repositoryTransportConnections']['$inferSelect'],
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
  row: PersistenceTables['userRepositoryTransportCredentials']['$inferSelect'],
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
  tx: PersistenceTx,
  input: RepositoryTransportConnectionProjectionInput,
): Promise<void> {
  const { repositoryTransportConnections, userRepositoryTransportCredentials } = tablesOf(tx)
  const currentRows = await tx
    .select()
    .from(repositoryTransportConnections)
    .where(eq(repositoryTransportConnections.provider, input.provider))
    .limit(1)
  const current = currentRows[0] === undefined ? null : connectionOf(currentRows[0])
  const bindingChanged =
    current !== null &&
    (current.connectionGeneration !== input.connectionGeneration ||
      current.endpointBindingDigest !== input.endpointBindingDigest)
  if (bindingChanged) {
    await tx
      .delete(userRepositoryTransportCredentials)
      .where(eq(userRepositoryTransportCredentials.provider, input.provider))
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
}

async function mutationFenceMatches(
  tx: PersistenceTx,
  provider: CodeHostProvider,
  expected: RepositoryTransportConnectionMutationFence,
): Promise<boolean> {
  const { repositoryTransportConnections, userRepositoryTransportCredentials } = tablesOf(tx)
  const [currentRows, countRows] = await Promise.all([
    queryRows(
      tx
        .select()
        .from(repositoryTransportConnections)
        .where(eq(repositoryTransportConnections.provider, provider))
        .limit(1),
    ),
    queryRows(
      tx
        .select({ count: count() })
        .from(userRepositoryTransportCredentials)
        .where(eq(userRepositoryTransportCredentials.provider, provider))
        .limit(1),
    ),
  ])
  const current = currentRows[0]
  return (
    (current?.connectionGeneration ?? null) === expected.currentConnectionGeneration &&
    (current?.endpointBindingDigest ?? null) === expected.currentEndpointBindingDigest &&
    Number(countRows[0]?.count ?? 0) === expected.personalCredentialCount
  )
}

export class DrizzleRepositoryTransportCredentialRepository implements RepositoryTransportCredentialRepository {
  constructor(private readonly db: PersistenceDb) {}

  async listConnections(): Promise<readonly StoredRepositoryTransportConnection[]> {
    const { repositoryTransportConnections } = tablesOf(this.db)
    return (await this.db.select().from(repositoryTransportConnections)).map(connectionOf)
  }

  async findConnection(
    provider: CodeHostProvider,
  ): Promise<StoredRepositoryTransportConnection | null> {
    const { repositoryTransportConnections } = tablesOf(this.db)
    const rows = await this.db
      .select()
      .from(repositoryTransportConnections)
      .where(eq(repositoryTransportConnections.provider, provider))
      .limit(1)
    return rows[0] === undefined ? null : connectionOf(rows[0])
  }

  async findPersonal(
    userId: string,
    provider: CodeHostProvider,
  ): Promise<StoredPersonalRepositoryTransportCredential | null> {
    const { userRepositoryTransportCredentials } = tablesOf(this.db)
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
    return rows[0] === undefined ? null : personalOf(rows[0])
  }

  async listPersonal(
    userId: string,
  ): Promise<readonly StoredPersonalRepositoryTransportCredential[]> {
    const { userRepositoryTransportCredentials } = tablesOf(this.db)
    return (
      await this.db
        .select()
        .from(userRepositoryTransportCredentials)
        .where(eq(userRepositoryTransportCredentials.userId, userId))
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
      const { userRepositoryTransportCredentials } = tablesOf(tx)
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
      const row = rows[0]
      if (row === undefined) throw new Error('personal repository credential write disappeared')
      return personalOf(row)
    })
  }

  async removePersonal(userId: string, provider: CodeHostProvider): Promise<boolean> {
    const { userRepositoryTransportCredentials } = tablesOf(this.db)
    const result = await this.db
      .delete(userRepositoryTransportCredentials)
      .where(
        and(
          eq(userRepositoryTransportCredentials.userId, userId),
          eq(userRepositoryTransportCredentials.provider, provider),
        ),
      )
    return affectedRows(result) === 1
  }

  async personalCount(provider: CodeHostProvider): Promise<number> {
    const { userRepositoryTransportCredentials } = tablesOf(this.db)
    const rows = await this.db
      .select({ count: count() })
      .from(userRepositoryTransportCredentials)
      .where(eq(userRepositoryTransportCredentials.provider, provider))
      .limit(1)
    return Number(rows[0]?.count ?? 0)
  }

  async listConfiguredConnections(): Promise<
    readonly RepositoryTransportConnectionProjectionSource[]
  > {
    const { codeHostConnections } = tablesOf(this.db)
    return (await this.db.select().from(codeHostConnections)).map(configuredConnectionOf)
  }

  async findConfiguredConnection(
    provider: CodeHostProvider,
  ): Promise<RepositoryTransportConnectionProjectionSource | null> {
    const { codeHostConnections } = tablesOf(this.db)
    const rows = await this.db
      .select()
      .from(codeHostConnections)
      .where(eq(codeHostConnections.provider, provider))
      .limit(1)
    return rows[0] === undefined ? null : configuredConnectionOf(rows[0])
  }

  async synchronizeConfiguredConnection(
    connection: RepositoryTransportConnectionProjectionSource,
    projection: RepositoryTransportConnectionProjectionInput,
    expected: RepositoryTransportConnectionMutationFence,
  ): Promise<boolean> {
    return await databaseSessionFor(this.db).transaction(async (tx) => {
      if (!(await mutationFenceMatches(tx, connection.provider, expected))) return false
      const { codeHostConnections } = tablesOf(tx)
      await tx
        .insert(codeHostConnections)
        .values(connection)
        .onConflictDoUpdate({ target: codeHostConnections.provider, set: connection })
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
      const { codeHostConnections, repositoryTransportConnections } = tablesOf(tx)
      const result = await tx
        .delete(codeHostConnections)
        .where(eq(codeHostConnections.provider, provider))
      await tx
        .delete(repositoryTransportConnections)
        .where(eq(repositoryTransportConnections.provider, provider))
      return affectedRows(result) === 1 ? 'removed' : 'missing'
    })
  }

  async recordConfiguredConnectionTest(
    provider: CodeHostProvider,
    lastTestJson: string,
  ): Promise<void> {
    const { codeHostConnections } = tablesOf(this.db)
    await this.db
      .update(codeHostConnections)
      .set({ lastTestJson })
      .where(eq(codeHostConnections.provider, provider))
  }

  async synchronizeConnection(input: RepositoryTransportConnectionProjectionInput): Promise<void> {
    await databaseSessionFor(this.db).transaction(
      async (tx) => await synchronizeProjection(tx, input),
    )
  }

  async removeConnection(provider: CodeHostProvider): Promise<boolean> {
    const { repositoryTransportConnections } = tablesOf(this.db)
    const result = await this.db
      .delete(repositoryTransportConnections)
      .where(eq(repositoryTransportConnections.provider, provider))
    return affectedRows(result) === 1
  }
}
