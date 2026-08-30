// RFC-345 T1 — the resource-catalog contract is additive, but it still needs
// executable drift locks: four canonical rosters, correlated summaries, four
// purpose-specific participants and seven package participants.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
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
  type AgentPackageMutation,
  type CapabilityTemplatePackageMutation,
  type CatalogSelectorKind,
  type FrozenIntegrationTriggerResourceSnapshot,
  type FrozenTaskExecutionResourceSnapshot,
  type GrantTargetKind,
  type IntegrationTriggerResourceRequest,
  type IntentResourceChangesetReceipt,
  type McpPackageMutation,
  type PackageResourceKind,
  type PluginPackageMutation,
  type ResourceMemoryScopeRef,
  type ResourceSummary,
  type SkillPackageMutation,
  type TaskExecutionResourceRequest,
  type VersionedIntentResourceChangesetPlan,
  type WorkflowPackageMutation,
  type WorkgroupPackageMutation,
} from '../src/modules/resource-catalog/public/types'
import type {
  IntegrationTriggerResourceSnapshotInTx,
  IntentApplyResourceParticipantInTx,
  ResourceAuthorizationInTx,
  ResourcePackageApplyScenarioProvider,
  ResourcePackageApplyTx,
  ResourcePackageMutationParticipants,
  ResourceScopeAuthorizationInTx,
  TaskExecutionResourceSnapshotInTx,
} from '../src/modules/resource-catalog/public/participants'
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
    keyof ResourcePackageApplyTx,
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
assertType<Equal<keyof TaskExecutionResourceSnapshotInTx, 'loadAuthorized'>>(true)
assertType<Equal<keyof IntentApplyResourceParticipantInTx, 'authorizeAndCommit'>>(true)
assertType<Equal<keyof IntegrationTriggerResourceSnapshotInTx, 'loadAuthorized'>>(true)
assertType<Equal<keyof ResourceScopeAuthorizationInTx, 'accessOf'>>(true)
assertType<
  Equal<keyof ResourceAuthorizationInTx, 'accessOf' | 'assertView' | 'assertEdit' | 'assertGovern'>
>(true)

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
      expect(adapter).toContain(legacyWriter)
    }

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
