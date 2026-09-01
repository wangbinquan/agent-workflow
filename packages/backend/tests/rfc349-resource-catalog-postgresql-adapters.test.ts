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
  const aggregates = ['Mcp', 'Plugin', 'Workgroup'] as const

  test('classic aggregate PostgreSQL repositories use the shared async transaction owner', () => {
    for (const aggregate of aggregates) {
      const text = source(
        `src/modules/resource-catalog/infrastructure/postgresql${aggregate}Repository.ts`,
      )
      expect(text).toContain('PostgresqlDatabaseClient')
      expect(text).toContain('runPostgresqlResourceCatalogTransaction')
      expect(text).toContain('await ')
      expect(text).not.toMatch(/\bDbClient\b|\bdbTxSync\b|bun:sqlite|drizzle-orm\/sqlite-core/)
      expect(text).not.toMatch(/createSqlite|as PostgresqlDatabaseClient|as DbClient/)
    }
  })

  test('composition exposes exact adapter injection and PostgreSQL factories without public DB leakage', () => {
    for (const [aggregate, file] of [
      ['Mcp', 'mcpOperations'],
      ['Plugin', 'pluginOperations'],
      ['Workgroup', 'workgroupOperations'],
    ] as const) {
      const text = source(`src/modules/resource-catalog/composition/${file}.ts`)
      expect(text).toContain(`compose${aggregate}CatalogFromAdapters`)
      expect(text).toContain(`composePostgresql${aggregate}Catalog`)
      expect(text).toContain(`createPostgresql${aggregate}Repository`)
    }
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

    const sqliteReferences = source(
      'src/modules/resource-catalog/infrastructure/sqliteReferenceUsability.ts',
    )
    expect(sqliteReferences).toContain('resolveResourceIdsUsableById')
    expect(sqliteReferences).toContain('assertResourceIdsUsableInTx')
  })

  test('workflow validation inventory and D15 admission have native PostgreSQL adapters', () => {
    const composition = source('src/modules/resource-catalog/composition/workflowOperations.ts')
    const adapter = source(
      'src/modules/resource-catalog/infrastructure/postgresqlWorkflowValidation.ts',
    )

    expect(composition).toContain('createPostgresqlWorkflowValidationPort')
    expect(composition).toContain('createPostgresqlWorkflowReferenceAdmissionPort')
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
    expect(composition).toContain('createSqliteResourcePackageOwnedResourceLookup')
    expect(composition).toContain('createSqliteResourcePackageReadPort')
    expect(composition).toContain('readSqlitePackageSkillTree')
    expect(postgresqlComposition).toContain('composePostgresqlResourcePackageProvider')
    expect(postgresqlComposition).toContain('createPostgresqlResourcePackageOwnedResourceLookup')
    expect(postgresqlComposition).toContain('createPostgresqlResourcePackageReadPort')
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

    const postgresqlLookup = source(
      'src/modules/resource-catalog/infrastructure/postgresqlPackageResourceRows.ts',
    )
    expect(postgresqlLookup).toContain('PostgresqlDatabaseClient')
    expect(postgresqlLookup).toContain('ResourcePackageOwnedResourceLookupPort')
    expect(postgresqlLookup).toContain('createPostgresqlResourcePackageReadPort')
    expect(postgresqlLookup).toContain('createPostgresqlResourceGrantReadPort')
    expect(postgresqlLookup).not.toMatch(
      /\bDbClient\b|\bDbTxSync\b|bun:sqlite|drizzle-orm\/sqlite-core|createSqlite|\bas\s+(?:unknown|DbClient)/,
    )

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
    expect(testBinding).toContain('createSqliteResourcePackageReadPort')
    expect(testBinding).toContain('readSqlitePackageSkillTree')

    const route = source('src/routes/resourcePackages.ts')
    expect(route).toContain('resourceType: z.enum(BUNDLE_RESOURCE_TYPES)')
    expect(route).not.toContain('resourceType: z.string()')
  })
})
