// RFC-345 — executable drift locks for canonical rosters, exact public
// contracts, production descriptor bindings, and purpose-specific participants.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ACL_RESOURCE_TYPES,
  BUNDLE_RESOURCE_TYPES,
  GRANT_RESOURCE_TYPES,
  INTENT_RESOURCE_TYPES,
  type AclResourceType,
  type BundleResourceType,
  type GrantResourceType,
  type IntentResourceType,
  type Workgroup,
} from '@agent-workflow/shared'
import {
  asPackageResourceKind,
  type AgentCatalogResource,
  type AgentPackageMutation,
  type CapabilityTemplatePackageMutation,
  type CatalogSelectorKind,
  type FrozenIntegrationTriggerResourceSnapshot,
  type FrozenTaskExecutionResourceSnapshot,
  type IntegrationTriggerResourceRequest,
  type IntentResourceChangesetReceipt,
  type McpCatalogResource,
  type McpPackageMutation,
  type PackageResourceKind,
  type PluginCatalogResource,
  type PluginPackageMutation,
  type ResourceMemoryScopeRef,
  type SkillCatalogResource,
  type SkillPackageMutation,
  type TaskExecutionResourceRequest,
  type VersionedIntentResourceChangesetPlan,
  type WorkflowPackageMutation,
  type WorkgroupPackageMutation,
} from '../src/modules/resource-catalog/public/types'
import {
  ACL_CATALOG_KINDS,
  CATALOG_SELECTOR_KINDS,
  GRANT_TARGET_KINDS,
  PACKAGE_RESOURCE_KINDS,
  asAclCatalogKind,
  asCatalogSelectorKind,
  type AclCatalogKind,
  type GrantTargetKind,
} from '../src/modules/resource-catalog/domain/resourceKinds'
import { resourceRef } from '../src/modules/resource-catalog/domain/resourceRef'
import { resourceSummaryRevisionEquals } from '../src/modules/resource-catalog/domain/resourceRevision'
import type {
  SkillFileCommands,
  SkillVersionCommands,
} from '../src/modules/resource-catalog/public/commands'
import type {
  AgentQueries,
  AgentReferenceQueries,
  McpQueries,
  PluginQueries,
  SkillFileQueries,
  SkillQueries,
  SkillVersionQueries,
  WorkflowQueries,
  WorkflowValidationQueries,
  WorkgroupQueries,
} from '../src/modules/resource-catalog/public/queries'
import type {
  IntegrationTriggerResourceSnapshotInTx,
  IntentApplyResourceParticipantInTx,
  McpAclIdentityParticipant,
  ResourcePackageApplyScenarioProvider,
  ResourcePackageApplyTx,
  ResourcePackageMutationParticipants,
  ResourceScopeAuthorizationInTx,
  SkillZipImportParticipant,
  TaskExecutionResourceSnapshotInTx,
} from '../src/modules/resource-catalog/public/participants'
import type {
  AgentCatalogModule,
  AgentOperationDescriptors,
  McpCatalogModule,
  McpOperationDescriptors,
  PluginCatalogModule,
  PluginOperationDescriptors,
  ResourcePackageCatalogModule,
  ResourcePackageOperationDescriptors,
  SkillCatalogModule,
  SkillOperationDescriptors,
  WorkflowCatalogModule,
  WorkflowOperationDescriptors,
  WorkgroupCatalogModule,
  WorkgroupOperationDescriptors,
} from '../src/modules/resource-catalog/public/operations'
import type { LegacyResourcePackageMutationParticipants } from '../src/modules/resource-catalog/infrastructure/aggregateAdapters/legacyResourcePackageMutationParticipants'

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
      ? true
      : false
    : false

function assertType<T extends true>(value: T): void {
  void value
}

assertType<Equal<AclCatalogKind, AclResourceType>>(true)
assertType<Equal<GrantTargetKind, GrantResourceType>>(true)
assertType<Equal<PackageResourceKind, BundleResourceType>>(true)
assertType<Equal<CatalogSelectorKind, IntentResourceType>>(true)
assertType<
  Equal<
    TaskExecutionResourceRequest['kind'],
    'workflow-launch' | 'agent-injection' | 'call-workflow' | 'call-workgroup'
  >
>(true)
assertType<
  Equal<
    FrozenTaskExecutionResourceSnapshot['kind'],
    'workflow-launch' | 'agent-injection' | 'call-workflow' | 'call-workgroup'
  >
>(true)
assertType<
  Equal<
    IntegrationTriggerResourceRequest['kind'],
    | 'scheduled-workflow'
    | 'scheduled-agent'
    | 'scheduled-workgroup'
    | 'webhook-workflow'
    | 'webhook-digital-employee'
  >
>(true)
assertType<
  Equal<FrozenIntegrationTriggerResourceSnapshot['kind'], IntegrationTriggerResourceRequest['kind']>
>(true)
assertType<Equal<ResourceMemoryScopeRef['kind'], 'agent' | 'workflow'>>(true)
assertType<Equal<VersionedIntentResourceChangesetPlan['kind'], CatalogSelectorKind>>(true)
assertType<Equal<IntentResourceChangesetReceipt['kind'], CatalogSelectorKind>>(true)
assertType<Equal<AgentPackageMutation['kind'], 'agent-create' | 'agent-update'>>(true)
assertType<Equal<SkillPackageMutation['kind'], 'skill-create' | 'skill-update'>>(true)
assertType<Equal<McpPackageMutation['kind'], 'mcp-create' | 'mcp-update'>>(true)
assertType<Equal<PluginPackageMutation['kind'], 'plugin-create' | 'plugin-update'>>(true)
assertType<Equal<WorkflowPackageMutation['kind'], 'workflow-create' | 'workflow-update'>>(true)
assertType<Equal<WorkgroupPackageMutation['kind'], 'workgroup-create' | 'workgroup-update'>>(true)
assertType<
  Equal<
    CapabilityTemplatePackageMutation['kind'],
    | 'capability-framework-create'
    | 'capability-framework-update'
    | 'capability-binding-create'
    | 'capability-binding-update'
    | 'capability-template-create'
    | 'capability-template-update'
  >
>(true)
assertType<
  Equal<
    keyof ResourcePackageMutationParticipants,
    'agents' | 'skills' | 'mcps' | 'plugins' | 'workflows' | 'workgroups' | 'capabilityTemplates'
  >
>(true)
assertType<
  Equal<
    Extract<keyof ResourcePackageApplyTx, string>,
    | 'currentAuthority'
    | 'agents'
    | 'skills'
    | 'mcps'
    | 'plugins'
    | 'workflows'
    | 'workgroups'
    | 'capabilityTemplates'
    | 'events'
    | 'audit'
  >
>(true)
assertType<Equal<keyof ResourcePackageApplyScenarioProvider, 'scenario' | 'participants'>>(true)
assertType<
  Equal<
    Extract<keyof ResourcePackageOperationDescriptors, string>,
    'inspect' | 'apply' | 'getPreview' | 'getReceipt' | 'exports'
  >
>(true)
assertType<Equal<Extract<keyof ResourcePackageCatalogModule, string>, 'operations'>>(true)
assertType<
  Equal<
    keyof LegacyResourcePackageMutationParticipants,
    'agents' | 'skills' | 'mcps' | 'plugins' | 'workflows' | 'workgroups' | 'capabilityTemplates'
  >
>(true)
assertType<Equal<Extract<keyof TaskExecutionResourceSnapshotInTx, string>, 'loadAuthorized'>>(true)
assertType<Equal<Extract<keyof IntentApplyResourceParticipantInTx, string>, 'authorizeAndCommit'>>(
  true,
)
assertType<Equal<Extract<keyof IntegrationTriggerResourceSnapshotInTx, string>, 'loadAuthorized'>>(
  true,
)
assertType<Equal<Extract<keyof ResourceScopeAuthorizationInTx, string>, 'accessOf'>>(true)
assertType<Equal<Extract<keyof AgentQueries, string>, 'list' | 'get'>>(true)
assertType<Equal<Extract<keyof AgentReferenceQueries, string>, 'labels'>>(true)
assertType<
  Equal<
    Extract<keyof AgentOperationDescriptors, string>,
    'getAcl' | 'updateAcl' | 'list' | 'get' | 'create' | 'update' | 'delete' | 'rename'
  >
>(true)
assertType<
  Equal<
    Extract<keyof AgentCatalogModule, string>,
    | 'queries'
    | 'referenceQueries'
    | 'dependencyQueries'
    | 'resourceIntegrityQueries'
    | 'importQueries'
    | 'operations'
  >
>(true)
assertType<Equal<Extract<keyof SkillFileCommands, string>, 'write' | 'delete'>>(true)
assertType<Equal<Extract<keyof SkillVersionCommands, string>, 'restore'>>(true)
assertType<Equal<Extract<keyof SkillQueries, string>, 'list' | 'get' | 'content'>>(true)
assertType<Equal<Extract<keyof SkillFileQueries, string>, 'list' | 'read'>>(true)
assertType<Equal<Extract<keyof SkillVersionQueries, string>, 'list' | 'diff' | 'content'>>(true)
assertType<
  Equal<
    Extract<keyof SkillOperationDescriptors, string>,
    | 'getAcl'
    | 'updateAcl'
    | 'list'
    | 'get'
    | 'create'
    | 'save'
    | 'delete'
    | 'content'
    | 'listFiles'
    | 'readFile'
    | 'writeFile'
    | 'deleteFile'
    | 'listVersions'
    | 'diffVersions'
    | 'getVersionContent'
    | 'restoreVersion'
  >
>(true)
assertType<Equal<Extract<keyof SkillZipImportParticipant, string>, 'parse' | 'commit'>>(true)
assertType<
  Equal<
    Extract<keyof SkillCatalogModule, string>,
    | 'fileCommands'
    | 'versionCommands'
    | 'queries'
    | 'fileQueries'
    | 'versionQueries'
    | 'zipImport'
    | 'operations'
  >
>(true)
assertType<Equal<Extract<keyof McpQueries, string>, 'list' | 'get'>>(true)
assertType<Equal<Extract<keyof McpAclIdentityParticipant, string>, 'load' | 'nextUpdatedAt'>>(true)
assertType<
  Equal<
    Extract<keyof McpOperationDescriptors, string>,
    'getAcl' | 'updateAcl' | 'list' | 'get' | 'create' | 'update' | 'delete' | 'rename'
  >
>(true)
assertType<
  Equal<Extract<keyof McpCatalogModule, string>, 'queries' | 'operations' | 'participants'>
>(true)
assertType<Equal<Extract<keyof PluginQueries, string>, 'list' | 'get'>>(true)
assertType<
  Equal<
    Extract<keyof PluginOperationDescriptors, string>,
    | 'getAcl'
    | 'updateAcl'
    | 'list'
    | 'get'
    | 'create'
    | 'update'
    | 'delete'
    | 'rename'
    | 'checkUpdate'
    | 'upgrade'
  >
>(true)
assertType<Equal<Extract<keyof PluginCatalogModule, string>, 'queries' | 'operations'>>(true)
assertType<Equal<Extract<keyof WorkflowQueries, string>, 'list' | 'get'>>(true)
assertType<
  Equal<Extract<keyof WorkflowValidationQueries, string>, 'validateStored' | 'validateDraft'>
>(true)
assertType<
  Equal<
    Extract<keyof WorkflowOperationDescriptors, string>,
    'getAcl' | 'updateAcl' | 'list' | 'get' | 'create' | 'copy' | 'update' | 'delete'
  >
