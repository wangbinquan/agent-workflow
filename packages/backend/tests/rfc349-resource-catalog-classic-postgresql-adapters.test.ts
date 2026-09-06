import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const backendRoot = resolve(import.meta.dir, '..')

function source(path: string): string {
  return readFileSync(resolve(backendRoot, path), 'utf8')
}

describe('RFC-349 classic resource-catalog PostgreSQL adapters', () => {
  // RFC-359 W4-D14 / W4-D23c：Agent 与 Skill 聚合都已收成一份中立实现（各见下面单独的断言），
  // 经典六件套里不再有任何 postgresql* 孪生仓库，因此这里没有可循环的聚合了。

  test('agent repository and composition are one provider-neutral implementation (RFC-359 W4-D14)', () => {
    const repository = source('src/modules/resource-catalog/infrastructure/agentRepository.ts')
    const composition = source('src/modules/resource-catalog/composition/agentOperations.ts')
    expect(repository).toContain('ProviderNeutralDatabase')
    expect(repository).toContain('runResourceCatalogTransaction')
    expect(repository).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|\bdbTxSync\b|createSqlite/,
    )
    expect(composition).toContain('composeAgentCatalogFromAdapters')
    expect(composition).toContain('createAgentRepository({')
    expect(composition).toContain('export function composeAgentCatalog(')
    expect(composition).not.toMatch(/composePostgresqlAgentCatalog|createSqliteAgentRepository/)
  })

  // RFC-359 W4-D23c：技能聚合与 Agent 一样收成一份中立实现。此前 PostgreSQL 侧是 3342 行原生
  // 重写（仓库 / 内容生命周期 / ZIP 导入 / 启动装配四个文件），与 SQLite 侧那套成熟的崩溃安全机器
  // 归一化相似度只有 7%、行为覆盖 52:6 倒挂。四份原生实现整体退役，两个数据库跑同一条技能目录。
  test('skill repository and composition are one provider-neutral implementation (RFC-359 W4-D23c)', () => {
    const repository = source('src/modules/resource-catalog/infrastructure/skillRepository.ts')
    const composition = source('src/modules/resource-catalog/composition/skillOperations.ts')
    expect(repository).toContain('ProviderNeutralDatabase')
    expect(repository).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|\bdbTxSync\b|createSqlite/,
    )
    expect(composition).toContain('composeSkillCatalogFromAdapters')
    expect(composition).toContain('createSkillRepository(')
    expect(composition).toContain('export function composeSkillCatalog(')
    expect(composition).not.toMatch(/composePostgresqlSkillCatalog|createSqliteSkillRepository/)
  })

  test('one owner-native bundle supplies all PostgreSQL classic catalog semantics', () => {
    const bundle = source('src/modules/resource-catalog/composition/postgresqlClassicCatalogs.ts')
    const agent = source('src/modules/resource-catalog/infrastructure/agentPersistenceSemantics.ts')
    const workflow = source(
      'src/modules/resource-catalog/infrastructure/workflowPersistenceSemantics.ts',
    )

    expect(bundle).toContain('export function composePostgresqlClassicCatalogs(')
    expect(bundle).toContain('createAgentPersistenceSemantics({')
    // RFC-359 W4-D23c：技能这一格不再有 provider 私有的内容生命周期——bundle 装配的是中立目录，
    // 工作流校验要的「技能内容在不在」由两个数据库共用的文件系统实现回答。
    expect(bundle).toContain('createSkillContentAvailability({ appHome: input.appHome })')
    expect(bundle).not.toContain('createPostgresqlSkillContentLifecycle')
    // RFC-353 T7：回滚成员关系由 knowledge-evolution 裁定、bootstrap 注入，
    // 这里断言的是「bundle 把它原样传给技能目录」这条装配事实。
    expect(bundle).toContain('restoreMembership: input.restoreMembership')
    expect(bundle).toContain('runtimeProfiles: input.runtimeProfiles')
    expect(bundle).toContain('composeAgentCatalog({')
    expect(bundle).toContain('composeDatabaseWorkflowCatalog({')
    expect(bundle).toContain('composeSkillCatalog({')
    expect(bundle).not.toMatch(/createSqlite|as DbClient|as PostgresqlDatabaseClient/)

    expect(agent).toContain('export function createAgentPersistenceSemantics(')
    expect(agent).toContain('assertReferencesUsable({')
    expect(agent).toContain('assertDependencyGraph(')
    expect(agent).toContain('readonly runtimeProfiles: AgentRuntimeProfileLookup')
    expect(agent).not.toMatch(/\bruntimes\b/)
    expect(workflow).toContain('export function createWorkflowPersistenceSemantics(')
    expect(workflow).toContain('assertDefinitionReferences({')
  })

  test('agent visibility projection consumes AgentQueries rather than a legacy ACL facade', () => {
    const route = source('src/routes/agents.ts')
    expect(route).toContain('queries.get(authority, { id: row.id })')
    expect(route).toContain('module.listDigitalEmployeeTemplates()')
    expect(route).not.toContain('filterVisibleRows')
    expect(route).not.toContain("from '@/services/resourceAcl'")
    expect(route).not.toContain("from '@/services/digitalEmployeeAgentTemplates'")
  })

  test('skill precondition tokens have one module-owned byte-compatible codec', () => {
    const token = source('src/modules/resource-catalog/application/skills/skillToken.ts')
    expect(token).toContain('export function encodeSkillToken(')
    expect(token).toContain('export function decodeSkillToken(')
    expect(token).toContain('export function skillTokenMatches(')
    expect(token).not.toMatch(/@\/services\/skillToken|DbClient|PostgresqlDatabaseClient/)
  })
})
