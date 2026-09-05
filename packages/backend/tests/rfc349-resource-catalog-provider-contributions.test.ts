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
    // RFC-359 W4-B2：两份 provider 适配合成一份（pluginGenerationGc.ts），两个具名装配只做绑定。
    const shared = readFileSync(
      join(root, 'src/modules/resource-catalog/infrastructure/pluginGenerationGc.ts'),
      'utf8',
    )

    expect(publicCommands).toContain('export interface PluginGenerationGcCommand')
    expect(publicCommands).toContain("readonly executionFence: 'clear' | 'busy'")
    expect(application).toContain("command.executionFence === 'busy'")
    expect(application).toContain('listReferencedCachedPaths()')
    // RFC-359 W4-D17：具名 provider 装配也退役，只剩一份 composePluginGenerationGcCommand。
    expect(composition).toContain('composePluginGenerationGcCommand')
    expect(composition).not.toContain('PostgresqlDatabaseClient')
    expect(composition).not.toContain('DbClient')
    expect(shared).toContain('.from(plugins)')
    expect(shared).not.toContain('PostgresqlDatabaseClient')
    expect(shared).not.toContain('DbClient')
    expect(publicCommands).not.toContain('DbClient')
    expect(publicCommands).not.toContain('pluginsDir')
  })
})