>(true)
assertType<
  Equal<
    Extract<keyof WorkflowCatalogModule, string>,
    'queries' | 'validationQueries' | 'operations'
  >
>(true)
assertType<Equal<Extract<keyof WorkgroupQueries, string>, 'list' | 'get'>>(true)
assertType<
  Equal<
    Extract<keyof WorkgroupOperationDescriptors, string>,
    'getAcl' | 'updateAcl' | 'list' | 'get' | 'create' | 'copy' | 'update' | 'delete' | 'rename'
  >
>(true)
assertType<Equal<Extract<keyof WorkgroupCatalogModule, string>, 'queries' | 'operations'>>(true)

const agentResourceTypeProbe: AgentCatalogResource | null = null
const skillResourceTypeProbe: SkillCatalogResource | null = null
const mcpResourceTypeProbe: McpCatalogResource | null = null
const pluginResourceTypeProbe: PluginCatalogResource | null = null
const workgroupResourceTypeProbe: Workgroup | null = null
void agentResourceTypeProbe
void skillResourceTypeProbe
void mcpResourceTypeProbe
void pluginResourceTypeProbe
void workgroupResourceTypeProbe

describe('RFC-345 T1 resource-catalog contracts', () => {
  test('the 15/16/7/6 rosters are the shared canonical tuple objects', () => {
    expect(ACL_CATALOG_KINDS).toBe(ACL_RESOURCE_TYPES)
    expect(GRANT_TARGET_KINDS).toBe(GRANT_RESOURCE_TYPES)
    expect(PACKAGE_RESOURCE_KINDS).toBe(BUNDLE_RESOURCE_TYPES)
    expect(CATALOG_SELECTOR_KINDS).toBe(INTENT_RESOURCE_TYPES)

    expect(ACL_CATALOG_KINDS).toHaveLength(15)
    expect(GRANT_TARGET_KINDS).toHaveLength(16)
    expect(PACKAGE_RESOURCE_KINDS).toHaveLength(7)
    expect(CATALOG_SELECTOR_KINDS).toHaveLength(6)
    expect(GRANT_TARGET_KINDS.at(-1)).toBe('scheduled_task')
    expect(PACKAGE_RESOURCE_KINDS.at(-1)).toBe('capability_template')
    expect(CATALOG_SELECTOR_KINDS).toEqual([
      'agent',
      'skill',
      'mcp',
      'plugin',
      'workflow',
      'workgroup',
    ])
  })

  test('cross-roster conversion only happens through named narrowings', () => {
    expect(asAclCatalogKind('scheduled_task')).toBeNull()
    expect(asAclCatalogKind('employee_tool')).toBe('employee_tool')
    expect(asPackageResourceKind('capability_template')).toBe('capability_template')
    expect(asPackageResourceKind('employee_definition')).toBeNull()
    expect(asCatalogSelectorKind('workgroup')).toBe('workgroup')
    expect(asCatalogSelectorKind('capability_template')).toBeNull()
    expect(resourceRef('scheduled_task', 'schedule-1')).toEqual({
      kind: 'scheduled_task',
      id: 'schedule-1',
    })
  })

  test('summary revisions compare only the exact aggregate fence', () => {
    expect(
      resourceSummaryRevisionEquals(
        { kind: 'agent', updatedAt: 1, aclRevision: 2 },
        { kind: 'agent', updatedAt: 1, aclRevision: 2 },
      ),
    ).toBe(true)
    expect(
      resourceSummaryRevisionEquals(
        { kind: 'agent', updatedAt: 1, aclRevision: 2 },
        { kind: 'agent', updatedAt: 1, aclRevision: 3 },
      ),
    ).toBe(false)
    expect(
      resourceSummaryRevisionEquals({ kind: 'skill', token: 'v1' }, { kind: 'skill', token: 'v2' }),
    ).toBe(false)
    expect(
      resourceSummaryRevisionEquals(
        { kind: 'mcp', configHash: 'same' },
        { kind: 'plugin', configHash: 'same' },
      ),
    ).toBe(false)
    expect(
      resourceSummaryRevisionEquals(
        { kind: 'workflow', version: 4 },
        { kind: 'workflow', version: 4 },
      ),
    ).toBe(true)
    expect(
      resourceSummaryRevisionEquals(
        { kind: 'workgroup', version: 4 },
        { kind: 'workgroup', version: 5 },
      ),
    ).toBe(false)
  })

  test('public entrypoints stay data-only and cannot grow a generic loader or writer', () => {
    const publicDir = resolve(import.meta.dir, '../src/modules/resource-catalog/public')
    const allowedFiles = new Set([
      'commands.ts',
      'events.ts',
      'operations.ts',
      'participants.ts',
      'queries.ts',
      'types.ts',
    ])
    const files = readdirSync(publicDir).filter((name) => name.endsWith('.ts'))
    expect(files.every((name) => allowedFiles.has(name))).toBe(true)

    const source = files.map((name) => readFileSync(resolve(publicDir, name), 'utf8')).join('\n')
    for (const forbiddenImport of [
      "from '@/auth/actor'",
      "from '@/db/",
      "from '@/services/",
      "from 'drizzle-orm'",
      "from 'hono'",
      "from 'node:fs'",
    ]) {
      expect(source).not.toContain(forbiddenImport)
    }
    for (const forbiddenContract of [
      'ResourceService',
      'ResourceRepository<',
      'load<TSnapshot>',
      'repositoryFor(',
      'apply(kind, unknown)',
    ]) {
      expect(source).not.toContain(forbiddenContract)
    }
  })

  test('ACL policy, application owner and SQLite registry keep their layer boundaries', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(dir, entry.name)
        return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : []
      })
    const sources = walk(sourceRoot).map((path) => ({
      path,
      source: readFileSync(path, 'utf8'),
    }))

    const registryUsers = sources
      .filter(({ source }) => /\b(?:SQLITE_)?ACL_TABLES\b/.test(source))
      .map(({ path }) => path)
    expect(registryUsers.length).toBeGreaterThan(0)
    expect(
      registryUsers.every((path) => path.includes('/modules/resource-catalog/infrastructure/')),
    ).toBe(true)

    const domain = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/domain/resourceAccess.ts'),
      'utf8',
    )
    for (const forbiddenImport of [
      "from '@/auth/",
      "from '@/db/",
      "from '@/util/errors'",
      "from 'drizzle-orm'",
    ]) {
      expect(domain).not.toContain(forbiddenImport)
    }

    expect(existsSync(resolve(sourceRoot, 'services/resourceAccessPolicy.ts'))).toBe(false)
    const facade = readFileSync(resolve(sourceRoot, 'services/resourceAcl.ts'), 'utf8')
    for (const forbiddenImplementation of [
      "from 'drizzle-orm'",
      "from '@/db/schema'",
      'resourceGrants',
      '.select(',
      '.transaction(',
    ]) {
      expect(facade).not.toContain(forbiddenImplementation)
    }
    expect(facade).not.toContain('resolveLegacyResourceAclIdentityPersistence')
    expect(existsSync(resolve(sourceRoot, 'services/resourceAclIdentityPersistence.ts'))).toBe(
      false,
    )
    const digitalEmployeeCommands = readFileSync(
      resolve(sourceRoot, 'modules/digital-employee/public/commands.ts'),
      'utf8',
    )
    const integrationParticipants = readFileSync(
      resolve(sourceRoot, 'modules/integration/public/participants.ts'),
      'utf8',
    )
    expect(digitalEmployeeCommands).not.toContain(
      'createDigitalEmployeeResourceCatalogAclProviders',
    )
    expect(integrationParticipants).not.toContain(
      'createDevelopmentAdapterResourceCatalogAclProvider',
    )
    const application = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/application/resourceAcl.ts'),
      'utf8',
    )
    expect(application).not.toContain("from '@/ws/")

    const applicationInfrastructureImports = sources
      .filter(({ path }) => path.includes('/modules/resource-catalog/application/'))
      .flatMap(({ path, source }) =>
        [
          ...source.matchAll(
            /(?:\bfrom\s+|\bimport\s*\(\s*)['"]([^'"]*\/infrastructure\/[^'"]*)['"]/g,
          ),
        ].map((match) => `${path}: ${match[1]}`),
      )
    expect(applicationInfrastructureImports).toEqual([])

    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/resourceAcl.ts'),
      'utf8',
    )
    expect(composition).toContain('createResourceAuthorizationApplication(')
    expect(composition).toContain('createSqliteResourceGrantReadPort(input.db)')
    expect(composition).toContain('createResourceAclApplication<AclResourceType>({')
    expect(composition).toContain('mutation: createSqliteResourceAclMutationPort(')
    expect(composition).toContain('read: createSqliteResourceAclReadPort(')
    expect(composition).toContain('export function composeProviderResourceAclOperationApplication<')
    expect(composition).not.toContain('withSqliteResourceAclMutation')
    expect(composition).not.toContain('getAclResourceAccessRowInTx')

    const providerAclStart = composition.indexOf(
      'export function composeProviderResourceAclOperationApplication<',
    )
    const providerAclEnd = composition.indexOf(
      '/** Owner composition for the classic-six descriptor-backed ACL operations. */',
      providerAclStart,
    )
    const providerAcl = composition.slice(providerAclStart, providerAclEnd)
    expect(providerAcl).toContain('input.authorization.canViewResource')
    expect(providerAcl).toContain('input.acl.getResourceAcl')
    expect(providerAcl).not.toContain('input.db')
    expect(providerAcl).not.toContain('createSqlite')
  })

  test('Intent selector and dump share one paged actor-visible catalog owner', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const selector = readFileSync(resolve(sourceRoot, 'services/intent/resourceCatalog.ts'), 'utf8')
    const dump = readFileSync(resolve(sourceRoot, 'services/intent/dumpBuilder.ts'), 'utf8')
    const catalog = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/sqliteCatalogQuery.ts'),
      'utf8',
    )

    for (const duplicateLoader of [
      'listAgents(',
      'listSkills(',
      'listMcps(',
      'listPlugins(',
      'listWorkflows(',
      'listWorkgroups(',
      'filterVisibleRows(',
    ]) {
      expect(selector).not.toContain(duplicateLoader)
      expect(dump).not.toContain(duplicateLoader)
    }
    expect(selector).toContain('listAllVisibleResourceSummaries')
    expect(dump).toContain('listAllVisibleResourceSummaries')
    expect(selector).toContain('ResourceCatalogQuery')
    expect(dump).toContain('IntentResourceCatalogBinding')
    expect(catalog).toContain('visibleRowsCondition')
    expect(catalog).toContain('.limit(query.limit)')
    for (const kind of ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup']) {
      expect(catalog).toContain(`case '${kind}':`)
    }
    expect(catalog).toContain('nextCursor')
    expect(catalog).not.toContain("from '@/services/")
  })

  test('T4d memory scope authorization consumes the named participant through exact pairs', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const memory = readFileSync(
      resolve(sourceRoot, 'modules/memory/infrastructure/sqliteMemoryCatalog.ts'),
      'utf8',
    )
    const memoryRoute = readFileSync(resolve(sourceRoot, 'routes/memories.ts'), 'utf8')
    const overviewRoute = readFileSync(resolve(sourceRoot, 'routes/overview.ts'), 'utf8')
    const fusionRoute = readFileSync(resolve(sourceRoot, 'routes/fusions.ts'), 'utf8')
    const wsRegistry = readFileSync(resolve(sourceRoot, 'ws/registry.ts'), 'utf8')
    const realtimeAccess = readFileSync(
      resolve(sourceRoot, 'modules/runtime-management/application/realtimeChannelAccess.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/resourceAcl.ts'),
      'utf8',
    )
    expect(memory).toContain('ResourceScopeAuthorizationInTx')
    expect(memory).toContain('.accessOf(authority.authority, ref)')
    expect(memory).toContain("scope.scopeType === 'repo'")
    expect(memory).toContain("scope.scopeType === 'repo_group'")
    expect(memory).toContain("scope.scopeType === 'global'")
    for (const forbidden of [
      'agents as agentsTable',
      'workflows as workflowsTable',
      'canEditResourceInTx',
      'canViewResourceInTx',
      'filterVisibleRows',
      'loadScopeAclRow',
    ]) {
      expect(memory).not.toContain(forbidden)
    }

    expect(composition).toContain('composeResourceScopeAuthorizationBinding')
    expect(composition).toContain('authority !== pair.authority')
    expect(composition).toContain("throw new Error('foreign-resource-scope-authority')")
    expect(wsRegistry).not.toContain('modules/resource-catalog/composition/resourceAcl')
    expect(wsRegistry).toContain('channels: RealtimeChannelAccess')
    expect(wsRegistry).toContain('channelAccessOf(ctx).canViewMemory(')
    expect(wsRegistry).toContain('channelAccessOf(ctx).canViewStoredMemory(')
    expect(wsRegistry).toContain('authority: ws.data.authority')
    expect(realtimeAccess).toContain('policy.memoryVisibility.canViewMemory(')
    expect(memoryRoute).toContain('directRequestAuthority(identityAccess.directAuthority, actor)')
    expect(overviewRoute).toContain('directRequestAuthority(authorization.directAuthority, actor)')
    expect(fusionRoute).toContain('directRequestAuthority(deps.directAuthority, actor)')
    expect(fusionRoute).toContain('readonly operations: FusionOperations')
    expect(fusionRoute).not.toMatch(/\bDbClient\b|PostgresqlDatabaseClient/)

    const resolveContext = memory.indexOf('contexts.resolveCommandContext(context)')
    // RFC-352 T4 之后调用多了一个 participant 参数、被 prettier 拆成多行，
    // 因此改用「函数名 + 该次调用绑定的 authority 变量」这对锚点来定位。
    // 本断言锁的语义没变：**第二道 scope gate 必须排在 actor 刷新之后**——
    // 刷新前后各验一次，才挡得住「读完权限到写入之间权限被改」的窗口。
    const gateWith = (authorityVar: string, from: number): number => {
      let cursor = memory.indexOf('assertMemoryScopeManageableInTx(', from)
      while (cursor >= 0) {
        const call = memory.slice(cursor, cursor + 220)
        if (call.includes(authorityVar) && call.includes("'current'")) return cursor
        cursor = memory.indexOf('assertMemoryScopeManageableInTx(', cursor + 1)
      }
      return -1
    }
    const firstScopeGate = gateWith('scopeAuthority', resolveContext)
    const refreshActor = memory.indexOf(
      'const refreshedActor = currentMoveActorInTx(tx, authority)',
      firstScopeGate + 1,
    )
    const secondScopeGate = gateWith('refreshedScopeAuthority', refreshActor)
    expect(resolveContext).toBeGreaterThanOrEqual(0)
    expect(firstScopeGate).toBeGreaterThan(resolveContext)
    expect(refreshActor).toBeGreaterThan(firstScopeGate)
    expect(secondScopeGate).toBeGreaterThan(refreshActor)
  })

  test('T4b Intent apply consumes one exact authority pair and one in-tx participant', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const engine = readFileSync(
      resolve(sourceRoot, 'modules/intent/infrastructure/sqliteIntentApplyOperations.ts'),
      'utf8',
    )
    const route = readFileSync(resolve(sourceRoot, 'routes/intentSessions.ts'), 'utf8')
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/intentApply.ts'),
      'utf8',
    )
    const adapter = readFileSync(
      resolve(
        sourceRoot,
        'modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants.ts',
      ),
      'utf8',
    )
    const dependencies = readFileSync(
      resolve(sourceRoot, 'services/intent/legacyIntentApplyResourceDependencies.ts'),
      'utf8',
    )

    const prepare = engine.indexOf('await resourceSession.prepare(plan, {')
    const prestage = engine.indexOf('await resourceSession.prestage(plan, { recordArtifact })')
    const bigTransaction = engine.indexOf('const receipt = dbTxSync(db, (tx) =>')
    const participant = engine.indexOf('resourceSession.participantInTransaction(tx,')
    const authorize = engine.indexOf('resourceParticipant.authorizeAndCommit(deps.authority, plan)')
    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(prestage).toBeGreaterThan(prepare)
    expect(bigTransaction).toBeGreaterThan(prestage)
    expect(participant).toBeGreaterThan(bigTransaction)
    expect(authorize).toBeGreaterThan(participant)

    for (const legacyWriter of [
      "@/services/agent'",
      "@/services/mcp'",
      "@/services/plugin'",
      "@/services/skill'",
      "@/services/skillVersion'",
      "@/services/workflow'",
      "@/services/workgroups'",
    ]) {
      expect(engine).not.toContain(legacyWriter)
      expect(adapter).not.toContain(legacyWriter)
      expect(dependencies).not.toContain(legacyWriter)
    }
    for (const ownerInfrastructure of [
      '@/modules/resource-catalog/infrastructure/legacy/agent',
      '@/modules/resource-catalog/infrastructure/mcpPersistence',
      '@/modules/resource-catalog/infrastructure/pluginPersistence',
      '@/modules/resource-catalog/infrastructure/legacy/skill',
      '@/modules/resource-catalog/infrastructure/legacy/skillVersion',
      '@/modules/resource-catalog/infrastructure/legacy/workflow',
      '@/modules/resource-catalog/infrastructure/legacy/workgroups',
    ]) {
      expect(dependencies).toContain(ownerInfrastructure)
    }
    expect(dependencies).toContain("from '@/services/pluginInstaller'")
    expect(adapter).toContain('createIntentApplyResourceParticipantInTx({')
    expect(adapter).toContain('authority !== options.authority')
    expect(adapter).toContain("throw new Error('foreign-intent-apply-authority')")
    expect(composition).toContain('composeIntentApplyResourceBinding')
    expect(composition).toContain('createLegacyIntentApplyResourceSession')

    expect(route).toContain('export interface IntentSessionRouteDependencies')
    expect(route).not.toContain('AppDeps')
    expect(route).toContain('directRequestAuthority(deps.directAuthority, actor)')
    expect(route).toContain('const receipt = await deps.intentApply.apply({')
    expect(composition).toContain(
      'createLegacyIntentApplyResourceSession(options, dependencies, aclIdentities)',
    )
  })

  test('T4c integration triggers consume five snapshots through exact direct and delegated pairs', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const publicParticipant = readFileSync(
      resolve(sourceRoot, 'modules/digital-employee/public/participants.ts'),
      'utf8',
    )
    const digitalEmployeeAdapter = readFileSync(
      resolve(
        sourceRoot,
        'modules/digital-employee/application/adapters/integration-trigger-resource-adapter.ts',
      ),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/integrationTrigger.ts'),
      'utf8',
    )
    const adapter = readFileSync(
      resolve(
        sourceRoot,
        'modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntegrationTriggerResourceSnapshots.ts',
      ),
      'utf8',
    )
    const schedules = readFileSync(resolve(sourceRoot, 'services/scheduledTasks.ts'), 'utf8')
    const triggerValidation = readFileSync(
      resolve(sourceRoot, 'modules/integration/composition/webhookAdmission.ts'),
      'utf8',
    )
    const scheduledPersistence = readFileSync(
      resolve(sourceRoot, 'modules/integration/infrastructure/sqliteScheduledTaskPersistence.ts'),
      'utf8',
    )
    const webhookDispatch = readFileSync(
      resolve(sourceRoot, 'services/webhook/webhookDispatch.ts'),
      'utf8',
    )
    const scheduledRoute = readFileSync(resolve(sourceRoot, 'routes/scheduledTasks.ts'), 'utf8')
    const webhookRoute = readFileSync(resolve(sourceRoot, 'routes/webhookTriggers.ts'), 'utf8')

    expect(publicParticipant).toContain('DigitalEmployeeIntegrationTriggerParticipant')
    expect(publicParticipant).toContain("'digital-employee-integration-trigger-participant'")
    expect(publicParticipant).toContain('readonly archivedAt: number | null')
    expect(digitalEmployeeAdapter).toContain('trustedIntegrationTriggerParticipants')
    expect(digitalEmployeeAdapter).toContain('Object.freeze({')

    expect(composition).toContain('IntegrationTriggerResourceAuthorityPair')
    expect(composition).toContain('inTransaction(')
    expect(composition).toContain('authority: pair.authority')
    expect(composition).toContain('actor: pair.actor')
    expect(composition).toContain('createIntegrationTriggerResourceSnapshotInTx(')
    for (const variant of [
      'scheduledWorkflow(authority, request)',
      'scheduledAgent(authority, request)',
      'scheduledWorkgroup(authority, request)',
      'webhookWorkflow(authority, request)',
      'webhookDigitalEmployee(authority, request)',
    ]) {
      expect(adapter).toContain(variant)
    }
    for (const legacyImport of [
      '@/services/',
      '@/modules/digital-employee/public/',
      '@/modules/digital-employee/infrastructure/',
    ]) {
      expect(adapter).not.toContain(legacyImport)
    }

    const employeeIdentity = adapter.indexOf(
      'options.digitalEmployees.loadIdentity(request.employeeDefinitionId)',
    )
    const employeeAcl = adapter.indexOf(
      "canViewResourceInTx(options.tx, actor, 'digital_employee'",
      employeeIdentity,
    )
    const employeeContent = adapter.indexOf(
      'options.digitalEmployees.loadCurrentSnapshot(request.employeeDefinitionId)',
      employeeAcl,
    )
    expect(employeeIdentity).toBeGreaterThanOrEqual(0)
    expect(employeeAcl).toBeGreaterThan(employeeIdentity)
    expect(employeeContent).toBeGreaterThan(employeeAcl)

    expect(schedules).toContain("kind: 'scheduled-workflow'")
    expect(schedules).toContain("kind: 'scheduled-agent'")
    expect(schedules).toContain("kind: 'scheduled-workgroup'")
    expect(schedules).toContain('identityAccess.delegatedRequests.forSchedule({')
    expect(webhookDispatch).toContain('deps.identityAccess.delegatedRequests.forWebhook({')
    expect(webhookDispatch).toContain('deps.resolveEventTargetAuthority(input.ownerUserId)')
    expect(webhookDispatch).not.toContain('buildActor({')
    expect(triggerValidation).toContain("kind: 'webhook-workflow'")
    expect(triggerValidation).toContain("kind: 'webhook-digital-employee'")
    expect(scheduledPersistence).toContain("from '@/modules/resource-catalog/public/participants'")
    expect(scheduledPersistence).toContain('IntegrationTriggerResourceSnapshotInTx')
    expect(scheduledPersistence).toContain('.inTransaction(tx, input.authority)')
    expect(scheduledPersistence).toContain(
      '.loadAuthorized(input.authority.authority, [input.request])',
    )

    for (const route of [scheduledRoute, webhookRoute]) {
      expect(route).toContain('directRequestAuthority(')
      expect(route).toContain('integrationTriggerResources')
    }
    expect(composition).toContain('digitalEmployees: digitalEmployeesInTx(tx)')
  })

  test('T4a task execution consumes one authority-bound snapshot session without legacy reads', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const publicParticipants = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/participants.ts'),
      'utf8',
    )
    const publicTypes = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/types.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/taskExecution.ts'),
      'utf8',
    )
    const adapter = readFileSync(
      resolve(
        sourceRoot,
        'modules/resource-catalog/infrastructure/aggregateAdapters/legacyTaskExecutionResourceSnapshots.ts',
      ),
      'utf8',
    )
    const dependencies = readFileSync(
      resolve(sourceRoot, 'services/execution/legacyTaskExecutionResourceDependencies.ts'),
      'utf8',
    )
    const resources = readFileSync(
      resolve(sourceRoot, 'services/execution/taskExecutionResources.ts'),
      'utf8',
    )
    const closure = readFileSync(
      resolve(sourceRoot, 'services/execution/taskExecutionCallClosure.ts'),
      'utf8',
    )
    const task = readFileSync(resolve(sourceRoot, 'services/task.ts'), 'utf8')
    const taskRoute = readFileSync(resolve(sourceRoot, 'routes/tasks.ts'), 'utf8')
    const multipart = readFileSync(resolve(sourceRoot, 'services/multipartTaskStart.ts'), 'utf8')
    const schedules = readFileSync(resolve(sourceRoot, 'services/scheduledTasks.ts'), 'utf8')
    const webhook = readFileSync(resolve(sourceRoot, 'services/webhook/webhookDispatch.ts'), 'utf8')
    const node = readFileSync(
      resolve(sourceRoot, 'modules/task-execution/composition/nodeMechanics.ts'),
      'utf8',
    )
    const wrapper = readFileSync(
      resolve(sourceRoot, 'modules/task-execution/composition/wrapperMechanics.ts'),
      'utf8',
    )
    const wrapperData = readFileSync(
      resolve(sourceRoot, 'modules/task-execution/application/ports/wrapperData.ts'),
      'utf8',
    )
    const fanout = readFileSync(
      resolve(sourceRoot, 'modules/task-execution/engine/wrapper/fanoutStrategy.ts'),
      'utf8',
    )
    const scheduler = readFileSync(resolve(sourceRoot, 'services/scheduler.ts'), 'utf8')
    const identity = readFileSync(
      resolve(sourceRoot, 'modules/identity-access/application/operationContext.ts'),
      'utf8',
    )
    const sqliteBinding = readFileSync(
      resolve(
        sourceRoot,
        'modules/task-execution/infrastructure/sqliteTaskExecutionResourceSnapshots.ts',
      ),
      'utf8',
    )
    const postgresqlBinding = readFileSync(
      resolve(
        sourceRoot,
        'modules/task-execution/infrastructure/postgresqlTaskExecutionResourceSnapshots.ts',
      ),
      'utf8',
    )
    const postgresqlLaunch = readFileSync(
      resolve(
        sourceRoot,
        'modules/task-execution/infrastructure/postgresqlTaskRouteLaunchOperations.ts',
      ),
      'utf8',
    )

    expect(publicParticipants).toContain('TaskExecutionResourceSnapshotInTx')
    for (const kind of ['workflow-launch', 'agent-injection', 'call-workflow', 'call-workgroup']) {
      expect(publicTypes).toContain(`kind: '${kind}'`)
    }
    expect(composition).toContain('composeTaskExecutionResourceBinding')
    expect(composition).toContain('createTaskExecutionResourceSnapshotInTx(')
    expect(adapter).toContain('authority !== options.authority')
    expect(adapter).toContain("throw new Error('foreign-task-execution-authority')")
    expect(adapter).not.toContain("from '@/services/")
    expect(dependencies).not.toContain("from '@/services/resourceAcl'")
    expect(resources).not.toContain('modules/resource-catalog/composition')
    expect(resources).toContain('createTaskExecutionResourceSession')
    expect(closure).not.toContain('participant.loadAuthorized')
    expect(closure).toContain(
      'resourceAuthority.resources.freezeCallClosure(resourceAuthority, root)',
    )
    for (const binding of [sqliteBinding, postgresqlBinding]) {
      expect(binding).toContain("from '@/modules/resource-catalog/public/participants'")
      expect(binding).toContain('participant.loadAuthorized(pair.authority, requests)')
    }
    expect(sqliteBinding).toContain('TaskExecutionResourceSnapshotInTx')
    expect(sqliteBinding).toContain('const participant = factory.inTransaction(tx, pair)')
    expect(sqliteBinding).toContain('freezeTaskExecutionCallClosureSync(')
    expect(postgresqlBinding).toContain('PostgresqlTaskExecutionResourceSnapshotInTransaction')
    expect(postgresqlBinding).toContain(
      'const participant = factory.inTransaction(transaction, pair)',
    )
    expect(postgresqlBinding).toContain('freezeTaskExecutionCallClosureAsync(')

    expect(task).toContain('freezeTaskExecutionCallClosure(')
    expect(task).not.toContain('freezeCallClosure(')
    expect(taskRoute).not.toContain('modules/identity-access/composition')
    expect(taskRoute).not.toContain('modules/resource-catalog/composition/taskExecution')
    expect(multipart).not.toContain('modules/identity-access/composition')
    expect(multipart).not.toContain('modules/resource-catalog/composition/taskExecution')
    expect(taskRoute).toContain('readonly operations: TaskRouteOperations')
    expect(postgresqlLaunch).toContain('resources: dependencies.resourceAuthorityFor(actor)')
    expect(schedules).toContain('resourceAuthority.taskExecutionResources.freezeCallClosure(')
    expect(webhook).toContain('const taskExecutionAuthority = Object.freeze({')
    expect(webhook).toContain('taskExecutionAuthority,')

    const execution = `${node}\n${wrapper}\n${scheduler}`
    for (const legacyResourceImport of [
      "@/services/agent'",
      "@/services/mcp'",
      "@/services/plugin'",
      "@/services/skill'",
      "@/services/workflow'",
      "@/services/workgroups'",
      "@/services/execution/resolveInjection'",
    ]) {
      expect(execution).not.toContain(legacyResourceImport)
    }
    expect(execution.split('taskExecutionResources.injection(').length - 1).toBe(5)
    expect(execution.split('resolveSyntheticTaskExecutionInjection(').length - 1).toBe(3)
    expect(node).toContain('req.agent.id === ORCHESTRATOR_AGENT_ID')
    expect(wrapperData).toContain('WrapperFanoutAgentResolution')
    expect(wrapper).toContain("return resolution.kind === 'ok'")
    expect(fanout).toContain('agentFailures.get(innerAgentId)')
    expect(fanout).toContain('agentFailures.get(aggregatorKey)')
    expect(fanout.indexOf('if (items.length === 0)')).toBeLessThan(
      fanout.indexOf('agentFailures.get(innerAgentId)'),
    )
    expect(identity).toContain('forTaskExecution(input:')
    expect(taskRoute).toContain('task-route-operations-not-composed')
  })

  test('T5-M/T8 descriptor-backed HTTP and MCP bindings execute the owned aggregate', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const route = readFileSync(resolve(sourceRoot, 'routes/mcps.ts'), 'utf8')
    const application = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/application/mcps/mcpApplication.ts'),
      'utf8',
    )
    const repository = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/sqliteMcpRepository.ts'),
      'utf8',
    )
    const persistence = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/mcpPersistence.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/mcpOperations.ts'),
      'utf8',
    )
    const operations = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/catalogOperationDescriptors.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')
    const routeDispatcher = readFileSync(
      resolve(import.meta.dir, 'helpers/routeOperationDispatcher.ts'),
      'utf8',
    )

    expect(route).not.toContain("from '@/services/mcp'")
    expect(route).not.toContain('AppDeps')
    expect(route).toContain('McpOperationDescriptors')
    expect(route).toContain(
      "import type { McpQueries } from '@/modules/resource-catalog/public/queries'",
    )
    expect(route).toContain('McpAclIdentityParticipant')
    expect(route).not.toContain('mountAclEndpoints')
    for (const consumer of [
      'descriptor: operations.create',
      'descriptor: operations.update',
      'descriptor: operations.delete',
      'descriptor: operations.rename',
      'descriptor: operations.list',
      'descriptor: operations.get',
      'descriptor: operations.getAcl',
      'descriptor: operations.updateAcl',
      'queries.list(',
      'queries.get(',
      'aclIdentity.load(',
    ]) {
      expect(route).toContain(consumer)
    }
    expect(application).toContain('coordinator.runExclusive')
    expect(application).toContain('requireResourceEdit')
    expect(application).toContain('requireResourceGovern')
    expect(application).not.toContain("from '@/db/")
    expect(application).not.toContain('/infrastructure/')
    expect(repository).toContain('dbTxSync')
    expect(repository).toContain('findAgentReferencesInTx')
    expect(repository).toContain("from './mcpPersistence'")
    expect(persistence).toContain("import { sha256Hex } from '@/util/hash'")
    expect(repository).not.toContain("createHash('sha256')")
    expect(repository).not.toContain("from '@/services/")
    expect(composition).toContain('createSqliteMcpRepository')
    expect(composition).toContain('createMcpApplication')
    expect(composition).toContain('composeResourceAclOperationApplication')
    for (const operationId of [
      'mcp-catalog.list-mcps.v1',
      'mcp-catalog.get-mcp.v1',
      'mcp-catalog.create-mcp.v1',
      'mcp-catalog.update-mcp.v1',
      'mcp-catalog.delete-mcp.v1',
    ]) {
      expect(operations).toContain(operationId)
      expect(mcpBindings).toContain(operationId)
    }
    expect(operations).toContain('mcp-catalog.rename-mcp.v1')
    expect(routeDispatcher).toContain(
      'deps.identityAccess ?? createIdentityAccessRuntime({ db: deps.db })',
    )
    expect(routeDispatcher).toContain('admitTestDirectAuthority(')
    expect(routeDispatcher).toContain('createBoundOperationInvoker(app, identity.actor)')
    expect(routeDispatcher).not.toContain('mcpTestOperationActor(actor)')
  })

  test('T5-P/T8 descriptor-backed HTTP binding executes the owned aggregate', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const route = readFileSync(resolve(sourceRoot, 'routes/plugins.ts'), 'utf8')
    const application = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/application/plugins/pluginApplication.ts'),
      'utf8',
    )
    const repository = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/sqlitePluginRepository.ts'),
      'utf8',
    )
    const persistence = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/pluginPersistence.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/pluginOperations.ts'),
      'utf8',
    )
    const operations = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/catalogOperationDescriptors.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')

    expect(route).not.toContain("from '@/services/plugin'")
    expect(route).not.toContain("from '@/services/pluginInstaller'")
    expect(route).not.toContain('AppDeps')
    expect(route).toContain('PluginOperationDescriptors')
    expect(route).toContain('PluginQueries')
    expect(route).not.toContain('PluginAclIdentityParticipant')
    expect(route).not.toContain('mountAclEndpoints')
    for (const consumer of [
      'descriptor: operations.create',
      'descriptor: operations.update',
      'descriptor: operations.delete',
      'descriptor: operations.rename',
      'descriptor: operations.checkUpdate',
      'descriptor: operations.upgrade',
      'descriptor: operations.list',
      'descriptor: operations.get',
      'descriptor: operations.getAcl',
      'descriptor: operations.updateAcl',
      'queries.get(',
    ]) {
      expect(route).toContain(consumer)
    }
    expect(application).toContain('coordinator.runExclusive')
    expect(application).toContain('coordinator.runDeduplicatedOperation')
    expect(application).toContain('requireResourceEdit')
    expect(application).toContain('requireResourceGovern')
    expect(application).toContain('const commands = Object.freeze')
    expect(application).toContain('const updateCommands = Object.freeze')
    expect(application).toContain('Object.freeze({ commands, updateCommands, queries })')
    expect(application).not.toContain("from '@/db/")
    expect(application).not.toContain('/infrastructure/')
    expect(repository).toContain('dbTxSync')
    expect(repository).toContain('fullPluginRowWhere')
    expect(repository).toContain('findAgentReferencesInTx')
    expect(repository).toContain("from './pluginPersistence'")
    expect(persistence).toContain("import { sha256Hex } from '@/util/hash'")
    expect(repository).not.toContain("createHash('sha256')")
    expect(repository).not.toContain("from '@/services/")
    expect(composition).toContain('createSqlitePluginRepository')
    expect(composition).toContain('createPluginApplication')
    expect(composition).toContain('composeResourceAclOperationApplication')
    expect(composition).toContain('createLegacyPluginInstaller')
    expect(composition).toContain('application.commands')
    expect(composition).toContain('application.updateCommands')
    expect(operations).toContain('updateCommands.checkUpdate')
    expect(operations).toContain('updateCommands.upgrade')
    for (const operationId of [
      'plugin-catalog.list-plugins.v1',
      'plugin-catalog.get-plugin.v1',
      'plugin-catalog.create-plugin.v1',
      'plugin-catalog.update-plugin.v1',
      'plugin-catalog.delete-plugin.v1',
    ]) {
      expect(operations).toContain(operationId)
      expect(mcpBindings).toContain(operationId)
    }
    for (const operationId of [
      'plugin-catalog.rename-plugin.v1',
      'plugin-catalog.check-plugin-update.v1',
      'plugin-catalog.upgrade-plugin.v1',
    ]) {
      expect(operations).toContain(operationId)
    }
  })

  test('T5-WG active HTTP binding executes the owned aggregate', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const route = readFileSync(resolve(sourceRoot, 'routes/workgroups.ts'), 'utf8')
    const application = readFileSync(
      resolve(
        sourceRoot,
        'modules/resource-catalog/application/workgroups/workgroupApplication.ts',
      ),
      'utf8',
    )
    const repository = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/sqliteWorkgroupRepository.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/workgroupOperations.ts'),
      'utf8',
    )
    const operations = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/catalogOperationDescriptors.ts'),
      'utf8',
    )
    const publicTypes = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/types.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')

    expect(route).not.toContain("from '@/services/workgroups'")
    expect(route).toContain('WorkgroupOperationDescriptors')
    expect(route).toContain('WorkgroupQueries')
    expect(route).not.toContain('WorkgroupAclIdentityParticipant')
    expect(route).not.toContain('mountAclEndpoints')
    for (const consumer of [
      'descriptor: operations.create',
      'descriptor: operations.copy',
      'descriptor: operations.update',
      'descriptor: operations.delete',
      'descriptor: operations.rename',
      'descriptor: operations.list',
      'descriptor: operations.get',
      'descriptor: operations.getAcl',
      'descriptor: operations.updateAcl',
      'queries.get(',
    ]) {
      expect(route).toContain(consumer)
    }
    expect(publicTypes).not.toContain('readonly deletion: unknown')
    expect(publicTypes).toContain("readonly kind: 'json-body'")
    expect(publicTypes).toContain('readonly body: string')
    expect(route).not.toContain('DeleteWorkgroupSchema')
    expect(route).toContain('c.req.raw.text()')
    expect(route).toContain('deletion: {')
    expect(application).toContain('requireResourceEdit')
    expect(application).toContain('requireResourceGovern')
    expect(application).toContain('DeleteWorkgroupSchema.safeParse(body)')
    expect(application).toContain('const commands = Object.freeze')
    expect(application).toContain('const queries: WorkgroupQueries = Object.freeze')
    expect(application).not.toContain("from '@/db/")
    expect(application).not.toContain('/infrastructure/')
    expect(repository).toContain('dbTxSync')
    expect(repository).toContain('assertAgentIdsUsableInTx')
    expect(repository).toContain('scheduledReferences')
    expect(repository).toContain("import { sha256Hex } from '@/util/hash'")
    expect(repository).not.toContain("from '@/services/")
    expect(composition).toContain('createSqliteWorkgroupRepository')
    expect(composition).toContain('createWorkgroupApplication')
    expect(composition).toContain('composeResourceAclOperationApplication')
    expect(operations).toContain('inputSchema: deleteWorkgroupInputSchema')
    expect(operations).toContain('deletion: jsonBodySubmissionSchema')

    const deleteCommandStart = application.indexOf('async delete(')
    const loadVisible = application.indexOf(
      'const current = await loadVisible(authority, input.id)',
      deleteCommandStart,
    )
    const requireGovern = application.indexOf(
      'await deps.access.requireResourceGovern(authority, current)',
      loadVisible,
    )
    const validateSubmission = application.indexOf(
      'parseDeleteWorkgroupSubmission(input.deletion)',
      requireGovern,
    )
    expect(deleteCommandStart).toBeGreaterThanOrEqual(0)
    expect(loadVisible).toBeGreaterThan(deleteCommandStart)
    expect(requireGovern).toBeGreaterThan(loadVisible)
    expect(validateSubmission).toBeGreaterThan(requireGovern)
    for (const operationId of [
      'workgroup-catalog.list-workgroups.v1',
      'workgroup-catalog.get-workgroup.v1',
      'workgroup-catalog.create-workgroup.v1',
      'workgroup-catalog.update-workgroup.v1',
      'workgroup-catalog.delete-workgroup.v1',
    ]) {
      expect(operations).toContain(operationId)
      expect(mcpBindings).toContain(operationId)
    }
    for (const operationId of [
      'workgroup-catalog.copy-workgroup.v1',
      'workgroup-catalog.rename-workgroup.v1',
    ]) {
      expect(operations).toContain(operationId)
    }
  })

  test('T5-A active HTTP binding executes the owned aggregate', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const route = readFileSync(resolve(sourceRoot, 'routes/agents.ts'), 'utf8')
    const application = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/application/agents/agentApplication.ts'),
      'utf8',
    )
    const repository = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/sqliteAgentRepository.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/agentOperations.ts'),
      'utf8',
    )
    const operations = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/catalogOperationDescriptors.ts'),
      'utf8',
    )
    const publicTypes = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/types.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')

    expect(route).not.toContain("from '@/services/agent'")
    expect(route).toContain('AgentOperationDescriptors')
    expect(route).toContain('AgentQueries')
    expect(route).toContain('AgentReferenceQueries')
    expect(route).not.toContain('AgentAclIdentityParticipant')
    expect(route).not.toContain('mountAclEndpoints')
    for (const consumer of [
      'descriptor: operations.create',
      'descriptor: operations.update',
      'descriptor: operations.delete',
      'descriptor: operations.rename',
      'descriptor: operations.list',
      'descriptor: operations.get',
      'descriptor: operations.getAcl',
      'descriptor: operations.updateAcl',
      'referenceQueries.labels(',
    ]) {
      expect(route).toContain(consumer)
    }
    expect(publicTypes).not.toContain('readonly submission: unknown')
    expect(publicTypes).toContain("readonly kind: 'json-body'")
    expect(publicTypes).toContain('readonly body: string')
    expect(publicTypes).toContain('readonly builtin: boolean')
    expect(publicTypes).toContain('interface AgentReferenceLabel {')
    expect(publicTypes).not.toContain('export interface AgentReferenceLabel {')
    expect(route).not.toContain('UpdateAgentRequestSchema')
    expect(route).not.toContain('DeleteAgentSchema')
    expect(route).not.toContain('readDeleteBody')
    expect(route).toContain("kind: 'json-body'")
    expect(route).toContain('c.req.raw.text()')
    expect(application).toContain('UpdateAgentRequestSchema.safeParse(body)')
    expect(application).toContain('DeleteAgentSchema.safeParse(body)')
    expect(application).toContain("new ValidationError('invalid-json'")
    expect(application).toContain('requireResourceEdit')
    expect(application).toContain('requireResourceGovern')
    expect(application).toContain('assertDeleteConfirm(body, current.name)')
    expect(application).toContain('const commands = Object.freeze')
    expect(application).toContain('const queries: AgentQueries = Object.freeze')
    expect(application).toContain('const referenceQueries: AgentReferenceQueries = Object.freeze')
    expect(application).not.toContain("from '@/db/")
    expect(application).not.toContain('/infrastructure/')
    expect(repository).toContain("from './legacy/agent'")
    expect(repository).toContain('explicit compatibility island')
    expect(repository).toContain('loadClosureRefNames(')
    expect(composition).toContain('createSqliteAgentRepository')
    expect(composition).toContain('createAgentApplication')
    expect(composition).toContain('composeAgentCatalogFromAdapters')
    expect(composition).toContain('export function composePostgresqlAgentCatalog(')
    expect(composition).toContain('createPostgresqlAgentRepository({')
    expect(composition).toContain(
      "resourceCatalog: Pick<ProviderResourceCatalogComposition, 'authorization' | 'acl'>",
    )
    expect(composition).toContain(
      "composeProviderResourceAclOperationApplication<AgentOperationContext, 'agent', Agent>",
    )

    const postgresqlCompositionStart = composition.indexOf(
      'export function composePostgresqlAgentCatalog(',
    )
    const postgresqlCompositionEnd = composition.indexOf(
      'export function composeAgentCatalog(',
      postgresqlCompositionStart,
    )
    const postgresqlComposition = composition.slice(
      postgresqlCompositionStart,
      postgresqlCompositionEnd,
    )
    expect(postgresqlComposition).not.toContain('createSqliteAgentRepository')
    expect(postgresqlComposition).not.toContain('composeResourceAclOperationApplication')
    expect(postgresqlComposition).not.toContain('as DbClient')

    const updateCommandStart = application.indexOf('async update(')
    const parseUpdate = application.indexOf('parseUpdateSubmission(input)', updateCommandStart)
    const updateLoadVisible = application.indexOf(
      'const current = await loadVisible(authority, input.id)',
      parseUpdate,
    )
    const updateRequireEdit = application.indexOf(
      'await deps.access.requireResourceEdit(authority, current)',
      updateLoadVisible,
    )
    expect(updateCommandStart).toBeGreaterThanOrEqual(0)
    expect(parseUpdate).toBeGreaterThan(updateCommandStart)
    expect(updateLoadVisible).toBeGreaterThan(parseUpdate)
    expect(updateRequireEdit).toBeGreaterThan(updateLoadVisible)

    const deleteCommandStart = application.indexOf('async delete(')
    const deleteLoadVisible = application.indexOf(
      'const current = await loadVisible(authority, input.id)',
      deleteCommandStart,
    )
    const deleteRequireGovern = application.indexOf(
      'await deps.access.requireResourceGovern(authority, current)',
      deleteLoadVisible,
    )
    const confirmDelete = application.indexOf(
      'assertDeleteConfirm(body, current.name)',
      deleteRequireGovern,
    )
    const parseDelete = application.indexOf('parseDeleteSubmission(body)', confirmDelete)
    expect(deleteCommandStart).toBeGreaterThanOrEqual(0)
    expect(deleteLoadVisible).toBeGreaterThan(deleteCommandStart)
    expect(deleteRequireGovern).toBeGreaterThan(deleteLoadVisible)
    expect(confirmDelete).toBeGreaterThan(deleteRequireGovern)
    expect(parseDelete).toBeGreaterThan(confirmDelete)

    for (const operationId of [
      'agent-catalog.list-agents.v1',
      'agent-catalog.get-agent.v1',
      'agent-catalog.create-agent.v1',
      'agent-catalog.update-agent.v1',
      'agent-catalog.delete-agent.v1',
    ]) {
      expect(operations).toContain(operationId)
      expect(mcpBindings).toContain(operationId)
    }
    expect(operations).toContain('agent-catalog.rename-agent.v1')
    expect(operations).toContain('inputSchema: updateAgentInputSchema')
    expect(operations).toContain('inputSchema: deleteAgentInputSchema')
    expect(operations).toContain(
      'const agentCatalogResourceSchema = AgentSchema.extend({ name: z.string().min(1).max(128) })',
    )
    expect(operations).toContain('inputSchema: CreateAgentSchema')
    expect(operations).toContain('outputSchema: z.array(agentCatalogResourceSchema)')
    expect(operations).toContain('outputSchema: agentCatalogResourceSchema')
  })

  test('T5-S active HTTP binding executes the owned aggregate', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const route = readFileSync(resolve(sourceRoot, 'routes/skills.ts'), 'utf8')
    const application = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/application/skills/skillApplication.ts'),
      'utf8',
    )
    const repository = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/sqliteSkillRepository.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/skillOperations.ts'),
      'utf8',
    )
    const operations = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/catalogOperationDescriptors.ts'),
      'utf8',
    )
    const publicTypes = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/types.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')

    expect(route).not.toContain("from '@/services/skill'")
    expect(route).not.toContain("from '@/services/skillVersion'")
    expect(route).not.toContain("from '@/services/skill-zip'")
    for (const contract of [
      'SkillOperationDescriptors',
      'SkillFileCommands',
      'SkillVersionCommands',
      'SkillQueries',
      'SkillFileQueries',
      'SkillVersionQueries',
      'SkillZipImportParticipant',
    ]) {
      expect(route).toContain(contract)
    }
    expect(route).not.toContain('SkillAclIdentityParticipant')
    expect(route).not.toContain('mountAclEndpoints')
    for (const consumer of [
      'descriptor: operations.create',
      'descriptor: operations.save',
      'descriptor: operations.delete',
      'descriptor: operations.list',
      'descriptor: operations.get',
      'descriptor: operations.content',
      'descriptor: operations.listFiles',
      'descriptor: operations.readFile',
      'descriptor: operations.writeFile',
      'descriptor: operations.deleteFile',
      'descriptor: operations.listVersions',
      'descriptor: operations.diffVersions',
      'descriptor: operations.getVersionContent',
      'descriptor: operations.restoreVersion',
      'descriptor: operations.getAcl',
      'descriptor: operations.updateAcl',
    ]) {
      expect(route).toContain(consumer)
    }
    expect(publicTypes).not.toContain('readonly submission: unknown')
    expect(publicTypes).toContain("readonly kind: 'json-body'")
    expect(application).toContain('CreateManagedSkillSchema.safeParse')
    expect(application).toContain('CombinedSaveSkillSchema.safeParse')
    expect(application).toContain('DeleteSkillSchema.safeParse')
    expect(application).toContain('WriteSkillFileSchema.safeParse')
    expect(application).toContain('RestoreSkillVersionSchema.safeParse')
    expect(application).toContain('deps.confirmations.assertResource(body, current.name)')
    expect(application).toContain('deps.access.requireResourceEdit')
    expect(application).toContain('deps.access.requireResourceGovern')
    expect(application).not.toContain("from '@/db/")
    expect(application).not.toContain('/infrastructure/')
    expect(repository).toContain("from '@/modules/resource-catalog/infrastructure/legacy/skill'")
    expect(repository).toContain(
      "from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'",
    )
    expect(repository).toContain('explicit compatibility island')
    expect(composition).toContain('createSqliteSkillRepository')
    expect(composition).toContain('createSqliteSkillZipImportParticipant')
    expect(composition).toContain('createPostgresqlSkillZipImportParticipant')
    expect(composition).toContain('createSkillApplication')
    expect(composition).toContain('composeResourceAclOperationApplication')

    const deleteCommandStart = application.indexOf('async delete(')
    const loadVisible = application.indexOf(
      'const current = await loadVisible(authority, input.id)',
      deleteCommandStart,
    )
    const requireGovern = application.indexOf(
      'await deps.access.requireResourceGovern(authority, current)',
      loadVisible,
    )
    const parseSubmission = application.indexOf(
      'const body = jsonOrInvalid(input.submission.body)',
      requireGovern,
    )
    const confirmDelete = application.indexOf(
      'deps.confirmations.assertResource(body, current.name)',
      parseSubmission,
    )
    expect(deleteCommandStart).toBeGreaterThanOrEqual(0)
    expect(loadVisible).toBeGreaterThan(deleteCommandStart)
    expect(requireGovern).toBeGreaterThan(loadVisible)
    expect(parseSubmission).toBeGreaterThan(requireGovern)
    expect(confirmDelete).toBeGreaterThan(parseSubmission)

    for (const operationId of [
      'skill-catalog.list-skills.v1',
      'skill-catalog.get-skill.v1',
      'skill-catalog.create-skill.v1',
      'skill-catalog.save-skill.v1',
      'skill-catalog.delete-skill.v1',
    ]) {
      expect(operations).toContain(operationId)
      expect(mcpBindings).toContain(operationId)
    }
    for (const operationId of [
      'skill-catalog.get-skill-content.v1',
      'skill-catalog.list-skill-files.v1',
      'skill-catalog.read-skill-file.v1',
      'skill-catalog.write-skill-file.v1',
      'skill-catalog.delete-skill-file.v1',
      'skill-catalog.list-skill-versions.v1',
      'skill-catalog.diff-skill-versions.v1',
      'skill-catalog.get-skill-version-content.v1',
      'skill-catalog.restore-skill-version.v1',
    ]) {
      expect(operations).toContain(operationId)
    }
  })

  test('T5-WF active HTTP binding executes the owned aggregate', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const route = readFileSync(resolve(sourceRoot, 'routes/workflows.ts'), 'utf8')
    const application = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/application/workflows/workflowApplication.ts'),
      'utf8',
    )
    const repository = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/sqliteWorkflowRepository.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/workflowOperations.ts'),
      'utf8',
    )
    const operations = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/catalogOperationDescriptors.ts'),
      'utf8',
    )
    const publicTypes = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/types.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')

    expect(route).not.toContain("from '@/services/workflow'")
    expect(route).not.toContain("from '@/services/workflow.validator'")
    expect(route).not.toContain("from '@/services/resourceRefs'")
    for (const contract of [
      'WorkflowOperationDescriptors',
      'WorkflowQueries',
      'WorkflowValidationQueries',
    ]) {
      expect(route).toContain(contract)
    }
    expect(route).toContain('module.validationQueries.validateStored(')
    expect(route).toContain('module.validationQueries.validateDraft(')
    expect(route).not.toContain('WorkflowAclIdentityParticipant')
    expect(route).not.toContain('mountAclEndpoints')
    for (const consumer of [
      'descriptor: operations.create',
      'descriptor: operations.copy',
      'descriptor: operations.update',
      'descriptor: operations.delete',
      'descriptor: operations.list',
      'descriptor: operations.get',
      'descriptor: operations.getAcl',
      'descriptor: operations.updateAcl',
    ]) {
      expect(route).toContain(consumer)
    }
    expect(publicTypes).not.toContain('readonly submission: unknown')
    expect(publicTypes).toContain("readonly kind: 'json-body'")
    expect(application).toContain('CreateWorkflowSchema.safeParse')
    expect(application).toContain('UpdateWorkflowSchema.safeParse')
    expect(application).toContain('DeleteWorkflowSchema.safeParse')
    expect(application).not.toContain("from '@/db/")
    expect(application).not.toContain('/infrastructure/')
    expect(repository).toContain("from '@/modules/resource-catalog/infrastructure/legacy/workflow'")
    expect(repository).toContain('explicit compatibility island')
    expect(composition).toContain('createSqliteWorkflowRepository')
    expect(composition).toContain('createWorkflowApplication')
    expect(composition).toContain('composeResourceAclOperationApplication')

    const deleteCommandStart = application.indexOf('async delete(')
    const loadVisible = application.indexOf(
      'const current = await loadVisibleIdentity(authority, input.id)',
      deleteCommandStart,
    )
    const assertMutable = application.indexOf('deps.policy.assertMutable(current)', loadVisible)
    const requireGovern = application.indexOf(
      'await deps.access.requireResourceGovern(authority, current)',
      assertMutable,
    )
    const parseSubmission = application.indexOf(
      'const deletion = parseDeleteSubmission(jsonOrEmpty(input.submission.body))',
      requireGovern,
    )
    const confirmDelete = application.indexOf(
      'assertDeleteConfirm(deletion, current.name)',
      parseSubmission,
    )
    expect(deleteCommandStart).toBeGreaterThanOrEqual(0)
    expect(loadVisible).toBeGreaterThan(deleteCommandStart)
    expect(assertMutable).toBeGreaterThan(loadVisible)
    expect(requireGovern).toBeGreaterThan(assertMutable)
    expect(parseSubmission).toBeGreaterThan(requireGovern)
    expect(confirmDelete).toBeGreaterThan(parseSubmission)

    for (const operationId of [
      'workflow-catalog.list-workflows.v1',
      'workflow-catalog.get-workflow.v1',
      'workflow-catalog.create-workflow.v1',
      'workflow-catalog.update-workflow.v1',
      'workflow-catalog.delete-workflow.v1',
    ]) {
      expect(operations).toContain(operationId)
      expect(mcpBindings).toContain(operationId)
    }
    expect(operations).toContain('workflow-catalog.copy-workflow.v1')
  })

  test('BundleApply keeps lifecycle ownership while seven writer arms stay in infrastructure', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const compatibilityFacade = readFileSync(
      resolve(sourceRoot, 'services/bundle/apply.ts'),
      'utf8',
    )
    const sqliteEngine = readFileSync(
      resolve(sourceRoot, 'platform/persistence/sqlite/legacyResourcePackageBundleApply.ts'),
      'utf8',
    )
    const postgresqlEngine = readFileSync(
      resolve(sourceRoot, 'platform/persistence/postgresqlResourcePackageAtomicApply.ts'),
      'utf8',
    )
    const adapter = readFileSync(
      resolve(
        sourceRoot,
        'modules/resource-catalog/infrastructure/aggregateAdapters/legacyResourcePackageMutationParticipants.ts',
      ),
      'utf8',
    )
    const dependencies = readFileSync(
      resolve(sourceRoot, 'services/bundle/legacyResourcePackageMutationDependencies.ts'),
      'utf8',
    )
    const application = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/application/package/packageApplication.ts'),
      'utf8',
    )
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/resourcePackageOperations.ts'),
      'utf8',
    )
    const route = readFileSync(resolve(sourceRoot, 'routes/resourcePackages.ts'), 'utf8')
    const cli = readFileSync(resolve(sourceRoot, 'cli/package.ts'), 'utf8')

    expect(compatibilityFacade).toContain(
      "export * from '@/platform/persistence/sqlite/legacyResourcePackageBundleApply'",
    )
    expect(compatibilityFacade).not.toContain("from '@/db/")
    expect(sqliteEngine).not.toContain('createLegacyResourcePackageMutationAdapter')
    expect(sqliteEngine).toContain('resourceBundleApplies')
    expect(sqliteEngine).toContain("state: 'applying'")
    expect(sqliteEngine).toContain('provider.revalidateInTx?.(tx)')
    expect(sqliteEngine).toContain('provider.finalizeInTx?.(tx, receiptValue)')
    expect(sqliteEngine).toContain('ACTIVE_BUNDLE_APPLIES')
    expect(sqliteEngine).toContain('convergeResourceBundleApplies')
    expect(sqliteEngine).toContain('deps.resourcePackageMutations ??')
    expect(sqliteEngine).toContain('.create({')

    expect(postgresqlEngine).toContain('resourceBundleApplies')
    expect(postgresqlEngine).toContain('input.mutationSessionFactory.create({')
    expect(postgresqlEngine).toContain('readSkillFile,')
    expect(postgresqlEngine).toContain('await session.prestage(item, { recordArtifact })')
    expect(postgresqlEngine).toContain(".set({ state: 'applying', updatedAt: now() })")
    expect(postgresqlEngine).toContain(
      'const transactionSession = session.bindTransaction(transaction)',
    )
    expect(postgresqlEngine).toContain(
      'await assertActiveHumanMappings(transactionSession.reader, humanMappings.activeUserIds)',
    )
    expect(postgresqlEngine).toContain('await session.rollForward({ artifacts, receipt })')
    expect(postgresqlEngine).toContain('await session.afterCommitted(receipt)')
    expect(postgresqlEngine).toContain(
      'await session.compensate({ artifacts, databaseCommitted: false })',
    )
    expect(postgresqlEngine).toContain('activeApplyIds()')

    for (const legacyWriter of [
      "@/services/agent'",
      "@/services/skill'",
      "@/services/skillVersion'",
      "@/services/mcp'",
      "@/services/plugin'",
      "@/services/workflow'",
      "@/services/workgroups'",
    ]) {
      expect(sqliteEngine).not.toContain(legacyWriter)
      expect(postgresqlEngine).not.toContain(legacyWriter)
      expect(adapter).not.toContain(legacyWriter)
      expect(dependencies).not.toContain(legacyWriter)
    }
    expect(dependencies).toContain("from '@/services/pluginInstaller'")
    expect(dependencies).toContain("from '@/services/capabilityTemplates'")
    expect(adapter).not.toContain("from '@/services/")
    expect(sqliteEngine).toContain('compensateLegacyResourcePackageArtifact(')
    expect(sqliteEngine).toContain('rollForwardLegacyResourcePackageArtifacts(')
    expect(sqliteEngine).toContain('legacyResourcePackageMutationDependencies')
    expect(dependencies).toContain('createLegacyResourcePackageMutationAdapter')

    for (const participant of [
      'agents',
      'skills',
      'mcps',
      'plugins',
      'workflows',
      'workgroups',
      'capabilityTemplates',
    ]) {
      expect(adapter).toContain(`${participant}:`)
      expect(sqliteEngine).toContain(`provider.participants.${participant}.prepare`)
      expect(sqliteEngine).toContain(`applyTx.${participant}.commit`)
      expect(postgresqlEngine).toContain(
        `session.participants.${participant}.prepareOpaque(operation)`,
      )
      expect(postgresqlEngine).toContain(
        `transactionSession.participants.${participant}.commit(prepared)`,
      )
    }
    expect(application).toContain('const commands: ResourcePackageCommands = Object.freeze')
    expect(application).toContain('const queries: ResourcePackageQueries = Object.freeze')
    expect(composition).toContain('createResourcePackageApplication')
    expect(composition).toContain('createResourcePackageOperationDescriptors')
    expect(composition).toContain('readonly execution: ResourcePackageExecutionAdapter')
    expect(composition).toContain('composeSqliteResourcePackageProvider')
    expect(composition).toContain('createSqliteResourcePackageReadPort')
    expect(composition).toContain('readSqlitePackageSkillTree')
    expect(composition).not.toMatch(
      /@\/services\/(?:bundle\/legacyResourcePackageMutationDependencies|resourcePackage\/(?:commit|export|parse|preview))/,
    )
    for (const operationId of [
      'resource-catalog.inspect-package.v1',
      'resource-catalog.apply-package.v1',
      'resource-catalog.get-package-preview.v1',
      'resource-catalog.get-package-receipt.v1',
      'resource-catalog.export-agent-package.v1',
      'resource-catalog.export-skill-package.v1',
      'resource-catalog.export-mcp-package.v1',
      'resource-catalog.export-plugin-package.v1',
      'resource-catalog.export-workflow-package.v1',
      'resource-catalog.export-workgroup-package.v1',
      'resource-catalog.export-capability-template-package.v1',
    ]) {
      expect(
        readFileSync(
          resolve(
            sourceRoot,
            'modules/resource-catalog/composition/catalogOperationDescriptors.ts',
          ),
          'utf8',
        ),
      ).toContain(operationId)
    }
    expect(route).not.toContain("from '@/services/resourcePackage/")
    expect(cli).not.toContain("from '@/services/resourcePackage/")
    for (const consumer of [
      'catalog.operations.inspect',
      'catalog.operations.apply',
      'catalog.operations.getPreview',
      'catalog.operations.getReceipt',
      'catalog.operations.exports',
    ]) {
      expect(`${route}\n${cli}`).toContain(consumer)
    }
  })

  test('T8 binds classic aggregates and ResourcePackage through exact descriptors', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const publicOperationContracts = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/operations.ts'),
      'utf8',
    )
    const descriptorConstruction = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/catalogOperationDescriptors.ts'),
      'utf8',
    )
    for (const aggregate of [
      'Agent',
      'Skill',
      'Mcp',
      'Plugin',
      'Workflow',
      'Workgroup',
      'ResourcePackage',
    ]) {
      const builder = `create${aggregate}OperationDescriptors`
      expect(publicOperationContracts).not.toContain(builder)
      expect(descriptorConstruction).toContain(`export function ${builder}`)
    }
    const operationBindings = (route: string): string[] =>
      [
        ...route.matchAll(
          /descriptor:\s*(operations\.[A-Za-z][A-Za-z0-9]*),\s*\n\s*method:\s*'([^']+)',\s*\n\s*path:\s*'([^']+)'/gu,
        ),
      ]
        .map((match) => `${match[1]}|${match[2]}|${match[3]}`)
        .sort()
    const routeCases = [
      [
        'agents.ts',
        'agent',
        [
          'operations.list|GET|/api/agents',
          'operations.get|GET|/api/agents/:id',
          'operations.create|POST|/api/agents',
          'operations.update|PUT|/api/agents/:id',
          'operations.delete|DELETE|/api/agents/:id',
          'operations.rename|POST|/api/agents/:id/rename',
          'operations.getAcl|GET|/api/agents/:id/acl',
          'operations.updateAcl|PUT|/api/agents/:id/acl',
        ],
      ],
      [
        'mcps.ts',
        'mcp',
        [
          'operations.list|GET|/api/mcps',
          'operations.get|GET|/api/mcps/:id',
          'operations.create|POST|/api/mcps',
          'operations.update|PUT|/api/mcps/:id',
          'operations.delete|DELETE|/api/mcps/:id',
          'operations.rename|POST|/api/mcps/:id/rename',
          'operations.getAcl|GET|/api/mcps/:id/acl',
          'operations.updateAcl|PUT|/api/mcps/:id/acl',
        ],
      ],
      [
        'plugins.ts',
        'plugin',
        [
          'operations.list|GET|/api/plugins',
          'operations.get|GET|/api/plugins/:id',
          'operations.create|POST|/api/plugins',
          'operations.update|PUT|/api/plugins/:id',
          'operations.delete|DELETE|/api/plugins/:id',
          'operations.rename|POST|/api/plugins/:id/rename',
          'operations.checkUpdate|POST|/api/plugins/:id/check-update',
          'operations.upgrade|POST|/api/plugins/:id/upgrade',
          'operations.getAcl|GET|/api/plugins/:id/acl',
          'operations.updateAcl|PUT|/api/plugins/:id/acl',
        ],
      ],
      [
        'skills.ts',
        'skill',
        [
          'operations.list|GET|/api/skills',
          'operations.create|POST|/api/skills',
          'operations.get|GET|/api/skills/:id',
          'operations.delete|DELETE|/api/skills/:id',
          'operations.content|GET|/api/skills/:id/content',
          'operations.save|POST|/api/skills/:id/save',
          'operations.listFiles|GET|/api/skills/:id/files',
          'operations.readFile|GET|/api/skills/:id/file',
          'operations.writeFile|PUT|/api/skills/:id/file',
          'operations.deleteFile|DELETE|/api/skills/:id/file',
          'operations.listVersions|GET|/api/skills/:id/versions',
          'operations.diffVersions|GET|/api/skills/:id/versions/diff',
          'operations.getVersionContent|GET|/api/skills/:id/versions/:v/content',
          'operations.restoreVersion|POST|/api/skills/:id/versions/:v/restore',
          'operations.getAcl|GET|/api/skills/:id/acl',
          'operations.updateAcl|PUT|/api/skills/:id/acl',
        ],
      ],
      [
        'workflows.ts',
        'workflow',
        [
          'operations.list|GET|/api/workflows',
          'operations.get|GET|/api/workflows/:id',
          'operations.create|POST|/api/workflows',
          'operations.copy|POST|/api/workflows/:id/copy',
          'operations.update|PUT|/api/workflows/:id',
          'operations.delete|DELETE|/api/workflows/:id',
          'operations.getAcl|GET|/api/workflows/:id/acl',
          'operations.updateAcl|PUT|/api/workflows/:id/acl',
        ],
      ],
      [
        'workgroups.ts',
        'workgroup',
        [
          'operations.list|GET|/api/workgroups',
          'operations.get|GET|/api/workgroups/:id',
          'operations.create|POST|/api/workgroups',
          'operations.copy|POST|/api/workgroups/:id/copy',
          'operations.update|PUT|/api/workgroups/:id',
          'operations.delete|DELETE|/api/workgroups/:id',
          'operations.rename|POST|/api/workgroups/:id/rename',
          'operations.getAcl|GET|/api/workgroups/:id/acl',
          'operations.updateAcl|PUT|/api/workgroups/:id/acl',
        ],
      ],
    ] as const
    for (const [file, resource, expectedBindings] of routeCases) {
      const route = readFileSync(resolve(sourceRoot, 'routes', file), 'utf8')
      expect(operationBindings(route), file).toEqual([...expectedBindings].sort())
      expect(route.split('registerOperationRoute(app, {').length - 1).toBe(expectedBindings.length)
      expect(route).toContain('descriptor: operations.getAcl')
      expect(route).toContain('descriptor: operations.updateAcl')
      expect(route).not.toContain('mountAclEndpoints')

      const catalog = resource === 'mcp' ? 'mcp' : resource
      const operationPrefix = `${catalog}-catalog`
      const operations = readFileSync(
        resolve(sourceRoot, 'modules/resource-catalog/composition/catalogOperationDescriptors.ts'),
        'utf8',
      )
      expect(operations).toContain(`${operationPrefix}.get-${resource}-acl.v1`)
      expect(operations).toContain(`${operationPrefix}.update-${resource}-acl.v1`)
    }

    const packageRoute = readFileSync(resolve(sourceRoot, 'routes/resourcePackages.ts'), 'utf8')
    const packageCli = readFileSync(resolve(sourceRoot, 'cli/package.ts'), 'utf8')
    const bindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')
    const aclApplication = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/application/resourceAcl.ts'),
      'utf8',
    )
    const aclComposition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/resourceAcl.ts'),
      'utf8',
    )
    const publicParticipants = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/participants.ts'),
      'utf8',
    )

    const packageBindings = [
      ...packageRoute.matchAll(
        /descriptor:\s*(deps\.catalog\.operations\.(?:exports\.)?[A-Za-z_][A-Za-z0-9_]*),\s*\n\s*method:\s*'([^']+)',\s*\n\s*path:\s*'([^']+)'/gu,
      ),
    ]
      .map((match) => `${match[1]}|${match[2]}|${match[3]}`)
      .sort()
    expect(packageBindings).toEqual(
      [
        'deps.catalog.operations.exports.agent|GET|/api/agents/:id/export-package',
        'deps.catalog.operations.exports.skill|GET|/api/skills/:id/export-package',
        'deps.catalog.operations.exports.mcp|GET|/api/mcps/:id/export-package',
        'deps.catalog.operations.exports.plugin|GET|/api/plugins/:id/export-package',
        'deps.catalog.operations.exports.workflow|GET|/api/workflows/:id/export-package',
        'deps.catalog.operations.exports.workgroup|GET|/api/workgroups/:id/export-package',
        'deps.catalog.operations.exports.capability_template|GET|/api/capability-templates/:id/export-package',
        'deps.catalog.operations.inspect|POST|/api/resource-packages/preview',
        'deps.catalog.operations.apply|POST|/api/resource-packages/commit',
      ].sort(),
    )
    expect(packageRoute.split('registerOperationRoute(app, {').length - 1).toBe(
      packageBindings.length,
    )
    expect(packageRoute).not.toContain('registerRoute(')
    expect(packageRoute.split('middleware: resourcePackageBodyLimit').length - 1).toBe(2)
    expect(packageRoute).not.toContain('registerRouteMiddleware')
    expect(packageCli).toContain('catalog.operations.exports[type]')
    expect(bindings).toContain("implementation: 'descriptor'")

    const initialLoad = aclApplication.indexOf('const row = await loadVisible(authority, input.id)')
    const parseSubmission = aclApplication.indexOf(
      'const body = parseResourceAclSubmission(input)',
      initialLoad,
    )
    const freshVisibility = aclApplication.indexOf(
      'if (!(await deps.canView(authority, fresh))) throw notFound()',
      parseSubmission,
    )
    const builtinGuard = aclApplication.indexOf('deps.assertMutable(fresh)', freshVisibility)
    const update = aclApplication.indexOf(
      'return deps.update(authority, fresh, body, updatedAt)',
      builtinGuard,
    )
    const afterUpdated = aclApplication.indexOf('await deps.afterUpdated?.(row.id)', update)
    expect(initialLoad).toBeGreaterThanOrEqual(0)
    expect(parseSubmission).toBeGreaterThan(initialLoad)
    expect(freshVisibility).toBeGreaterThan(parseSubmission)
    expect(builtinGuard).toBeGreaterThan(freshVisibility)
    expect(update).toBeGreaterThan(builtinGuard)
    expect(afterUpdated).toBeGreaterThan(update)
    expect(aclApplication).toContain('deps.linearizer.runExclusive')
    expect(aclComposition).toContain("triggerRevalidation('resource-acl-changed')")
    expect(aclComposition).toContain('assertNotBuiltin(input.type, row)')

    for (const retired of ['Agent', 'Skill', 'Plugin', 'Workflow', 'Workgroup']) {
      expect(publicParticipants).not.toContain(`${retired}AclIdentityParticipant`)
    }
    for (const retired of ['agent', 'skill', 'plugin', 'workflow', 'workgroup']) {
      expect(
        existsSync(
          resolve(
            sourceRoot,
            `modules/resource-catalog/application/participants/${retired}AclIdentity.ts`,
          ),
        ),
      ).toBe(false)
    }
    expect(publicParticipants).toContain('interface McpAclIdentityParticipant')

    const mcpComposition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/mcpOperations.ts'),
      'utf8',
    )
    const workflowComposition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/workflowOperations.ts'),
      'utf8',
    )
    const workgroupComposition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/workgroupOperations.ts'),
      'utf8',
    )
    expect(mcpComposition).toContain('transitionMcpAclRuntimeTestsInTx')
    expect(mcpComposition).toContain('runtime.reconcileDurableIntents()')
    expect(workflowComposition).toContain('workflowsBroadcaster.broadcast')
    expect(workflowComposition).toContain("type: 'workflow.acl.updated'")
    expect(workgroupComposition).toContain('workgroupsBroadcaster.broadcast')
    expect(workgroupComposition).toContain("type: 'workgroup.acl.updated'")
  })

  test('T9 retires zero-consumer W4-C public and facade debt', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const commands = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/commands.ts'),
      'utf8',
    )
    const queries = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/queries.ts'),
      'utf8',
    )
    const participants = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/participants.ts'),
      'utf8',
    )
    const publicTypes = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/types.ts'),
      'utf8',
    )
    const authorization = readFileSync(
      resolve(
        sourceRoot,
        'modules/resource-catalog/application/participants/resourceAuthorization.ts',
      ),
      'utf8',
    )
    const catalogQuery = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/sqliteCatalogQuery.ts'),
      'utf8',
    )
    const ledger = readFileSync(
      resolve(import.meta.dir, 'architecture/rfc294-review-public-consumer-ledger.test.ts'),
      'utf8',
    )
    const maintenanceWorker = readFileSync(
      resolve(sourceRoot, 'platform/background/maintenanceWorker.ts'),
      'utf8',
    )
    const daemonStart = readFileSync(resolve(sourceRoot, 'cli/start.ts'), 'utf8')
    const moduleRoot = resolve(sourceRoot, 'modules/resource-catalog')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(dir, entry.name)
        return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : []
      })
    const moduleSources = walk(moduleRoot)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
    const routeConsumerContracts = new Map<string, readonly string[]>([
      [
        'agents.ts',
        [
          'CreateAgentCatalogInput',
          'UpdateAgentCatalogInput',
          'DeleteAgentCatalogInput',
          'DeleteAgentCatalogReceipt',
          'RenameAgentCatalogInput',
          'GetResourceAclCatalogInput',
          'UpdateResourceAclCatalogInput',
        ],
      ],
      [
        'skills.ts',
        [
          'CreateSkillCatalogInput',
          'SaveSkillCatalogInput',
          'DeleteSkillCatalogInput',
          'DeleteSkillCatalogReceipt',
        ],
      ],
      [
        'mcps.ts',
        [
          'CreateMcpCatalogInput',
          'UpdateMcpCatalogInput',
          'DeleteMcpCatalogInput',
          'DeleteMcpCatalogReceipt',
          'RenameMcpCatalogInput',
        ],
      ],
      [
        'plugins.ts',
        [
          'CreatePluginCatalogInput',
          'UpdatePluginCatalogInput',
          'DeletePluginCatalogInput',
          'DeletePluginCatalogReceipt',
          'RenamePluginCatalogInput',
          'CheckPluginUpdateCatalogInput',
          'CheckPluginUpdateCatalogReceipt',
          'UpgradePluginCatalogInput',
          'UpgradePluginCatalogReceipt',
        ],
      ],
      [
        'workflows.ts',
        [
          'CreateWorkflowCatalogInput',
          'CopyWorkflowCatalogInput',
          'UpdateWorkflowCatalogInput',
          'UpdateWorkflowCatalogReceipt',
          'DeleteWorkflowCatalogInput',
          'DeleteWorkflowCatalogReceipt',
        ],
      ],
      [
        'workgroups.ts',
        [
          'CreateWorkgroupCatalogInput',
          'CopyWorkgroupCatalogInput',
          'UpdateWorkgroupCatalogInput',
          'UpdateWorkgroupCatalogReceipt',
          'DeleteWorkgroupCatalogInput',
          'DeleteWorkgroupCatalogReceipt',
          'RenameWorkgroupCatalogInput',
        ],
      ],
    ])

    expect(commands).not.toContain('ResourceAclCommands')
    for (const internalCommand of [
      'AgentCommands',
      'McpCommands',
      'PluginCommands',
      'PluginUpdateCommands',
      'SkillCommands',
      'WorkflowCommands',
      'WorkgroupCommands',
    ]) {
      expect(commands).not.toContain(`export interface ${internalCommand}`)
    }
    for (const retiredQuery of [
      'export interface ResourceAclQuery',
      'export interface ResourceAuthorizationQuery',
    ]) {
      expect(queries).not.toContain(retiredQuery)
    }
    expect(queries).toContain('export interface ResourceCatalogQuery')
    expect(participants).not.toContain('export interface ResourceAuthorizationInTx')
    for (const internalLeaf of [
      'DemoResourceCatalogWorkflowSample',
      'DemoResourceCatalogOccupiedIdWarning',
    ]) {
      expect(participants).not.toContain(`export interface ${internalLeaf}`)
    }
    expect(authorization).toContain('interface ResourceAccessEvaluator')
    expect(authorization).not.toContain('trustedResourceAuthorizations')
    expect(catalogQuery).toContain('interface SqliteResourceCatalogQuery')
    expect(catalogQuery).toContain("from '../public/queries'")
    for (const retiredExport of [
      '  ACL_CATALOG_KINDS,',
      '  CATALOG_SELECTOR_KINDS,',
      '  GRANT_TARGET_KINDS,',
      '  type GrantTargetRef,',
      '  type ResourceSummaryRevisionByKind,',
      '  type AclCatalogKind,',
      '  type CatalogResourceRef,',
      '  type GrantTargetKind,',
      '  asAclCatalogKind,',
      '  asCatalogSelectorKind,',
      '  resourceRef,',
      '  resourceSummaryRevisionEquals,',
    ]) {
      expect(publicTypes).not.toContain(retiredExport)
    }
    for (const retiredType of [
      'export interface ResourceAclTarget',
      'export interface GetResourceAclRequest',
      'export interface UpdateResourceAclRequest',
      'export type ResourceAclDocument',
      'export type WorkflowCatalogResource',
      'export type WorkgroupCatalogResource',
    ]) {
      expect(publicTypes).not.toContain(retiredType)
    }
    expect(publicTypes).toContain('export type ResourceCatalogCursor')
    expect(publicTypes).toContain('export type ResourceSummary')
    expect(publicTypes).toContain('export interface ResourceSummaryQuery')
    expect(publicTypes).toContain('export interface ResourceSummaryPage')
    for (const internalLeaf of [
      'AgentResourceDisplayRef',
      'AgentResourceDisplayIssue',
      'AgentResourceClosureIssue',
      'AgentResourceRefKind',
      'AgentResourceIssueCode',
      'AgentResourceDisplayState',
    ]) {
      expect(publicTypes).not.toContain(`export interface ${internalLeaf}`)
      expect(publicTypes).not.toContain(`export type ${internalLeaf}`)
    }
    for (const [route, contracts] of routeConsumerContracts) {
      const routeSource = readFileSync(resolve(sourceRoot, 'routes', route), 'utf8')
      for (const contract of contracts) expect(routeSource).toContain(contract)
    }
    expect(maintenanceWorker).toContain('ResourcePackageApplyMaintenanceCommand')
    expect(maintenanceWorker).toContain('resourcePackageMaintenance.command')
    expect(daemonStart).toContain('SkillCatalogBootParticipant')
    expect(daemonStart).toContain('skillCatalogBoot')
    expect(ledger).not.toContain('public:resource-catalog:')
    expect(existsSync(resolve(sourceRoot, 'services/resourceAccessPolicy.ts'))).toBe(false)
    expect(moduleSources).not.toContain("from '@/services/resourceAcl'")
  })
})
