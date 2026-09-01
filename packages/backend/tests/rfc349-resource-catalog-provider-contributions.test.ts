import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

describe('RFC-349 Resource Catalog provider contributions', () => {
  test('Overview consumes one closed classic-six count model', () => {
    const publicQueries = readFileSync(
      join(root, 'src/modules/resource-catalog/public/queries.ts'),
      'utf8',
    )
    const application = readFileSync(
      join(root, 'src/modules/resource-catalog/application/resourceCatalogOverview.ts'),
      'utf8',
    )
    const composition = readFileSync(
      join(root, 'src/modules/resource-catalog/composition/resourceCatalogOverview.ts'),
      'utf8',
    )

    expect(publicQueries).toContain('export interface ResourceCatalogOverviewCounts')
    expect(publicQueries).toContain('export interface ResourceCatalogOverviewQuery')
    for (const property of ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups']) {
      expect(publicQueries).toContain(`readonly ${property}: number | null`)
    }
    expect(application).toContain('actor.permissions.has(dimension.permission)')
    expect(composition).toContain('composeSqliteResourceCatalogOverviewQuery')
    expect(composition).toContain('composePostgresqlResourceCatalogOverviewQuery')
    expect(publicQueries).not.toContain('DbClient')
    expect(publicQueries).not.toContain('PostgresqlDatabaseClient')
  })

  test('plugin generation maintenance has two real persistence adapters', () => {
    const publicCommands = readFileSync(
      join(root, 'src/modules/resource-catalog/public/commands.ts'),
      'utf8',
    )
    const application = readFileSync(
      join(root, 'src/modules/resource-catalog/application/pluginGenerationGc.ts'),
      'utf8',
    )
    const composition = readFileSync(
      join(root, 'src/modules/resource-catalog/composition/pluginGenerationGc.ts'),
      'utf8',
    )
    const sqlite = readFileSync(
      join(root, 'src/modules/resource-catalog/infrastructure/sqlitePluginGenerationGc.ts'),
      'utf8',
    )
    const postgresql = readFileSync(
      join(root, 'src/modules/resource-catalog/infrastructure/postgresqlPluginGenerationGc.ts'),
      'utf8',
    )

    expect(publicCommands).toContain('export interface PluginGenerationGcCommand')
    expect(publicCommands).toContain("readonly executionFence: 'clear' | 'busy'")
    expect(application).toContain("command.executionFence === 'busy'")
    expect(application).toContain('listReferencedCachedPaths()')
    expect(composition).toContain('composeSqlitePluginGenerationGcCommand')
    expect(composition).toContain('composePostgresqlPluginGenerationGcCommand')
    expect(sqlite).toContain('.from(plugins)')
    expect(postgresql).toContain('.from(plugins).all()')
    expect(publicCommands).not.toContain('DbClient')
    expect(publicCommands).not.toContain('pluginsDir')
  })
})
