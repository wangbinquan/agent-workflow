import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const backendRoot = resolve(import.meta.dir, '..')

function source(path: string): string {
  return readFileSync(resolve(backendRoot, path), 'utf8')
}

function typescriptFiles(root: string): string[] {
  const absolute = resolve(backendRoot, root)
  return readdirSync(absolute).flatMap((entry) => {
    const path = resolve(absolute, entry)
    if (statSync(path).isDirectory()) {
      return typescriptFiles(path.slice(backendRoot.length + 1))
    }
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('RFC-349 resource-catalog PostgreSQL provider adapters', () => {
  // RFC-359 W4-D16 / D17 / D18：Mcp / Plugin / Workgroup 聚合都已是一份中立实现（见下面逐个的断言）。

  test('mcp repository and composition are one provider-neutral implementation (RFC-359 W4-D16)', () => {
    const repository = source('src/modules/resource-catalog/infrastructure/mcpRepository.ts')
    const composition = source('src/modules/resource-catalog/composition/mcpOperations.ts')
    expect(repository).toContain('ProviderNeutralDatabase')
    expect(repository).toContain('runResourceCatalogTransaction')
    expect(repository).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|\bdbTxSync\b|createSqlite/,
    )
    expect(composition).toContain('composeMcpCatalogFromAdapters')
    expect(composition).toContain('createMcpRepository({')
    expect(composition).toContain('export function composeMcpCatalog(')
    expect(composition).not.toMatch(/composePostgresqlMcpCatalog|createSqliteMcpRepository/)
  })

  test('plugin repository and composition are one provider-neutral implementation (RFC-359 W4-D17)', () => {
    const repository = source('src/modules/resource-catalog/infrastructure/pluginRepository.ts')
    const composition = source('src/modules/resource-catalog/composition/pluginOperations.ts')
    expect(repository).toContain('ProviderNeutralDatabase')
    expect(repository).toContain('runResourceCatalogTransaction')
    expect(repository).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|\bdbTxSync\b|createSqlite/,
    )
    expect(composition).toContain('composePluginCatalogFromAdapters')
    expect(composition).toContain('createPluginRepository({')
    expect(composition).toContain('export function composePluginCatalog(')
    expect(composition).not.toMatch(/composePostgresqlPluginCatalog|createSqlitePluginRepository/)
  })

  test('workgroup repository and composition are one provider-neutral implementation (RFC-359 W4-D18)', () => {
    const repository = source('src/modules/resource-catalog/infrastructure/workgroupRepository.ts')
    const composition = source('src/modules/resource-catalog/composition/workgroupOperations.ts')
    expect(repository).toContain('ProviderNeutralDatabase')
    expect(repository).toContain('runResourceCatalogTransaction')
    expect(repository).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|\bdbTxSync\b|createSqlite/,
    )
    expect(composition).toContain('composeWorkgroupCatalogFromAdapters')
    expect(composition).toContain('createWorkgroupRepository(')
    expect(composition).toContain('export function composeWorkgroupCatalog(')
    expect(composition).not.toMatch(
      /composePostgresqlWorkgroupCatalog|createSqliteWorkgroupRepository/,
    )
  })

  test('composition exposes exact adapter injection without public DB leakage', () => {
    const publicFiles = typescriptFiles('src/modules/resource-catalog/public')
    for (const file of publicFiles) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/PostgresqlDatabaseClient|DbClient|DbTxSync|drizzle-orm/)
    }
  })

  test('workgroup reference usability stays infrastructure-owned with no module-to-legacy edge', () => {
    const moduleFiles = typescriptFiles('src/modules/resource-catalog')
    const offenders = moduleFiles.filter((file) =>
      readFileSync(file, 'utf8').includes('@/services/resourceRefs'),
    )
    expect(offenders.map((file) => file.slice(backendRoot.length + 1))).toEqual([])

    // RFC-359 W4-D18：引用可用性只剩一份中立实现，预检与同事务终检都在这里。
    const references = source('src/modules/resource-catalog/infrastructure/referenceUsability.ts')
    expect(references).toContain('resolveAgentIdsUsable')
    expect(references).toContain('assertAgentIdsUsableInTransaction')
    expect(references).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|\bDbTxSync\b/)
  })

  test('workflow validation inventory and D15 admission have native PostgreSQL adapters', () => {
    const composition = source('src/modules/resource-catalog/composition/workflowOperations.ts')
    // RFC-359 W4-D15：校验与 D15 准入只有一份中立实现，两个 provider 共用。
    const adapter = source('src/modules/resource-catalog/infrastructure/workflowValidation.ts')

    expect(composition).toContain('createWorkflowValidationPort')
    expect(composition).toContain('createWorkflowReferenceAdmissionPort')
    expect(adapter).toContain('workflowClosure(')
    expect(adapter).toContain('input.skillContent.isAvailable(skill)')
    expect(adapter).toContain('input.authorization.canViewResource(')
    expect(adapter).not.toMatch(/\bDbClient\b|\bDbTxSync\b|createSqlite|bun:sqlite/)
  })

  test('resource-package staging composes over provider-owned execution and identity lookup', () => {
    const composition = source(
      'src/modules/resource-catalog/composition/resourcePackageOperations.ts',
    )
    const postgresqlComposition = source(
      'src/modules/resource-catalog/composition/postgresqlResourcePackageCatalog.ts',
    )
    expect(composition).toContain('composeResourcePackageOperationsFromAdapters')
    expect(composition).toContain('composeSqliteResourcePackageProvider')
    expect(composition).toContain('ResourcePackageExecutionAdapter')
    // RFC-359 W4-D20：资源包读模型与 owner/name 查找合成一份中立实现，两个装配都接它。
    expect(composition).toContain('createResourcePackageOwnedResourceLookup')
    expect(composition).toContain('createResourcePackageReadPort')
    expect(composition).toContain('readSqlitePackageSkillTree')
    expect(postgresqlComposition).toContain('composePostgresqlResourcePackageProvider')
    expect(postgresqlComposition).toContain('createResourcePackageOwnedResourceLookup')
    expect(postgresqlComposition).toContain('createResourcePackageReadPort')
    expect(postgresqlComposition).toContain('createPostgresqlResourcePackageMutationSessionFactory')
    expect(postgresqlComposition).toContain('readonly execution: ResourcePackageExecutionAdapter')
    expect(postgresqlComposition).toContain('execution: input.execution')
    expect(`${composition}\n${postgresqlComposition}`).not.toMatch(
      /@\/services\/(?:bundle\/legacyResourcePackageMutationDependencies|resourcePackage\/(?:commit|export|parse|preview))/,
    )

    const postgresqlMutationParticipants = source(
      'src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants.ts',
    )
    const postgresqlMutationArms = source(
      'src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
    )
    const postgresqlMutations = `${postgresqlMutationParticipants}\n${postgresqlMutationArms}`
    for (const arm of [
      'agents',
      'skills',
      'mcps',
      'plugins',
      'workflows',
      'workgroups',
      'capabilityTemplates',
    ]) {
      expect(postgresqlMutationParticipants).toContain(`readonly ${arm}:`)
    }
    for (const implementation of [
      'commitPostgresqlAgentPackageMutation',
      'commitPostgresqlSkillPackageMutation',
      'commitPostgresqlMcpPackageMutation',
      'commitPostgresqlPluginPackageMutation',
      'commitPostgresqlWorkflowPackageMutation',
      'commitPostgresqlWorkgroupPackageMutation',
    ]) {
      expect(postgresqlMutationArms).toContain(`export async function ${implementation}`)
      expect(postgresqlMutationParticipants).toContain(`${implementation}({`)
    }
    for (const table of ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups']) {
      expect(postgresqlMutationArms).toContain(`.insert(${table})`)
      expect(postgresqlMutationArms).toContain(`.update(${table})`)
    }
    expect(postgresqlMutationParticipants).toContain(
      'PostgresqlCapabilityTemplatePackageMutationOwner',
    )
    expect(postgresqlMutationParticipants).toContain('prepareOwnerNative(')
    expect(postgresqlMutationParticipants).toContain('commitOwnerNativeInTransaction(')
    expect(postgresqlMutationParticipants).toContain('authority: input.context.authority')
    expect(postgresqlMutationParticipants).toContain('ownerUserId: input.context.actor.user.id')
    expect(postgresqlMutationParticipants).not.toContain(
      'PostgresqlResourcePackageMutationParticipantImplementations',
    )
    expect(postgresqlMutationParticipants).not.toContain('implementations.')
    expect(postgresqlMutations).toContain('PostgresqlResourceCatalogTransaction')
    expect(postgresqlMutationParticipants).toContain('prepareOpaque(')
    expect(postgresqlMutationParticipants).not.toMatch(/\bprepare\s*\(/)
    expect(postgresqlMutationParticipants).toContain(
      'createPostgresqlResourcePackageMutationSessionFactory',
    )
    expect(postgresqlMutationParticipants).toContain('create(request)')
    expect(postgresqlMutationParticipants).toContain(
      'input.authorityResolver.resolve(request.authority)',
    )
    expect(postgresqlMutationParticipants).toContain('actor !== request.actor')
    for (const requestField of [
      'actor,',
      'authority: request.authority',
      'humanMemberMappings: Object.freeze([...request.humanMemberMappings])',
      'secretInputs: Object.freeze([...request.secretInputs])',
      'readSkillFile: request.readSkillFile',
    ]) {
      expect(postgresqlMutationParticipants).toContain(requestField)
    }
    expect(postgresqlMutationParticipants).toContain('ids: pendingIds(mintId)')
    expect(postgresqlMutationParticipants).toContain('mintCreate(input)')
    expect(postgresqlMutationParticipants).toContain('const existing = byKey.get(key)')
    expect(postgresqlMutationParticipants).toContain(
      'if (existing !== undefined) return existing.resourceId',
    )
    expect(postgresqlMutationParticipants).toContain('bindTransaction(transaction)')
    expect(postgresqlMutationParticipants).toContain('transactionParticipants({')
    expect(postgresqlMutationParticipants).toContain('PostgresqlResourcePackageSelectedResource')
    expect(postgresqlMutationParticipants).toContain("action: 'reuse' | 'overwrite'")
    expect(postgresqlMutationParticipants).toContain('resourceType: PackageResourceKind')
    for (const reader of [
      'getById:',
      'findBuiltin:',
      'assertVisible,',
      'async assertSelected(',
      'async findActiveUsers(',
      'async findActiveUsersByIds(',
    ]) {
      expect(postgresqlMutationParticipants).toContain(reader)
    }
    expect(postgresqlMutationParticipants).toContain("eq(users.status, 'active')")
    expect(postgresqlMutationArms).toContain('findActiveUsersByIds(')
    expect(postgresqlMutationArms).toContain('assertSelected({')
    expect(postgresqlMutationArms).toContain("visibility: 'private'")
    expect(postgresqlMutationArms).toContain('createAgentPersistenceValues({')
    expect(postgresqlMutationArms).toContain('createWorkflowPersistenceValues({')
    expect(postgresqlMutations).toContain('builtin: false')
    for (const hook of [
      'planInstall(',
      'planCreate(',
      'planUpdate(',
      'compensate(',
      'rollForward(',
      'afterCommitted(',
    ]) {
      expect(postgresqlMutationParticipants).toContain(hook)
    }
    const pluginRecord = postgresqlMutationParticipants.indexOf(
      'await input.journal.recordArtifact(plan.artifact)',
    )
    const pluginInstall = postgresqlMutationParticipants.indexOf(
      'await plan.install()',
      pluginRecord,
    )
    const skillCreateRecord = postgresqlMutationParticipants.indexOf(
      'await input.journal.recordArtifact(plan.artifact)',
      pluginRecord + 1,
    )
    const skillCreateStage = postgresqlMutationParticipants.indexOf(
      'await plan.stage()',
      skillCreateRecord,
    )
    const skillUpdateRecord = postgresqlMutationParticipants.indexOf(
      'await input.journal.recordArtifact(plan.artifact)',
      skillCreateRecord + 1,
    )
    const skillUpdateStage = postgresqlMutationParticipants.indexOf(
      'await plan.stage()',
      skillUpdateRecord,
    )
    expect(pluginRecord).toBeGreaterThan(-1)
    expect(pluginRecord).toBeLessThan(pluginInstall)
    expect(skillCreateRecord).toBeLessThan(skillCreateStage)
    expect(skillUpdateRecord).toBeLessThan(skillUpdateStage)
    expect(postgresqlMutations).toContain('PostgresqlResourcePackageAtomicApplyOrchestrator')
    expect(postgresqlMutations).toContain(
      'readonly mutationSessionFactory: PostgresqlResourcePackageMutationSessionFactory',
    )
    expect(postgresqlMutations).not.toMatch(
      /@\/services\/|PostgresqlDatabaseClient|\bDbClient\b|\bDbTxSync\b|createSqlite|legacyResourcePackage|runPostgresqlResourceCatalogTransaction|as unknown|node:fs|node:path|\.transaction\(/,
    )

    // RFC-359 W4-D20：owner/name 查找与预览 / 导出读模型合成一份中立实现；SQLite 命名的那个文件只剩
    // legacy 提交路径用的同步助手。
    const lookup = source('src/modules/resource-catalog/infrastructure/packageResourceRows.ts')
    expect(lookup).toContain('ProviderNeutralDatabase')
    expect(lookup).toContain('ResourcePackageOwnedResourceLookupPort')
    expect(lookup).toContain('createResourcePackageReadPort')
    expect(lookup).toContain('createResourceGrantReadPort')
    expect(lookup).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|\bDbTxSync\b|bun:sqlite|drizzle-orm\/sqlite-core|createSqlite|\bas\s+(?:unknown|DbClient)/,
    )
    expect(() =>
      source('src/modules/resource-catalog/infrastructure/postgresqlPackageResourceRows.ts'),
    ).toThrow()

    const ports = source('src/modules/resource-catalog/application/package/ports.ts')
    expect(ports).toContain('ResourcePackageOwnedResourceLookupPort')
    expect(ports).toContain('ResourcePackageReadPort')
    expect(ports).not.toMatch(/PostgresqlDatabaseClient|DbClient|DbTxSync|drizzle-orm/)

    for (const [file, entrypoint] of [
      ['closure', 'walkExportClosureFromReadPort'],
      ['preview', 'buildPackagePreviewFromReadPort'],
      ['export', 'exportResourcePackageFromReadPort'],
    ] as const) {
      const text = source(`src/services/resourcePackage/${file}.ts`)
      expect(text).toContain(entrypoint)
      expect(text).not.toMatch(
        /@\/modules\/resource-catalog\/(?:application|composition|domain|infrastructure)\//,
      )
    }

    const legacyReadPort = source('src/services/resourcePackage/providerReadPort.ts')
    expect(legacyReadPort).toContain('ResourcePackageReadPort')
    expect(legacyReadPort).not.toMatch(
      /@\/modules\/resource-catalog\/(?:application|composition|domain|infrastructure)\//,
    )
    for (const file of ['closure', 'preview', 'export', 'providerReadPort', 'skillTree']) {
      expect(source(`src/services/resourcePackage/${file}.ts`)).not.toMatch(
        /from ['"](?:@\/db|drizzle-orm)/,
      )
    }

    const testBinding = source('tests/helpers/resourcePackageProvider.ts')
    expect(testBinding).toContain('createResourcePackageReadPort')
    expect(testBinding).toContain('readSqlitePackageSkillTree')

    const route = source('src/routes/resourcePackages.ts')
    expect(route).toContain('resourceType: z.enum(BUNDLE_RESOURCE_TYPES)')
    expect(route).not.toContain('resourceType: z.string()')
  })
})
