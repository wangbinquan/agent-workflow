import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '../src')
const source = (relative: string): string => readFileSync(resolve(sourceRoot, relative), 'utf8')

describe('RFC-345 provider-neutral classic compatibility cutover', () => {
  test('Agent compatibility facade delegates SQLite mechanics to owner infrastructure', () => {
    const facade = source('services/agent.ts')
    const implementation = source('modules/resource-catalog/infrastructure/legacy/agent.ts')
    const repository = source('modules/resource-catalog/infrastructure/sqliteAgentRepository.ts')

    expect(facade).toContain('RFC-345 compatibility facade')
    expect(facade).toContain('@/modules/resource-catalog/infrastructure/legacy/agent')
    expect(facade).not.toMatch(/@\/db|drizzle-orm|dbTxSync|DbClient|DbTxSync/)
    expect(implementation).toContain("from '@/db/schema'")
    expect(repository).toContain("from './legacy/agent'")
    expect(repository).not.toContain("from '@/services/agent'")
  })

  test('Agent ancillary transport consumes named provider-neutral queries', () => {
    const route = source('routes/agents.ts')

    expect(route).toContain('readonly dependencyQueries: AgentDependencyQueries')
    expect(route).toContain('readonly resourceIntegrityQueries: AgentResourceIntegrityQueries')
    expect(route).toContain('readonly importQueries: AgentImportQueries')
    expect(route).toContain(
      'readonly listDigitalEmployeeTemplates: () => Promise<readonly AgentCatalogResource[]>',
    )
    expect(route).toContain('dependencyQueries.closure(')
    expect(route).toContain('dependencyQueries.resolveUsableIds(')
    expect(route).toContain('dependencyQueries.validate(')
    expect(route).toContain('resourceIntegrityQueries.status(')
    expect(route).toContain('importQueries.resolve(')
    expect(route).toContain('module.listDigitalEmployeeTemplates()')
    expect(route).not.toMatch(
      /@\/services\/(?:agentDeps|agentResourceIntegrity|importRefs|resourceRefs)/,
    )
  })

  test('Agent dependency traversal is application-owned and provider-neutral', () => {
    const application = source('modules/resource-catalog/application/agents/agentApplication.ts')
    const composition = source('modules/resource-catalog/composition/agentOperations.ts')
    const queryContract = source('modules/resource-catalog/public/queries.ts')

    expect(queryContract).toContain('export interface AgentDependencyQueries')
    expect(application).toContain('const dependencyQueries: AgentDependencyQueries')
    expect(application).toContain('deps.repository.get(')
    expect(application).toContain('deps.access.canView(')
    expect(application).not.toMatch(/@\/db|drizzle-orm|dbTxSync|DbClient|DbTxSync/)
    expect(composition).toContain('readonly importQueries: AgentImportQueries')
    expect(composition).toContain(
      'readonly resourceIntegrityQueries: AgentResourceIntegrityQueries',
    )
    const integrity = source(
      'modules/resource-catalog/application/agents/agentResourceIntegrity.ts',
    )
    expect(integrity).toContain('createAgentResourceIntegrityQueries(')
    expect(integrity).toContain('createAgentLaunchResourceIntegrityParticipant(')
    expect(integrity).not.toMatch(/@\/db|drizzle-orm|dbTxSync|DbClient|DbTxSync/)
    const integrityComposition = source(
      'modules/resource-catalog/composition/agentResourceIntegrity.ts',
    )
    expect(integrityComposition).toContain('composeAgentResourceInventorySource(')
    expect(
      source('modules/resource-catalog/infrastructure/sqliteAgentResourceInventory.ts'),
    ).toContain('createSqliteAgentResourceInventoryReadPort(')
    expect(
      source('modules/resource-catalog/infrastructure/postgresqlAgentResourceInventory.ts'),
    ).toContain('createPostgresqlAgentResourceInventoryReadPort(')
  })

  test('public operations no longer republishes internal compatibility mechanics', () => {
    const operations = source('modules/resource-catalog/public/operations.ts')
    const facade = source('services/resourceAcl.ts')

    expect(operations).not.toMatch(/from ['"]\.\.\/(?:application|composition|infrastructure)\//)
    expect(operations).not.toContain('compatibility surface')
    expect(facade).toContain('exact compatibility facade')
    expect(facade).not.toMatch(/from ['"](?:@\/db|drizzle-orm)/)
    expect(facade).not.toMatch(/\b(?:DbClient|DbTxSync|dbTxSync)\b/)
    expect(facade).toContain('updateResourceAclComposition')
  })

  test('retained ancillary helpers are neutral while consumer-zero facades retire', () => {
    for (const relative of ['services/agentDeps.ts', 'services/pluginClosure.ts']) {
      const helper = source(relative)
      expect(helper, relative).not.toMatch(/from ['"](?:@\/db|drizzle-orm)/)
    }
    expect(existsSync(resolve(sourceRoot, 'services/agentRefs.ts'))).toBe(false)
    expect(source('services/agentDeps.ts')).toContain('lookup: AgentDependencyLookup')
    expect(
      source('modules/resource-catalog/application/agents/agentDependencyValidation.ts'),
    ).toContain('reader: AgentDependencyReader')
    expect(source('modules/resource-catalog/infrastructure/legacy/agent.ts')).toContain(
      "from '../../application/agents/agentDependencyValidation'",
    )
    expect(source('modules/resource-catalog/application/agents/agentReferences.ts')).toContain(
      'resolver: AgentReferenceResolver',
    )
    const publicParticipants = source('modules/resource-catalog/public/participants.ts')
    expect(publicParticipants).toContain('export interface AgentLaunchResourceIntegrityParticipant')
    expect(publicParticipants).toContain(
      'assertUsable(input: GetAgentResourceClosureStatusInput): Promise<void>',
    )
    for (const consumer of ['services/agentLaunch.ts', 'services/execution/executor.ts']) {
      expect(source(consumer), consumer).not.toContain(
        '@/modules/resource-catalog/application/agents/ports',
      )
    }
    expect(source('services/pluginClosure.ts')).toContain('query: PluginClosureQuery')
  })

  test('Workflow validation and D15 admission are provider-owned queries', () => {
    const route = source('routes/workflows.ts')
    const application = source(
      'modules/resource-catalog/application/workflows/workflowValidation.ts',
    )
    const composition = source('modules/resource-catalog/composition/workflowOperations.ts')

    expect(route).toContain('readonly validationQueries: WorkflowValidationQueries')
    expect(route).toContain('module.validationQueries.validateStored(')
    expect(route).toContain('module.validationQueries.validateDraft(')
    expect(route).not.toMatch(/@\/services\/(?:workflow\.validator|resourceRefs)/)
    expect(application).toContain('dependencies.admission.assertUsable(')
    expect(application).toContain("resourceType: 'workflow' as const")
    expect(application).not.toMatch(/@\/db|drizzle-orm|DbClient|DbTxSync/)
    expect(composition).toContain('createSqliteWorkflowValidationPort')
    expect(composition).toContain('createPostgresqlWorkflowValidationPort')
  })

  test('Skill ZIP route consumes one provider-bound whole-tree participant', () => {
    const route = source('routes/skills.ts')
    const codec = source('modules/resource-catalog/infrastructure/legacy/skill-zip.ts')

    expect(route).toContain('readonly zipImport: SkillZipImportParticipant')
    expect(route).toContain('module.zipImport.parse(')
    expect(route).toContain('module.zipImport.commit(')
    expect(route).not.toMatch(/@\/services\/skill-zip|\bdeps\.db\b|\bDbClient\b/)
    expect(codec).toContain('export function decodeZip')
    // RFC-345 T9: `services/skill-zip.ts` was deleted once its last production
    // consumer (the resource-package parser) read the codec from this module,
    // so the route must reach the archive only through the participant.
    expect(route).not.toMatch(/parseSkillZipBuffer|commitSkillZipBuffer/)
  })

  test('Agent and Workgroup launch transports consume required provider-neutral task bindings', () => {
    const agent = source('routes/agents.ts')
    const workgroup = source('routes/workgroups.ts')

    expect(agent).toContain('readonly taskLaunch: AgentRouteTaskLaunchOperations')
    expect(agent).toContain('module.taskLaunch.assertReplayVisible(')
    expect(agent).toContain('module.taskLaunch.launch(')
    expect(workgroup).toContain('readonly taskLaunch: WorkgroupRouteTaskLaunchOperations')
    expect(workgroup).toContain('module.taskLaunch.assertReplayVisible(')
    expect(workgroup).toContain('module.taskLaunch.launch(')
    for (const route of [agent, workgroup]) {
      expect(route).not.toMatch(/\bAppDeps\b|\bdeps\.db\b|\bDbClient\b/)
      expect(route).not.toMatch(/@\/services\/(?:taskCollab|startTaskDeps|execution\/executor)/)
    }
  })

  test('all classic HTTP routes mount only closed Resource Catalog dependencies', () => {
    for (const routeName of [
      'agents',
      'skills',
      'mcps',
      'plugins',
      'workflows',
      'workgroups',
      'resourcePackages',
      'resourceAcl',
    ]) {
      const route = source(`routes/${routeName}.ts`)
      expect(route, routeName).not.toMatch(/\bAppDeps\b|\bDbClient\b|\bdeps\.db\b/)
      expect(route, routeName).not.toMatch(/from ['"](?:@\/db\/|drizzle-orm)/)
    }
  })
})
