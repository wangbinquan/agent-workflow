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
