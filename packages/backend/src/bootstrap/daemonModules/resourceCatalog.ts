import { composeSubjectTaskReferencePort } from '@/modules/task-execution/composition'
import type { AclResourceType, UpdateResourceAclBody } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  composeCapabilityTemplateOperations,
  createCapabilityTemplatePersistence,
} from '@/modules/code-capability/composition/capabilityTemplateOperations'
import {
  composeDevelopmentConfigOperationsFor,
  type DevelopmentConfigResourceAccess,
} from '@/modules/development-automation/composition/configOperations'
import {
  composeDigitalEmployeeAgentTemplateCatalogParticipant,
  createDigitalEmployeeResourceCatalogAclProviders,
} from '@/modules/digital-employee/composition'
import { composeDevelopmentAdapterConfigOperationsFor } from '@/modules/integration/composition/developmentAdapterConfigOperations'
import { createAsyncSkillRestoreMembership } from '@/modules/knowledge-evolution/public/participants'
import { composeSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { composeClassicCatalogs } from '@/modules/resource-catalog/composition/classicCatalogs'
import { composeDigitalEmployeeAgentTemplateCatalogFor } from '@/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import {
  composeMcpCatalog,
  mcpAclRuntimeTestLifecycle,
} from '@/modules/resource-catalog/composition/mcpOperations'
import { composeMcpProbeStore } from '@/modules/resource-catalog/composition/mcpProbeStore'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import {
  composePluginCatalog,
  type PluginInstallerPort,
} from '@/modules/resource-catalog/composition/pluginOperations'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import {
  composeForeignResourceAclFor,
  composeOwnedResourceAclEndpoints,
} from '@/modules/resource-catalog/composition/resourceAcl'
import { composeSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { selectSkillContentDependencies } from '@/modules/resource-catalog/composition/skillContentBinding'
import { composeWorkgroupCatalog } from '@/modules/resource-catalog/composition/workgroupOperations'
import { type McpCatalogModule } from '@/modules/resource-catalog/public/operations'
import { type SkillCatalogBootParticipant } from '@/modules/resource-catalog/public/participants'
import { mcpRouteNow } from '@/routes/mcps'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import { getProbeByMcpId } from '@/services/mcpProbeStore'
import {
  mcpOperationCoordinator,
  pluginOperationCoordinator,
} from '@/services/resourceOperationCoordinator'

type ResourceAclRow = Parameters<
  ReturnType<typeof composeResourceCatalogFor>['authorization']['canViewResource']
>[2]
type DigitalEmployeeAclResourceType = Extract<
  AclResourceType,
  'employee_definition' | 'employee_tool' | 'employee_job_template'
>

export function composeDaemonResourceCatalogModules(input: {
  readonly db: PersistenceDb
  readonly skillContentRoot: string
  readonly skillContent?: Parameters<typeof selectSkillContentDependencies>[0]
  readonly pluginInstaller?: PluginInstallerPort
  readonly runtimeProfiles: Parameters<typeof composeClassicCatalogs>[0]['runtimeProfiles']
  readonly mcpRuntime: Parameters<typeof composeMcpCatalog>[0]['runtime']
}) {
  const db = input.db
  const resourceCatalog = composeResourceCatalogFor({
    db,
    lifecycle: mcpAclRuntimeTestLifecycle(),
  })
  const classicCatalogs = composeClassicCatalogs({
    taskReferences: composeSubjectTaskReferencePort,
    db,
    ...selectSkillContentDependencies(input.skillContent, input.skillContentRoot),
    runtimeProfiles: input.runtimeProfiles,
    // The owner of memory membership supplies the same restore participant to
    // both providers; constructing this bundle performs no database or file IO.
    restoreMembership: createAsyncSkillRestoreMembership(
      composeSkillMemoryFusionParticipantFactory(),
    ),
    resourceCatalog,
  })
  const skillCatalogBoot: SkillCatalogBootParticipant = composeSkillCatalogBoot({
    db,
    ...selectSkillContentDependencies(input.skillContent, input.skillContentRoot),
  })
  const digitalEmployeeAgentTemplates = composeDigitalEmployeeAgentTemplateCatalogFor(
    db,
    composeDigitalEmployeeAgentTemplateCatalogParticipant,
  )

  const mcpProbeStore = composeMcpProbeStore(db)
  const mcpTransactionLifecycle = createMcpTransactionLifecycle()
  const mcpCatalog: McpCatalogModule = composeMcpCatalog({
    db,
    lifecycle: mcpTransactionLifecycle,
    resourceCatalog,
    coordinator: mcpOperationCoordinator,
    nextMutationTimestamp: async (mcp) => {
      const persisted = await getProbeByMcpId(mcpProbeStore, mcp.id)
      return mcpOperationCoordinator.nextCausalTimestamp(mcp.id, mcpRouteNow(), [
        mcp.updatedAt + 1,
        (persisted?.startedAt ?? 0) + 1,
        mcpOperationCoordinator.activeLastStartedAt(mcp.id) + 1,
      ])
    },
    runtime: input.mcpRuntime,
  })
  const agentCatalog = classicCatalogs.agent
  const skillCatalog = classicCatalogs.skill
  const pluginCatalog = composePluginCatalog({
    db,
    resourceCatalog,
    coordinator: pluginOperationCoordinator,
    installer: input.pluginInstaller,
  })
  const workflowCatalog = classicCatalogs.workflow
  const workgroupCatalog = composeWorkgroupCatalog({
    db,
    resourceCatalog,
    taskReferences: composeSubjectTaskReferencePort,
  })
  const capabilityTemplateAccess: Parameters<
    typeof composeCapabilityTemplateOperations
  >[0]['access'] = {
    filterVisible(actor, rows) {
      return resourceCatalog.authorization.filterVisibleRows(actor, 'capability_template', rows)
    },
    canView(actor, row) {
      return resourceCatalog.authorization.canViewResource(actor, 'capability_template', row)
    },
    requireEdit(actor, row) {
      return resourceCatalog.authorization.requireResourceEdit(actor, 'capability_template', row)
    },
    requireGovern(actor, row) {
      return resourceCatalog.authorization.requireResourceGovern(actor, 'capability_template', row)
    },
    assertNameUnchangedForEditor: resourceCatalog.authorization.assertNameUnchangedForEditor,
  }
  const capabilityTemplateOperations = composeCapabilityTemplateOperations({
    db,
    access: capabilityTemplateAccess,
  })
  const developmentConfigAccess: DevelopmentConfigResourceAccess = {
    filterVisible(actor, type, rows) {
      return resourceCatalog.authorization.filterVisibleRows(actor, type, rows)
    },
    canView(actor, type, row) {
      return resourceCatalog.authorization.canViewResource(actor, type, row)
    },
    requireEdit(actor, type, row) {
      return resourceCatalog.authorization.requireResourceEdit(actor, type, row)
    },
    requireGovern(actor, type, row) {
      return resourceCatalog.authorization.requireResourceGovern(actor, type, row)
    },
    assertNameUnchangedForEditor: resourceCatalog.authorization.assertNameUnchangedForEditor,
  }
  // RFC-359 W4-D6：development-adapter 配置一份装配，两个 provider 共用。
  const developmentAdapterConfigOperations = composeDevelopmentAdapterConfigOperationsFor({
    db,
    access: developmentConfigAccess,
    grants: resourceCatalog.persistence.grants,
  })
  const developmentConfigOperations = composeDevelopmentConfigOperationsFor({
    db,
    developmentAdapter: developmentAdapterConfigOperations,
    access: developmentConfigAccess,
  })
  const ownedAcl = composeOwnedResourceAclEndpoints(resourceCatalog)
  const capabilityTemplatePersistence = createCapabilityTemplatePersistence(db)
  const capabilityTemplateAcl = Object.freeze({
    load: (id: string) => capabilityTemplatePersistence.load(id),
    canView: (actor: Actor, row: ResourceAclRow) =>
      resourceCatalog.authorization.canViewResource(actor, 'capability_template', row),
    read: (actor: Actor, row: ResourceAclRow) =>
      ownedAcl.getResourceAcl(actor, 'capability_template', row),
    update: (actor: Actor, row: ResourceAclRow, body: UpdateResourceAclBody, updatedAt?: number) =>
      ownedAcl.updateResourceAcl(actor, 'capability_template', row, body, {
        ...(updatedAt === undefined ? {} : { updatedAt }),
      }),
  })
  const developmentAdapterAcl = composeForeignResourceAclFor({
    db,
    identity: developmentAdapterConfigOperations.resourceAclIdentity,
  })
  const digitalEmployeeAclIdentityProviders = createDigitalEmployeeResourceCatalogAclProviders(db)
  const digitalEmployeeAcl = Object.freeze({
    employee_definition: composeForeignResourceAclFor({
      db,
      identity: digitalEmployeeAclIdentityProviders.employeeDefinition,
    }),
    employee_tool: composeForeignResourceAclFor({
      db,
      identity: digitalEmployeeAclIdentityProviders.employeeTool,
    }),
    employee_job_template: composeForeignResourceAclFor({
      db,
      identity: digitalEmployeeAclIdentityProviders.employeeJobTemplate,
    }),
  })
  const developmentAclRoutes = Object.freeze({
    mount(request: {
      readonly app: Parameters<typeof mountAclEndpoints>[0]
      readonly type: AclResourceType
      readonly base: string
      readonly notFoundCode: string
      readonly load: (id: string) => Promise<ResourceAclRow | null>
    }) {
      mountAclEndpoints(request.app, {
        type: request.type,
        base: request.base,
        param: 'id',
        load: request.load,
        canView: (actor, row) =>
          resourceCatalog.authorization.canViewResource(actor, request.type, row),
        read: (actor, row) => {
          const type = request.type
          if (type === 'development_adapter')
            return developmentAdapterAcl.getResourceAcl(actor, type, row)
          if (isDigitalEmployeeAclType(type))
            return digitalEmployeeAcl[type].getResourceAcl(actor, type, row)
          return ownedAcl.getResourceAcl(actor, type, row)
        },
        update: (actor, row, body, updatedAt) => {
          const type = request.type
          const options = { ...(updatedAt === undefined ? {} : { updatedAt }) }
          if (type === 'development_adapter')
            return developmentAdapterAcl.updateResourceAcl(actor, type, row, body, options)
          if (isDigitalEmployeeAclType(type))
            return digitalEmployeeAcl[type].updateResourceAcl(actor, type, row, body, options)
          return ownedAcl.updateResourceAcl(actor, type, row, body, options)
        },
        notFoundCode: request.notFoundCode,
      })
    },
  })
  return Object.freeze({
    resourceCatalog,
    classicCatalogs,
    agentResourceIntegrity: classicCatalogs.agentResourceIntegrity,
    skillCatalogBoot,
    mcpProbeStore,
    mcpTransactionLifecycle,
    mcpCatalog,
    agentCatalog,
    skillCatalog,
    pluginCatalog,
    workflowCatalog,
    workgroupCatalog,
    capabilityTemplateOperations,
    capabilityTemplateAcl,
    developmentAdapterConfigOperations,
    developmentConfigOperations,
    developmentAdapterAcl,
    digitalEmployeeAcl,
    developmentAclRoutes,
    digitalEmployeeAgentTemplates,
  })
}

function isDigitalEmployeeAclType(type: string): type is DigitalEmployeeAclResourceType {
  return (
    type === 'employee_definition' || type === 'employee_tool' || type === 'employee_job_template'
  )
}
export type DaemonResourceCatalogModules = ReturnType<typeof composeDaemonResourceCatalogModules>
