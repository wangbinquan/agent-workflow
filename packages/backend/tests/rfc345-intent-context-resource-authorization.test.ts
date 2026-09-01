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

  test('both provider factories bind the session to a caller-owned transaction', () => {
    const composition = source('composition/intentContextAuthorization.ts')
    const sqlite = source('infrastructure/sqliteIntentContextResourceAuthorization.ts')
    const postgresql = source('infrastructure/postgresqlIntentContextResourceAuthorization.ts')

    expect(composition).toContain('composeSqliteIntentContextResourceAuthorizationFactory')
    expect(composition).toContain('composeSqliteIntentContextResourceAuthorizationSyncFactory')
    expect(composition).toContain('composePostgresqlIntentContextResourceAuthorizationFactory')
    expect(composition).toContain('authority !== pair.authority')
    expect(composition).toContain('foreign-intent-context-resource-authority')
    expect(sqlite).toContain('getAclResourceIdentityRowInTx(transaction')
    expect(sqlite).toContain('loadGrantLevelInTx(transaction')
    expect(sqlite).toContain('createSqliteIntentContextResourceAuthorizationSyncReadPort')
    expect(postgresql).toContain('POSTGRESQL_ACL_TABLES[resourceType]')
    expect(postgresql).toContain('resourceGrants.resourceType')
    expect(postgresql).not.toContain('runPostgresqlResourceCatalogTransaction')
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
    expect(composition).toContain('createSqliteIntentContextResourceAuthorizationSyncReadPort')
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
