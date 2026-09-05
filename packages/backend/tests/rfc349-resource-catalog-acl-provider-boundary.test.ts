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

  // RFC-359 W4-D3：目录自有 ACL 类型的读 / 写端口只有一份中立实现，不再有 PG 专属文件；中立文件不得夹带 SQLite 机制。
  test('the neutral ACL adapters carry no provider mechanism', () => {
    const neutralPaths = [
      'src/modules/resource-catalog/infrastructure/aclReadRepository.ts',
      'src/modules/resource-catalog/infrastructure/resourceAclRepository.ts',
    ]

    for (const path of neutralPaths) {
      const text = source(path)
      expect(text).toContain('ProviderNeutralDatabase')
      expect(text).not.toContain('PostgresqlDatabaseClient')
      expect(text).not.toMatch(
        /\bDbClient\b|\bDbTxSync\b|bun:sqlite|drizzle-orm\/sqlite-core|createSqlite|as\s+(?:unknown|DbClient|PostgresqlDatabaseClient)/,
      )
    }

    // RFC-359 W4-B2：目录摘要查询只有一份（catalogQuery.ts）；搜索谓词用两个方言同义的 `instr(lower(…))`
    // （PostgreSQL 基线里有同名 shim），不再各写一份方言。
    const query = source('src/modules/resource-catalog/infrastructure/catalogQuery.ts')
    expect(query).toContain('instr(lower(')
    expect(query).not.toContain('position(lower(')
    expect(query).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|\bDbTxSync\b/)
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

    const sharedQuery = source('src/modules/resource-catalog/infrastructure/catalogQuery.ts')
    expect(sharedQuery).toContain('createResourceCatalogSummaryReadPort')
    expect(sharedQuery).toContain('instr(lower(')
  })
})
