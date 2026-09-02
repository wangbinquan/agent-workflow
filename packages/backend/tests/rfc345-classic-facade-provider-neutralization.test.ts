import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const backendRoot = resolve(import.meta.dir, '..')

function source(path: string): string {
  return readFileSync(resolve(backendRoot, path), 'utf8')
}

function typescriptFiles(path: string): string[] {
  const absolute = resolve(backendRoot, path)
  return readdirSync(absolute).flatMap((entry) => {
    const child = resolve(absolute, entry)
    if (statSync(child).isDirectory()) return typescriptFiles(child.slice(backendRoot.length + 1))
    return child.endsWith('.ts') ? [child] : []
  })
}

const classicFacadeFiles = typescriptFiles('src/services').filter((file) => {
  const relative = file.slice(resolve(backendRoot, 'src/services').length + 1)
  return (
    /^skill[^/]*\.ts$/.test(relative) ||
    /^workflow[^/]*\.ts$/.test(relative) ||
    relative === 'workgroups.ts' ||
    relative.startsWith('workgroup/')
  )
})

describe('RFC-345 classic facade provider neutralization', () => {
  test('compatibility services contain no database mechanism or business branches', () => {
    for (const file of classicFacadeFiles) {
      const text = readFileSync(file, 'utf8')
      expect(text).toMatch(/RFC-345 (?:narrow archive-decoder )?compatibility facade/)
      expect(text).toContain('@/modules/resource-catalog/infrastructure/legacy/')
      expect(text).not.toMatch(
        /from ['"](?:@\/db\/|drizzle-orm)|\bDbClient\b|\bDbTxSync\b|\bdbTxSync\b|\.select\(|\.insert\(|\.update\(|\.delete\(/,
      )
    }
  })

  test('SQLite adapters consume owner infrastructure without crossing back through facades', () => {
    for (const path of [
      'src/modules/resource-catalog/infrastructure/sqliteSkillRepository.ts',
      'src/modules/resource-catalog/infrastructure/sqlitePackageSkillTree.ts',
      'src/modules/resource-catalog/infrastructure/sqliteWorkflowRepository.ts',
    ]) {
      const text = source(path)
      expect(text).toContain('@/modules/resource-catalog/infrastructure/legacy/')
      expect(text).not.toMatch(/@\/services\/(?:skill|workflow|workgroups|workgroup\/)/)
    }
  })

  // RFC-345 T9: bootstrap used to hand Resource Catalog its OWN row mappers back
  // through the compatibility services (server.ts / cli/start.ts imported
  // rowToAgent / rowToWorkflowDetail / rowToWorkgroup only to pass them into
  // composeIntegrationTriggerResourceBinding). The PostgreSQL twin never needed
  // them, which is the proof the SQLite adapter can read its own legacy module.
  test('integration-trigger snapshots read their own row mappers, not bootstrap-injected ones', () => {
    const adapter = source(
      'src/modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntegrationTriggerResourceSnapshots.ts',
    )
    expect(adapter).toContain("from '../legacy/agent'")
    expect(adapter).toContain("from '../legacy/workflow'")
    expect(adapter).toContain("from '../legacy/workgroups'")
    for (const mapper of ['rowToAgent', 'rowToWorkflowDetail', 'rowToWorkgroup']) {
      expect(adapter, mapper).not.toContain(`dependencies.${mapper}`)
      expect(adapter, `${mapper} declared as an injected dependency`).not.toMatch(
        new RegExp(`readonly ${mapper}:`),
      )
    }
  })

  // RFC-345 T9: the three bootstrap seams that used to borrow Resource Catalog's
  // own symbols through the compatibility services — row mappers, the dynamic
  // workflow validation context and the rename fence — are now sourced from the
  // module itself, so no composition root imports a classic facade.
  test('bootstrap composes Resource Catalog seams from the module, not from the facades', () => {
    expect(source('src/modules/resource-catalog/composition/workflowOperations.ts')).toContain(
      'export function composeSqliteDynamicWorkflowValidationContext',
    )
    expect(source('src/modules/resource-catalog/application/resourceAuthorization.ts')).toContain(
      'assertNameUnchangedForEditor,',
    )
    for (const bootstrap of [
      'src/server.ts',
      'src/cli/start.ts',
      'src/cli/postgresqlDaemonApplication.ts',
    ]) {
      expect(source(bootstrap), bootstrap).not.toMatch(
        /from '@\/services\/(?:agent|workflow|workflow\.validator|workgroups|resourceAcl)'/,
      )
    }
  })

  test('Resource Catalog does not hide legacy reference or ACL mechanics behind service imports', () => {
    const offenders = typescriptFiles('src/modules/resource-catalog').filter((file) =>
      /@\/services\/(?:resourceRefs|importRefs|resourceAcl)(?:['"]|\/)/.test(
        readFileSync(file, 'utf8'),
      ),
    )
    expect(offenders.map((file) => file.slice(backendRoot.length + 1))).toEqual([])
  })

  test('classic PostgreSQL compositions remain native and provider-selected', () => {
    for (const [aggregate, operationFile] of [
      ['Skill', 'skillOperations'],
      ['Workflow', 'workflowOperations'],
      ['Workgroup', 'workgroupOperations'],
    ] as const) {
      const composition = source(`src/modules/resource-catalog/composition/${operationFile}.ts`)
      const repository = source(
        `src/modules/resource-catalog/infrastructure/postgresql${aggregate}Repository.ts`,
      )
      expect(composition).toContain(`composePostgresql${aggregate}Catalog`)
      expect(composition).toContain(`compose${aggregate}CatalogFromAdapters`)
      expect(repository).toContain('PostgresqlDatabaseClient')
      expect(repository).not.toMatch(/\bDbClient\b|\bDbTxSync\b|\bdbTxSync\b|createSqlite/)
    }
  })
})
