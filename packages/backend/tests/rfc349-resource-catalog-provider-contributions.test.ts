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
    // RFC-359 W8：`composeSqliteResourceCatalogOverviewQuery` 已删——它零调用方，唯一的「引用」
    // 就是这里原本的那条 `toContain` 字符串（一条守卫按名字钉着一个没人调的函数）。计数端口本来
    // 就收中立客户端，两个引擎共用；断言翻面，钉住它不许回来。判的是**声明**不是提及：
    // 源码注释里还写着它曾经在这里、为什么走了，那是退役该留的痕。
    expect(composition).not.toContain('export function composeSqliteResourceCatalogOverviewQuery')
    // RFC-359 W57：剩下那个具名入口也归了中立——`composePostgresqlResourceCatalogOverviewQuery`
    // 的 `Postgresql` 前缀与 `PostgresqlDatabaseClient` 形参标注是**命名债**不是分叉（计数端口
    // 本来就收中立客户端，函数体里一行方言都没有）；`/api/overview` 两侧收成一份时 SQLite 也要
    // 装它。两条断言都判**声明**：上一行那条原本写成裸名字，会被讲述退役经过的注释喂饱
    // （本仓已有前科，见 docs/dev-gotchas.md「覆盖度守卫按提到模块名计数」）。
    expect(composition).not.toContain(
      'export function composePostgresqlResourceCatalogOverviewQuery',
    )
    expect(composition).toContain('export function composeResourceCatalogOverviewQuery')
    expect(composition).toContain('createResourceCatalogOverviewCountPort')
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
