// RFC-550 (RFC-294 S9): the shapes of the catalog modules this context composes. They sat on `public/operations` without
// any other module consuming them; their queries, commands and descriptors stay public.
import type { SkillFileCommands, SkillVersionCommands } from '../public/commands'
import type {
  AgentOperationDescriptors,
  PluginOperationDescriptors,
  SkillOperationDescriptors,
  WorkgroupOperationDescriptors,
} from '../public/operations'
import type { WorkflowOperationDescriptors } from './workflows/operationContracts'
import type { SkillZipImportParticipant } from '../public/participants'
import type {
  AgentDependencyQueries,
  AgentImportQueries,
  AgentQueries,
  AgentReferenceQueries,
  AgentResourceIntegrityQueries,
  PluginQueries,
  SkillFileQueries,
  SkillQueries,
  SkillVersionQueries,
  WorkflowQueries,
  WorkflowValidationQueries,
  WorkgroupQueries,
} from '../public/queries'

export interface AgentCatalogModule {
  readonly queries: AgentQueries
  readonly referenceQueries: AgentReferenceQueries
  readonly dependencyQueries: AgentDependencyQueries
  readonly resourceIntegrityQueries: AgentResourceIntegrityQueries
  readonly importQueries: AgentImportQueries
  readonly operations: AgentOperationDescriptors
}

export interface SkillCatalogModule {
  readonly fileCommands: SkillFileCommands
  readonly versionCommands: SkillVersionCommands
  readonly queries: SkillQueries
  readonly fileQueries: SkillFileQueries
  readonly versionQueries: SkillVersionQueries
  readonly zipImport: SkillZipImportParticipant
  readonly operations: SkillOperationDescriptors
}

export interface PluginCatalogModule {
  readonly queries: PluginQueries
  readonly operations: PluginOperationDescriptors
}

export interface WorkflowCatalogModule {
  readonly queries: WorkflowQueries
  readonly validationQueries: WorkflowValidationQueries
  readonly operations: WorkflowOperationDescriptors
}

export interface WorkgroupCatalogModule {
  readonly queries: WorkgroupQueries
  readonly operations: WorkgroupOperationDescriptors
}
