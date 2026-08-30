// RFC-345 T1 — the resource-catalog contract is additive, but it still needs
// executable drift locks: four canonical rosters, correlated summaries, four
// purpose-specific participants and seven package participants.

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
} from '@agent-workflow/shared'
import {
  ACL_CATALOG_KINDS,
  CATALOG_SELECTOR_KINDS,
  GRANT_TARGET_KINDS,
  PACKAGE_RESOURCE_KINDS,
  asAclCatalogKind,
  asCatalogSelectorKind,
  asPackageResourceKind,
  resourceRef,
  resourceSummaryRevisionEquals,
  type AclCatalogKind,
  type AgentCatalogResource,
  type AgentPackageMutation,
  type CapabilityTemplatePackageMutation,
  type CatalogSelectorKind,
  type FrozenIntegrationTriggerResourceSnapshot,
  type FrozenTaskExecutionResourceSnapshot,
  type GrantTargetKind,
  type IntegrationTriggerResourceRequest,
  type IntentResourceChangesetReceipt,
  type McpCatalogResource,
  type McpPackageMutation,
  type PackageResourceKind,
  type PluginCatalogResource,
  type PluginPackageMutation,
  type ResourceMemoryScopeRef,
  type ResourceSummary,
  type SkillPackageMutation,
  type TaskExecutionResourceRequest,
  type UpdateAgentCatalogInput,
  type UpdateMcpCatalogInput,
  type UpdatePluginCatalogInput,
  type UpdateWorkgroupCatalogInput,
  type VersionedIntentResourceChangesetPlan,
  type WorkgroupCatalogResource,
  type WorkflowPackageMutation,
  type WorkgroupPackageMutation,
} from '../src/modules/resource-catalog/public/types'
import type {
  AgentCommands,
  McpCommands,
  PluginCommands,
  PluginUpdateCommands,
  WorkgroupCommands,
} from '../src/modules/resource-catalog/public/commands'
import type {
  AgentQueries,
  AgentReferenceQueries,
  McpQueries,
  PluginQueries,
  WorkgroupQueries,
} from '../src/modules/resource-catalog/public/queries'
import type {
  AgentAclIdentityParticipant,
  IntegrationTriggerResourceSnapshotInTx,
  IntentApplyResourceParticipantInTx,
  McpAclIdentityParticipant,
  PluginAclIdentityParticipant,
  WorkgroupAclIdentityParticipant,
  ResourceAuthorizationInTx,
  ResourcePackageApplyScenarioProvider,
  ResourcePackageApplyTx,
  ResourcePackageMutationParticipants,
  ResourceScopeAuthorizationInTx,
  TaskExecutionResourceSnapshotInTx,
} from '../src/modules/resource-catalog/public/participants'
import type {
  AgentCatalogModule,
  AgentOperationDescriptors,
  McpCatalogModule,
  McpOperationDescriptors,
  PluginCatalogModule,
  PluginOperationDescriptors,
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
    keyof ResourceSummary,
    'ref' | 'kind' | 'name' | 'description' | 'revision' | 'visibilityHint'
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
assertType<
  Equal<
    Extract<keyof ResourceAuthorizationInTx, string>,
    'accessOf' | 'assertView' | 'assertEdit' | 'assertGovern'
  >
>(true)
assertType<Equal<Extract<keyof AgentCommands, string>, 'create' | 'update' | 'delete' | 'rename'>>(
  true,
)
assertType<Equal<Extract<keyof AgentQueries, string>, 'list' | 'get'>>(true)
assertType<Equal<Extract<keyof AgentReferenceQueries, string>, 'labels'>>(true)
assertType<Equal<Extract<keyof AgentAclIdentityParticipant, string>, 'load' | 'nextUpdatedAt'>>(
  true,
)
assertType<
  Equal<
    Extract<keyof AgentOperationDescriptors, string>,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'rename'
  >
>(true)
assertType<
  Equal<
    Extract<keyof AgentCatalogModule, string>,
    'commands' | 'queries' | 'referenceQueries' | 'operations' | 'participants'
  >
>(true)
assertType<Equal<Extract<keyof McpCommands, string>, 'create' | 'update' | 'delete' | 'rename'>>(
  true,
)
assertType<Equal<Extract<keyof McpQueries, string>, 'list' | 'get'>>(true)
assertType<Equal<Extract<keyof McpAclIdentityParticipant, string>, 'load' | 'nextUpdatedAt'>>(true)
assertType<
  Equal<
    Extract<keyof McpOperationDescriptors, string>,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'rename'
  >
>(true)
assertType<
  Equal<
    Extract<keyof McpCatalogModule, string>,
    'commands' | 'queries' | 'operations' | 'participants'
  >
>(true)
assertType<Equal<Extract<keyof PluginCommands, string>, 'create' | 'update' | 'delete' | 'rename'>>(
  true,
)
assertType<Equal<Extract<keyof PluginUpdateCommands, string>, 'checkUpdate' | 'upgrade'>>(true)
assertType<Equal<Extract<keyof PluginQueries, string>, 'list' | 'get'>>(true)
assertType<Equal<Extract<keyof PluginAclIdentityParticipant, string>, 'load' | 'nextUpdatedAt'>>(
  true,
)
assertType<
  Equal<
    Extract<keyof PluginOperationDescriptors, string>,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'rename' | 'checkUpdate' | 'upgrade'
  >
>(true)
assertType<
  Equal<
    Extract<keyof PluginCatalogModule, string>,
    'commands' | 'updateCommands' | 'queries' | 'operations' | 'participants'
  >
>(true)
assertType<
  Equal<
    Extract<keyof WorkgroupCommands, string>,
    'create' | 'copy' | 'update' | 'delete' | 'rename'
  >
>(true)
assertType<Equal<Extract<keyof WorkgroupQueries, string>, 'list' | 'get'>>(true)
assertType<Equal<Extract<keyof WorkgroupAclIdentityParticipant, string>, 'load' | 'nextUpdatedAt'>>(
  true,
)
assertType<
  Equal<
    Extract<keyof WorkgroupOperationDescriptors, string>,
    'list' | 'get' | 'create' | 'copy' | 'update' | 'delete' | 'rename'
  >
>(true)
assertType<
  Equal<
    Extract<keyof WorkgroupCatalogModule, string>,
    'commands' | 'queries' | 'operations' | 'participants'
  >
>(true)

const agentResourceTypeProbe: AgentCatalogResource | null = null
const agentUpdateTypeProbe: UpdateAgentCatalogInput | null = null
const mcpResourceTypeProbe: McpCatalogResource | null = null
const mcpUpdateTypeProbe: UpdateMcpCatalogInput | null = null
const pluginResourceTypeProbe: PluginCatalogResource | null = null
const pluginUpdateTypeProbe: UpdatePluginCatalogInput | null = null
const workgroupResourceTypeProbe: WorkgroupCatalogResource | null = null
const workgroupUpdateTypeProbe: UpdateWorkgroupCatalogInput | null = null
void agentResourceTypeProbe
void agentUpdateTypeProbe
void mcpResourceTypeProbe
void mcpUpdateTypeProbe
void pluginResourceTypeProbe
void pluginUpdateTypeProbe
void workgroupResourceTypeProbe
void workgroupUpdateTypeProbe

const correlatedSummary: ResourceSummary<'agent'> = {
  ref: { kind: 'agent', id: 'agent-1' },
  kind: 'agent',
  name: 'Agent',
  description: null,
  revision: { kind: 'agent', updatedAt: 1, aclRevision: 2 },
  visibilityHint: 'private',
}
void correlatedSummary

const mismatchedSummary: ResourceSummary<'agent'> = {
  ref: { kind: 'agent', id: 'agent-1' },
  kind: 'agent',
  name: 'Agent',
  description: null,
  // @ts-expect-error an agent summary cannot carry a workflow revision
  revision: { kind: 'workflow', version: 1 },
  visibilityHint: 'private',
}
void mismatchedSummary

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

  test('ACL policy, application facade and SQLite registry keep their layer boundaries', () => {
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
    expect(composition).toContain('createResourceAuthorizationApplication(grantReads)')
    expect(composition).toContain('createResourceAclApplication({')
    expect(composition).toContain('withSqliteResourceAclMutation')
    expect(composition).toContain('getAclResourceAccessRowInTx')
  })

  test('Intent selector and dump share one paged actor-visible catalog owner', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const selector = readFileSync(resolve(sourceRoot, 'services/intent/resourceCatalog.ts'), 'utf8')
    const dump = readFileSync(resolve(sourceRoot, 'services/intent/dumpBuilder.ts'), 'utf8')
    const catalog = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/infrastructure/sqliteCatalogQuery.ts'),
      'utf8',
    )
    const projections = readFileSync(
      resolve(sourceRoot, 'services/intent/resourceCatalogProjections.ts'),
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
    expect(selector).toContain('listAllVisibleResourceSummariesForActor')
    expect(dump).toContain('listAllVisibleResourceSummariesForActor')
    expect(catalog).toContain('visibleRowsCondition')
    expect(catalog).toContain('.limit(limit)')
    expect(catalog).toContain('CATALOG_SELECTOR_KINDS')
    expect(catalog).toContain('nextCursor')
    expect(catalog).not.toContain("from '@/services/")
    expect(projections).toContain('resourceCatalogProjectionDependencies')
  })

  test('T5-M active HTTP and MCP compatibility bindings execute the owned aggregate', () => {
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
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/mcpOperations.ts'),
      'utf8',
    )
    const operations = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/operations.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')
    const server = readFileSync(resolve(sourceRoot, 'server.ts'), 'utf8')
    const routeDispatcher = readFileSync(
      resolve(import.meta.dir, 'helpers/routeOperationDispatcher.ts'),
      'utf8',
    )

    expect(route).not.toContain("from '@/services/mcp'")
    expect(route).not.toContain('catalog.operations')
    expect(route).toContain(
      "import type { McpCommands } from '@/modules/resource-catalog/public/commands'",
    )
    expect(route).toContain(
      "import type { McpQueries } from '@/modules/resource-catalog/public/queries'",
    )
    expect(route).toContain('McpAclIdentityParticipant')
    for (const consumer of [
      'commands.create(',
      'commands.update(',
      'commands.delete(',
      'commands.rename(',
      'queries.list(',
      'queries.get(',
      'aclIdentity.load(',
      'aclIdentity.nextUpdatedAt(',
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
    expect(repository).toContain("import { sha256Hex } from '@/util/hash'")
    expect(repository).not.toContain("createHash('sha256')")
    expect(repository).not.toContain("from '@/services/")
    expect(composition).toContain('createSqliteMcpRepository')
    expect(composition).toContain('createMcpApplication')
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
    expect(server).toContain('composeMcpCatalog({')
    expect(server).toContain('transitionMutationInTx: transitionMcpRuntimeTestsInTx')
    expect(server).toContain('deletePreparedInTx: deletePreparedMcpRuntimeTestsInTx')
    expect(server).toContain('commands: mcpCatalog.commands')
    expect(server).toContain('queries: mcpCatalog.queries')
    expect(server).toContain('aclIdentity: mcpCatalog.participants.aclIdentity')
    expect(server).toContain('directOperationAuthority(identityAccess.directAuthority, actor)')
    expect(routeDispatcher).toContain(
      'deps.identityAccess ?? createIdentityAccessRuntime({ db: deps.db })',
    )
    expect(routeDispatcher).toContain('admitTestDirectAuthority(')
    expect(routeDispatcher).toContain('createBoundOperationInvoker(app, identity.actor)')
    expect(routeDispatcher).not.toContain('mcpTestOperationActor(actor)')

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(dir, entry.name)
        return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : []
      })
    const legacyConsumers = walk(sourceRoot)
      .filter((path) => readFileSync(path, 'utf8').includes("@/services/mcp'"))
      .map((path) => path.slice(sourceRoot.length + 1))
      .sort()
    expect(legacyConsumers).toEqual([
      'services/bundle/legacyResourcePackageMutationDependencies.ts',
      'services/intent/applyChangeset.ts',
      'services/intent/dumpBuilder.ts',
      'services/intent/resourceCatalogProjections.ts',
      'services/mcpRuntimeTest.ts',
    ])
  })

  test('T5-P active HTTP binding executes the owned aggregate and preserves exact legacy callers', () => {
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
    const composition = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/composition/pluginOperations.ts'),
      'utf8',
    )
    const operations = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/operations.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')
    const server = readFileSync(resolve(sourceRoot, 'server.ts'), 'utf8')

    expect(route).not.toContain("from '@/services/plugin'")
    expect(route).not.toContain("from '@/services/pluginInstaller'")
    expect(route).toContain('PluginCommands')
    expect(route).toContain('PluginUpdateCommands')
    expect(route).toContain('PluginQueries')
    expect(route).toContain('PluginAclIdentityParticipant')
    for (const consumer of [
      'commands.create(',
      'commands.update(',
      'commands.delete(',
      'commands.rename(',
      'updateCommands.checkUpdate(',
      'updateCommands.upgrade(',
      'queries.list(',
      'queries.get(',
      'aclIdentity.load(',
      'aclIdentity.nextUpdatedAt(',
    ]) {
      expect(route).toContain(consumer)
    }
    expect(application).toContain('coordinator.runExclusive')
    expect(application).toContain('coordinator.runDeduplicatedOperation')
    expect(application).toContain('requireResourceEdit')
    expect(application).toContain('requireResourceGovern')
    expect(application).toContain('const commands: PluginCommands = Object.freeze')
    expect(application).toContain('const updateCommands: PluginUpdateCommands = Object.freeze')
    expect(application).toContain('Object.freeze({ commands, updateCommands, queries })')
    expect(application).not.toContain("from '@/db/")
    expect(application).not.toContain('/infrastructure/')
    expect(repository).toContain('dbTxSync')
    expect(repository).toContain('fullPluginRowWhere')
    expect(repository).toContain('findAgentReferencesInTx')
    expect(repository).toContain("import { sha256Hex } from '@/util/hash'")
    expect(repository).not.toContain("createHash('sha256')")
    expect(repository).not.toContain("from '@/services/")
    expect(composition).toContain('createSqlitePluginRepository')
    expect(composition).toContain('createPluginApplication')
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
    expect(server).toContain('composePluginCatalog({')
    expect(server).toContain('commands: pluginCatalog.commands')
    expect(server).toContain('updateCommands: pluginCatalog.updateCommands')
    expect(server).toContain('queries: pluginCatalog.queries')
    expect(server).toContain('aclIdentity: pluginCatalog.participants.aclIdentity')

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(dir, entry.name)
        return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : []
      })
    const legacyConsumers = walk(sourceRoot)
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
        return (
          source.includes("@/services/plugin'") ||
          (path.endsWith('/services/pluginGenerationGc.ts') && source.includes("from './plugin'"))
        )
      })
      .map((path) => path.slice(sourceRoot.length + 1))
      .sort()
    expect(legacyConsumers).toEqual([
      'services/bundle/legacyResourcePackageMutationDependencies.ts',
      'services/intent/applyChangeset.ts',
      'services/intent/dumpBuilder.ts',
      'services/intent/resourceCatalogProjections.ts',
      'services/pluginGenerationGc.ts',
      'services/workflow.validator.ts',
    ])
  })

  test('T5-WG active HTTP binding executes the owned aggregate and preserves exact legacy callers', () => {
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
      resolve(sourceRoot, 'modules/resource-catalog/public/operations.ts'),
      'utf8',
    )
    const publicTypes = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/types.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')
    const server = readFileSync(resolve(sourceRoot, 'server.ts'), 'utf8')

    expect(route).not.toContain("from '@/services/workgroups'")
    expect(route).toContain('WorkgroupCommands')
    expect(route).toContain('WorkgroupQueries')
    expect(route).toContain('WorkgroupAclIdentityParticipant')
    for (const consumer of [
      'commands.create(',
      'commands.copy(',
      'commands.update(',
      'commands.delete(',
      'commands.rename(',
      'queries.list(',
      'queries.get(',
      'aclIdentity.load(',
    ]) {
      expect(route).toContain(consumer)
    }
    expect(publicTypes).not.toContain('readonly deletion: unknown')
    expect(publicTypes).toContain("readonly kind: 'json-body'")
    expect(publicTypes).toContain('readonly body: string')
    expect(route).not.toContain('DeleteWorkgroupSchema')
    expect(route).toContain('c.req.raw.text()')
    expect(route).toContain("deletion: { kind: 'json-body', body }")
    expect(application).toContain('requireResourceEdit')
    expect(application).toContain('requireResourceGovern')
    expect(application).toContain('DeleteWorkgroupSchema.safeParse(body)')
    expect(application).toContain('const commands: WorkgroupCommands = Object.freeze')
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
    expect(operations).toContain('inputSchema: deleteWorkgroupInputSchema')
    expect(operations).toContain("kind: 'json-body'")
    expect(operations).toContain("body: JSON.stringify(input.deletion) ?? '{}'")

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
    expect(server).toContain('composeWorkgroupCatalog({ db: effectiveDeps.db })')
    expect(server).toContain('commands: workgroupCatalog.commands')
    expect(server).toContain('queries: workgroupCatalog.queries')
    expect(server).toContain('aclIdentity: workgroupCatalog.participants.aclIdentity')

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(dir, entry.name)
        return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : []
      })
    const legacyConsumers = walk(sourceRoot)
      .filter((path) => readFileSync(path, 'utf8').includes("@/services/workgroups'"))
      .map((path) => path.slice(sourceRoot.length + 1))
      .sort()
    expect(legacyConsumers).toEqual([
      'services/bundle/legacyResourcePackageMutationDependencies.ts',
      'services/execution/closure.ts',
      'services/intent/applyChangeset.ts',
      'services/intent/dumpBuilder.ts',
      'services/scheduledTasks.ts',
      'services/workgroup/launch.ts',
    ])
  })

  test('T5-A active HTTP binding executes the owned aggregate and preserves exact legacy callers', () => {
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
      resolve(sourceRoot, 'modules/resource-catalog/public/operations.ts'),
      'utf8',
    )
    const publicTypes = readFileSync(
      resolve(sourceRoot, 'modules/resource-catalog/public/types.ts'),
      'utf8',
    )
    const mcpBindings = readFileSync(resolve(sourceRoot, 'mcp/operationBindings.ts'), 'utf8')
    const server = readFileSync(resolve(sourceRoot, 'server.ts'), 'utf8')

    expect(route).not.toContain("from '@/services/agent'")
    expect(route).toContain('AgentCommands')
    expect(route).toContain('AgentQueries')
    expect(route).toContain('AgentReferenceQueries')
    expect(route).toContain('AgentAclIdentityParticipant')
    for (const consumer of [
      'commands.create(',
      'commands.update(',
      'commands.delete(',
      'commands.rename(',
      'queries.list(',
      'queries.get(',
      'referenceQueries.labels(',
      'aclIdentity.load(',
      'aclIdentity.nextUpdatedAt(',
    ]) {
      expect(route).toContain(consumer)
    }
    expect(publicTypes).not.toContain('readonly submission: unknown')
    expect(publicTypes).toContain("readonly kind: 'json-body'")
    expect(publicTypes).toContain('readonly body: string')
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
    expect(application).toContain('const commands: AgentCommands = Object.freeze')
    expect(application).toContain('const queries: AgentQueries = Object.freeze')
    expect(application).toContain('const referenceQueries: AgentReferenceQueries = Object.freeze')
    expect(application).not.toContain("from '@/db/")
    expect(application).not.toContain('/infrastructure/')
    expect(repository).toContain("from '@/services/agent'")
    expect(repository).toContain('explicit compatibility island')
    expect(repository).toContain('loadClosureRefNames(')
    expect(composition).toContain('createSqliteAgentRepository')
    expect(composition).toContain('createAgentApplication')
    expect(composition).toContain('createAgentAclIdentityParticipant')

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
    expect(operations).toContain("submission: { kind: 'json-body'")
    expect(server).toContain('composeAgentCatalog({ db: effectiveDeps.db })')
    expect(server).toContain('commands: agentCatalog.commands')
    expect(server).toContain('queries: agentCatalog.queries')
    expect(server).toContain('referenceQueries: agentCatalog.referenceQueries')
    expect(server).toContain('aclIdentity: agentCatalog.participants.aclIdentity')

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(dir, entry.name)
        return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : []
      })
    const legacyConsumers = walk(sourceRoot)
      .filter((path) => readFileSync(path, 'utf8').includes("@/services/agent'"))
      .map((path) => path.slice(sourceRoot.length + 1))
      .sort()
    expect(legacyConsumers).toEqual([
      'modules/execution-contract/infrastructure/taskExecutionAdapter.ts',
      'modules/resource-catalog/infrastructure/sqliteAgentRepository.ts',
      'modules/task-execution/composition/agentActionExecution.ts',
      'modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog.ts',
      'modules/task-execution/composition/digitalEmployeeExecution.ts',
      'services/agentLaunch.ts',
      'services/agentResourceIntegrity.ts',
      'services/bundle/legacyResourcePackageMutationDependencies.ts',
      'services/codeReviewAgentCaller.ts',
      'services/demoSeed.ts',
      'services/dynamicWorkflowRunner.ts',
      'services/fusion.ts',
      'services/intent/applyChangeset.ts',
      'services/intent/dumpBuilder.ts',
      'services/ref/runtimeRef.ts',
      'services/review.ts',
      'services/scheduledTasks.ts',
      'services/workflow.validator.ts',
      'services/workgroup/memberTurns.ts',
      'services/workgroup/state.ts',
    ])
  })

  test('BundleApply keeps lifecycle ownership while seven writer arms stay in infrastructure', () => {
    const sourceRoot = resolve(import.meta.dir, '../src')
    const engine = readFileSync(resolve(sourceRoot, 'services/bundle/apply.ts'), 'utf8')
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

    expect(engine).toContain('createLegacyResourcePackageMutationAdapter')
    expect(engine).toContain('resourceBundleApplies')
    expect(engine).toContain("state: 'applying'")
    expect(engine).toContain('provider.revalidateInTx?.(tx)')
    expect(engine).toContain('provider.finalizeInTx?.(tx, receiptValue)')
    expect(engine).toContain('ACTIVE_BUNDLE_APPLIES')
    expect(engine).toContain('convergeResourceBundleApplies')

    for (const legacyWriter of [
      "@/services/agent'",
      "@/services/skill'",
      "@/services/skillVersion'",
      "@/services/mcp'",
      "@/services/plugin'",
      "@/services/pluginInstaller'",
      "@/services/workflow'",
      "@/services/workgroups'",
      "@/services/capabilityTemplates'",
    ]) {
      expect(engine).not.toContain(legacyWriter)
      expect(adapter).not.toContain(legacyWriter)
      expect(dependencies).toContain(legacyWriter)
    }
    expect(adapter).not.toContain("from '@/services/")
    expect(engine).toContain('legacyResourcePackageMutationDependencies')

    for (const participant of [
      'agents:',
      'skills:',
      'mcps:',
      'plugins:',
      'workflows:',
      'workgroups:',
      'capabilityTemplates:',
    ]) {
      expect(adapter).toContain(participant)
    }
  })
})
