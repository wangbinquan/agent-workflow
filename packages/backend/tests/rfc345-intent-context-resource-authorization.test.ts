import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '../src/modules/resource-catalog')
const source = (path: string): string => readFileSync(resolve(sourceRoot, path), 'utf8')

describe('RFC-345 Intent context resource authorization seam', () => {
  test('public contract is closed and carries no provider or actor shape', () => {
    const participants = source('public/participants.ts')
    const contract = participants.slice(
      participants.indexOf('export interface IntentContextResourceReference'),
      participants.indexOf('export interface McpAclIdentityParticipant'),
    )

    expect(contract).toContain('resourceType: CatalogSelectorKind')
    expect(contract).toContain('resourceId: string')
    expect(contract).toContain('expectedName?: string')
    expect(contract).toContain('Promise<IntentContextResourceIdentity | null>')
    expect(contract).not.toContain('loadVisibleSync')
    expect(contract).not.toMatch(/DbClient|DbTxSync|Postgresql|drizzle|Actor/)
  })

  // RFC-359 W4-D20：异步读端口合成一份中立实现（此前 SQLite 的那份异步工厂零生产消费）；
  // 同步变体仍留着，因为 Intent 宿主在 SQLite 上还跑在 dbTxSync 回调里。
  test('the async factory binds one neutral session to a caller-owned transaction', () => {
    const composition = source('composition/intentContextAuthorization.ts')
    const reads = source('infrastructure/intentContextResourceAuthorization.ts')

    expect(composition).toContain('composeIntentContextResourceAuthorizationFactory')
    expect(composition).toContain('composeSqliteIntentContextResourceAuthorizationSyncFactory')
    expect(composition).not.toMatch(
      /composeSqliteIntentContextResourceAuthorizationFactory\b|composePostgresqlIntentContextResourceAuthorizationFactory/,
    )
    expect(composition).toContain('authority !== pair.authority')
    expect(composition).toContain('foreign-intent-context-resource-authority')
    expect(reads).toContain('ACL_TABLES[resourceType]')
    expect(reads).toContain('resourceGrants.resourceType')
    expect(reads).toContain('getAclResourceIdentityRowInTx(transaction')
    expect(reads).toContain('loadGrantLevelInTx(transaction')
    expect(reads).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|runPostgresqlResourceCatalogTransaction/,
    )
    for (const retired of [
      'infrastructure/sqliteIntentContextResourceAuthorization.ts',
      'infrastructure/postgresqlIntentContextResourceAuthorization.ts',
    ]) {
      expect(() => source(retired), retired).toThrow()
    }
  })

  test('SQLite exposes a provider-private synchronous session for dbTxSync owners', () => {
    const participants = source('public/participants.ts')
    const application = source('application/participants/intentContextResourceAuthorization.ts')
    const ports = source('application/ports/intentContextResourceAuthorization.ts')
    const composition = source('composition/intentContextAuthorization.ts')

    expect(participants).not.toContain('IntentContextResourceAuthorizationSyncSession')
    expect(ports).toContain('IntentContextResourceAuthorizationSyncReadPort')
    expect(application).toContain('createIntentContextResourceAuthorizationSyncSession')
    expect(application).toContain('loadVisibleSync(authority, reference)')
    expect(composition).toContain('SqliteIntentContextResourceAuthorizationSyncFactory')
    expect(composition).toContain('createIntentContextResourceAuthorizationSyncReadPort')
    expect(composition).not.toMatch(/deasync|as unknown|plain Actor fallback/)
  })

  test('application revalidates expected name and visibility before returning identity', () => {
    const application = source('application/participants/intentContextResourceAuthorization.ts')

    expect(application).toContain('row.name !== reference.expectedName')
    expect(application).toContain('resourceAclAudienceAuthority(actor)')
    expect(application).toContain('reads.loadGrantLevel(')
    expect(application).toContain('if (!canViewAccess(access)) return null')
    expect(application).not.toMatch(/from ['"].*(db|infrastructure)/)
    expect(application).not.toContain('as unknown')
  })
})
