// RFC-349 — Resource Catalog ACL, grant and catalog reads must select a
// persistence provider at composition time.  Keep database handles out of the
// application/public contracts and reject a SQLite fallback in PostgreSQL.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const backendRoot = resolve(import.meta.dir, '..')

function source(path: string): string {
  return readFileSync(resolve(backendRoot, path), 'utf8')
}

describe('RFC-349 Resource Catalog ACL provider boundary', () => {
  test('application ports and use cases are database-mechanism free', () => {
    const applicationPaths = [
      'src/modules/resource-catalog/application/ports/providerResourceCatalogPersistence.ts',
      'src/modules/resource-catalog/application/ports/resourceAclPersistence.ts',
      'src/modules/resource-catalog/application/participants/resourceAuthorization.ts',
      'src/modules/resource-catalog/application/resourceAcl.ts',
      'src/modules/resource-catalog/application/resourceAuthorization.ts',
      'src/modules/resource-catalog/application/resourceCatalogQuery.ts',
    ]

    for (const path of applicationPaths) {
      expect(source(path)).not.toMatch(
        /@\/db|DbClient|DbTxSync|PostgresqlDatabaseClient|bun:sqlite|drizzle-orm/,
      )
    }

    const ports = source(
      'src/modules/resource-catalog/application/ports/providerResourceCatalogPersistence.ts',
    )
    expect(ports).toContain('export interface ResourceCatalogAclIdentityReadPort')
    expect(ports).toContain('getOwner(')
    expect(ports).toContain('listOwnedNames(')
    expect(ports).toContain('export interface ResourceCatalogSummaryReadPort')
  })

  test('composition selects one persistence bundle and exposes a row-free query factory', () => {
    const composition = source(
      'src/modules/resource-catalog/composition/providerResourceCatalog.ts',
    )

    expect(composition).toContain('composeProviderResourceCatalog(')
    expect(composition).toContain('composeSqliteResourceCatalog(')
    expect(composition).toContain('composePostgresqlResourceCatalog(')
    expect(composition).toContain('createQuery(input:')
    expect(composition).toContain('createResourceCatalogQueryApplication({')
    expect(composition).not.toMatch(/as\s+(?:unknown|DbClient|PostgresqlDatabaseClient)/)
  })

  test('PostgreSQL adapters use their native client and SQL dialect without fallback', () => {
    const postgresqlPaths = [
      'src/modules/resource-catalog/infrastructure/postgresqlAclReadRepository.ts',
      'src/modules/resource-catalog/infrastructure/postgresqlCatalogQuery.ts',
      'src/modules/resource-catalog/infrastructure/postgresqlResourceAclRepository.ts',
      'src/modules/resource-catalog/infrastructure/postgresqlResourceGrantRepository.ts',
    ]

    for (const path of postgresqlPaths) {
      const text = source(path)
      expect(text).toContain('PostgresqlDatabaseClient')
      expect(text).not.toMatch(
        /\bDbClient\b|\bDbTxSync\b|bun:sqlite|drizzle-orm\/sqlite-core|createSqlite|as\s+(?:unknown|DbClient|PostgresqlDatabaseClient)/,
      )
    }

    const query = source('src/modules/resource-catalog/infrastructure/postgresqlCatalogQuery.ts')
    expect(query).toContain('position(lower(')
    expect(query).not.toContain('instr(')
    expect(query).toContain("from '../application/skills/skillToken'")
    expect(query).toContain("from './mcpPersistence'")
    expect(query).toContain("from './pluginPersistence'")
    expect(query).not.toContain('@/services/intent/resourceCatalogProjections')
  })

  test('SQLite compatibility remains composition-owned over the same application ports', () => {
    const composition = source('src/modules/resource-catalog/composition/resourceAcl.ts')
    expect(composition).toContain('createResourceAclApplication<AclResourceType>({')
    expect(composition).toContain('createSqliteResourceCatalogAclSnapshotReadPort')
    expect(composition).toContain('canViewResourceInTx')
    expect(composition).toContain('updateResourceAcl')

    const sqliteQuery = source('src/modules/resource-catalog/infrastructure/sqliteCatalogQuery.ts')
    expect(sqliteQuery).toContain('createSqliteResourceCatalogSummaryReadPort')
    expect(sqliteQuery).toContain('instr(lower(')
  })
})
