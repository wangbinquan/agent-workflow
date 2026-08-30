// RFC-345 compatibility operations. Legacy inbound/service adapters consume
// this exact entrypoint while their call sites move to the data-only command,
// query and participant contracts.

import {
  McpLocalConfigSchema,
  McpLocalConfigWriteSchema,
  McpNameSchema,
  McpRemoteConfigSchema,
  OperationConfigHashSchema,
  CreatePluginSchema,
  DeletePluginSchema,
  PluginOperationRequestSchema,
  PluginOperationResourceSchema,
  PluginUpdateCheckSchema,
  PluginUpgradeResultSchema,
  RenamePluginRequestSchema,
  ResourceVisibilitySchema,
  UpdatePluginRequestSchema,
} from '@agent-workflow/shared'
import { z } from 'zod'
import { defineCommandOperation, defineQueryOperation } from '@/platform/operations/definitions'
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type { McpCommands, PluginCommands } from './commands'
import type {
  McpAclIdentityParticipant,
  McpOperationContext,
  PluginAclIdentityParticipant,
  PluginOperationContext,
} from './participants'
import type { McpQueries, PluginQueries } from './queries'
import type {
  CheckPluginUpdateCatalogInput,
  CheckPluginUpdateCatalogReceipt,
  CreateMcpCatalogInput,
  CreatePluginCatalogInput,
  DeleteMcpCatalogInput,
  DeleteMcpCatalogReceipt,
  DeletePluginCatalogInput,
  DeletePluginCatalogReceipt,
  GetMcpCatalogInput,
  GetPluginCatalogInput,
  McpCatalogResource,
  PluginCatalogResource,
  RenameMcpCatalogInput,
  RenamePluginCatalogInput,
  UpdateMcpCatalogInput,
  UpdatePluginCatalogInput,
  UpgradePluginCatalogInput,
  UpgradePluginCatalogReceipt,
} from './types'

const MCP_PUBLIC_ERRORS = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)

const emptyMcpInputSchema = z.object({}).strict()
const getMcpInputSchema = z.object({ id: z.string().min(1) }).strict()
const exactCreateMcpSchema = z.discriminatedUnion('type', [
  z
    .object({
      name: McpNameSchema,
      description: z.string().default(''),
      type: z.literal('local'),
      config: McpLocalConfigWriteSchema,
      enabled: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      name: McpNameSchema,
      description: z.string().default(''),
      type: z.literal('remote'),
      config: McpRemoteConfigSchema,
      enabled: z.boolean().default(true),
    })
    .strict(),
])
const exactUpdateMcpSchema = z.union([
  z
    .object({
      description: z.string().optional(),
      type: z.literal('local').optional(),
      config: McpLocalConfigWriteSchema.optional(),
      enabled: z.boolean().optional(),
      expectedConfigHash: OperationConfigHashSchema,
    })
    .strict(),
  z
    .object({
      description: z.string().optional(),
      type: z.literal('remote').optional(),
      config: McpRemoteConfigSchema.optional(),
      enabled: z.boolean().optional(),
      expectedConfigHash: OperationConfigHashSchema,
    })
    .strict(),
])
const updateMcpInputSchema = z
  .object({ id: z.string().min(1), update: exactUpdateMcpSchema })
  .strict()
const deleteMcpInputSchema = z
  .object({
    id: z.string().min(1),
    deletion: z
      .object({
        confirm: z.string().optional(),
        expectedConfigHash: OperationConfigHashSchema,
      })
      .strict(),
  })
  .strict()
const renameMcpInputSchema = z
  .object({
    id: z.string().min(1),
    rename: z
      .object({
        newName: McpNameSchema,
        expectedConfigHash: OperationConfigHashSchema,
      })
      .strict(),
  })
  .strict()

const mcpResourceBase = {
  id: z.string(),
  name: McpNameSchema,
  description: z.string(),
  ownerUserId: z.string().nullable().optional(),
  visibility: ResourceVisibilitySchema.optional(),
  aclRevision: z.number().int().nonnegative().optional(),
  enabled: z.boolean(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  operationConfigHash: OperationConfigHashSchema,
} as const
const exactMcpResourceSchema = z.discriminatedUnion('type', [
  z.object({ ...mcpResourceBase, type: z.literal('local'), config: McpLocalConfigSchema }).strict(),
  z
    .object({ ...mcpResourceBase, type: z.literal('remote'), config: McpRemoteConfigSchema })
    .strict(),
])
const deleteMcpReceiptSchema = z.object({ deleted: exactMcpResourceSchema }).strict()

export interface McpOperationDescriptors {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    McpCatalogResource[],
    McpOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetMcpCatalogInput,
    McpCatalogResource | null,
    McpOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateMcpCatalogInput,
    McpCatalogResource,
    McpOperationContext
  >
  readonly update: CommandOperationDescriptor<
    UpdateMcpCatalogInput,
    McpCatalogResource,
    McpOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteMcpCatalogInput,
    DeleteMcpCatalogReceipt,
    McpOperationContext
  >
  readonly rename: CommandOperationDescriptor<
    RenameMcpCatalogInput,
    McpCatalogResource,
    McpOperationContext
  >
}

export interface McpCatalogModule {
  readonly commands: McpCommands
  readonly queries: McpQueries
  readonly operations: McpOperationDescriptors
  readonly participants: Readonly<{
    aclIdentity: McpAclIdentityParticipant
  }>
}

export function createMcpOperationDescriptors(
  commands: McpCommands,
  queries: McpQueries,
): McpOperationDescriptors {
  return Object.freeze({
    list: defineQueryOperation({
      id: 'mcp-catalog.list-mcps.v1',
      summary: 'List MCP servers visible to the caller',
      permissions: ['mcps:read'],
      publicErrors: MCP_PUBLIC_ERRORS,
      inputSchema: emptyMcpInputSchema,
      outputSchema: z.array(exactMcpResourceSchema),
      invoke: async (authority: McpOperationContext) => [...(await queries.list(authority))],
    }),
    get: defineQueryOperation({
      id: 'mcp-catalog.get-mcp.v1',
      summary: 'Get one MCP server',
      permissions: ['mcps:read'],
      publicErrors: MCP_PUBLIC_ERRORS,
      inputSchema: getMcpInputSchema,
      outputSchema: exactMcpResourceSchema.nullable(),
      invoke: (authority: McpOperationContext, input: GetMcpCatalogInput) =>
        queries.get(authority, input),
    }),
    create: defineCommandOperation({
      id: 'mcp-catalog.create-mcp.v1',
      summary: 'Create an MCP server',
      permissions: ['mcps:create'],
      publicErrors: MCP_PUBLIC_ERRORS,
      inputSchema: exactCreateMcpSchema,
      outputSchema: exactMcpResourceSchema,
      invoke: (authority: McpOperationContext, input: CreateMcpCatalogInput) =>
        commands.create(authority, input),
    }),
    update: defineCommandOperation({
      id: 'mcp-catalog.update-mcp.v1',
      summary: 'Replace an MCP server',
      permissions: ['mcps:update'],
      publicErrors: MCP_PUBLIC_ERRORS,
      inputSchema: updateMcpInputSchema,
      outputSchema: exactMcpResourceSchema,
      invoke: (authority: McpOperationContext, input: UpdateMcpCatalogInput) =>
        commands.update(authority, input),
    }),
    delete: defineCommandOperation({
      id: 'mcp-catalog.delete-mcp.v1',
      summary: 'Delete an MCP server',
      permissions: ['mcps:delete'],
      publicErrors: MCP_PUBLIC_ERRORS,
      inputSchema: deleteMcpInputSchema,
      outputSchema: deleteMcpReceiptSchema,
      invoke: (authority: McpOperationContext, input: DeleteMcpCatalogInput) =>
        commands.delete(authority, input),
    }),
    rename: defineCommandOperation({
      id: 'mcp-catalog.rename-mcp.v1',
      summary: 'Rename an MCP server',
      permissions: ['mcps:update'],
      publicErrors: MCP_PUBLIC_ERRORS,
      inputSchema: renameMcpInputSchema,
      outputSchema: exactMcpResourceSchema,
      invoke: (authority: McpOperationContext, input: RenameMcpCatalogInput) =>
        commands.rename(authority, input),
    }),
  })
}

const PLUGIN_PUBLIC_ERRORS = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)

const emptyPluginInputSchema = z.object({}).strict()
const getPluginInputSchema = z.object({ id: z.string().min(1) }).strict()
const updatePluginInputSchema = z
  .object({ id: z.string().min(1), update: UpdatePluginRequestSchema })
  .strict()
const deletePluginInputSchema = z
  .object({ id: z.string().min(1), deletion: DeletePluginSchema })
  .strict()
const renamePluginInputSchema = z
  .object({ id: z.string().min(1), rename: RenamePluginRequestSchema })
  .strict()
const checkPluginUpdateInputSchema = z
  .object({ id: z.string().min(1), operation: PluginOperationRequestSchema })
  .strict()
const upgradePluginInputSchema = z
  .object({ id: z.string().min(1), operation: PluginOperationRequestSchema })
  .strict()
const deletePluginReceiptSchema = z.object({ deleted: PluginOperationResourceSchema }).strict()

export interface PluginOperationDescriptors {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    PluginCatalogResource[],
    PluginOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetPluginCatalogInput,
    PluginCatalogResource | null,
    PluginOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreatePluginCatalogInput,
    PluginCatalogResource,
    PluginOperationContext
  >
  readonly update: CommandOperationDescriptor<
    UpdatePluginCatalogInput,
    PluginCatalogResource,
    PluginOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeletePluginCatalogInput,
    DeletePluginCatalogReceipt,
    PluginOperationContext
  >
  readonly rename: CommandOperationDescriptor<
    RenamePluginCatalogInput,
    PluginCatalogResource,
    PluginOperationContext
  >
  readonly checkUpdate: CommandOperationDescriptor<
    CheckPluginUpdateCatalogInput,
    CheckPluginUpdateCatalogReceipt,
    PluginOperationContext
  >
  readonly upgrade: CommandOperationDescriptor<
    UpgradePluginCatalogInput,
    UpgradePluginCatalogReceipt,
    PluginOperationContext
  >
}

export interface PluginCatalogModule {
  readonly commands: PluginCommands
  readonly queries: PluginQueries
  readonly operations: PluginOperationDescriptors
  readonly participants: Readonly<{
    aclIdentity: PluginAclIdentityParticipant
  }>
}

export function createPluginOperationDescriptors(
  commands: PluginCommands,
  queries: PluginQueries,
): PluginOperationDescriptors {
  return Object.freeze({
    list: defineQueryOperation({
      id: 'plugin-catalog.list-plugins.v1',
      summary: 'List plugins visible to the caller',
      permissions: ['plugins:read'],
      publicErrors: PLUGIN_PUBLIC_ERRORS,
      inputSchema: emptyPluginInputSchema,
      outputSchema: z.array(PluginOperationResourceSchema),
      invoke: async (authority: PluginOperationContext) => [...(await queries.list(authority))],
    }),
    get: defineQueryOperation({
      id: 'plugin-catalog.get-plugin.v1',
      summary: 'Get one plugin',
      permissions: ['plugins:read'],
      publicErrors: PLUGIN_PUBLIC_ERRORS,
      inputSchema: getPluginInputSchema,
      outputSchema: PluginOperationResourceSchema.nullable(),
      invoke: (authority: PluginOperationContext, input: GetPluginCatalogInput) =>
        queries.get(authority, input),
    }),
    create: defineCommandOperation({
      id: 'plugin-catalog.create-plugin.v1',
      summary: 'Install a plugin',
      permissions: ['plugins:create'],
      publicErrors: PLUGIN_PUBLIC_ERRORS,
      inputSchema: CreatePluginSchema,
      outputSchema: PluginOperationResourceSchema,
      invoke: (authority: PluginOperationContext, input: CreatePluginCatalogInput) =>
        commands.create(authority, input),
    }),
    update: defineCommandOperation({
      id: 'plugin-catalog.update-plugin.v1',
      summary: 'Replace a plugin',
      permissions: ['plugins:update'],
      publicErrors: PLUGIN_PUBLIC_ERRORS,
      inputSchema: updatePluginInputSchema,
      outputSchema: PluginOperationResourceSchema,
      invoke: (authority: PluginOperationContext, input: UpdatePluginCatalogInput) =>
        commands.update(authority, input),
    }),
    delete: defineCommandOperation({
      id: 'plugin-catalog.delete-plugin.v1',
      summary: 'Delete a plugin',
      permissions: ['plugins:delete'],
      publicErrors: PLUGIN_PUBLIC_ERRORS,
      inputSchema: deletePluginInputSchema,
      outputSchema: deletePluginReceiptSchema,
      invoke: (authority: PluginOperationContext, input: DeletePluginCatalogInput) =>
        commands.delete(authority, input),
    }),
    rename: defineCommandOperation({
      id: 'plugin-catalog.rename-plugin.v1',
      summary: 'Rename a plugin',
      permissions: ['plugins:update'],
      publicErrors: PLUGIN_PUBLIC_ERRORS,
      inputSchema: renamePluginInputSchema,
      outputSchema: PluginOperationResourceSchema,
      invoke: (authority: PluginOperationContext, input: RenamePluginCatalogInput) =>
        commands.rename(authority, input),
    }),
    checkUpdate: defineCommandOperation({
      id: 'plugin-catalog.check-plugin-update.v1',
      summary: 'Check a plugin for an upstream update',
      permissions: ['plugins:execute'],
      publicErrors: PLUGIN_PUBLIC_ERRORS,
      inputSchema: checkPluginUpdateInputSchema,
      outputSchema: PluginUpdateCheckSchema,
      invoke: (authority: PluginOperationContext, input: CheckPluginUpdateCatalogInput) =>
        commands.checkUpdate(authority, input),
    }),
    upgrade: defineCommandOperation({
      id: 'plugin-catalog.upgrade-plugin.v1',
      summary: 'Upgrade a plugin to the latest upstream version',
      permissions: ['plugins:update'],
      publicErrors: PLUGIN_PUBLIC_ERRORS,
      inputSchema: upgradePluginInputSchema,
      outputSchema: PluginUpgradeResultSchema,
      invoke: (authority: PluginOperationContext, input: UpgradePluginCatalogInput) =>
        commands.upgrade(authority, input),
    }),
  })
}

export { assertNameUnchangedForEditor } from '../application/resourceAccess'
export {
  DEFAULT_USER_RESOURCE_VISIBILITY,
  assertInitialResourceOwner,
  canAuditIntentSessions,
  initialBuiltinResourceAcl,
  initialPrivateResourceAcl,
  resolveTaskRole,
} from '../application/resourceDefaults'
export {
  canEditAccess,
  canEditRow,
  canGovernAccess,
  canViewAccess,
  discloseRefsSync,
  discloseScheduleRefs,
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  isResourceNameSubmissionAllowed,
  isVisibleRow,
  isVisibleToAudienceSnapshot,
  resolveAccessFrom,
  resolveResourceAccess,
  resourceAclAudienceAuthority,
  type AclRow,
  type DisclosedRefs,
  type ResourceAclActorProjection,
  type ResourceAclAudienceAuthority,
} from '../domain/resourceAccess'
export {
  canEditResource,
  canEditResourceInTx,
  canGovernResource,
  canViewResource,
  canViewResourceInTx,
  discloseRefs,
  filterVisibleRows,
  getResourceAcl,
  projectVisibleRowsWithAccess,
  requireResourceEdit,
  requireResourceGovern,
  requireResourceView,
  resolveResourceAccessFor,
  resolveResourceAccessForInTx,
  updateResourceAcl,
} from '../composition/resourceAcl'
export type {
  ForeignResourceAclType,
  ResourceAclIdentityPersistence,
} from '../composition/required-ports'
export {
  findOwnedAclResourceIdsByName,
  getAclResourceAccessRow,
  getAclResourceAccessRowInTx,
  getAclResourceIdentityRowInTx,
  getAclResourceOwner,
  getAclResourceOwnerInTx,
  listAclResourceIdentityRowsByIds,
  listAclResourceIdentityRowsByIdsInTx,
  listAclResourceIdentityRowsByNames,
  listAclResourceIdentityRowsByNamesInTx,
  listOwnedAclResourceNames,
  loadAclResourceNamesByIds,
  type AclResourceIdentitySnapshot,
} from '../infrastructure/sqliteAclReadRepository'
export {
  grantsOfResourceWhere,
  grantsOfUserWhere,
  listGrantedResourceIds,
  listGrantedResourceIdsInTx,
  listResourceGrantUserIds,
  listResourceGrantUserIdsInTx,
  listResourceGrants,
  listResourceGrantsInTx,
  listWritableGrantedResourceIds,
  loadGrantLevel,
  loadGrantLevelInTx,
  loadGrantLevelsForUser,
  visibleRowsCondition,
  type AclColumnRef,
} from '../infrastructure/sqliteResourceGrantRepository'
export {
  listAllVisibleResourceSummariesForActor,
  type SqliteResourceCatalogProjectionDependencies,
} from '../infrastructure/sqliteCatalogQuery'
export {
  findSqliteBuiltinResource,
  findSqliteBuiltinResourceInTx,
  getSqlitePackageResourceRow,
  getSqlitePackageResourceRowInTx,
  listSqlitePackageResourceRowsByIds,
  listSqlitePackageResourceRowsByNames,
} from '../infrastructure/sqlitePackageResourceRows'
export {
  compensateLegacyResourcePackageArtifact,
  createLegacyResourcePackageMutationAdapter,
  rollForwardLegacyResourcePackageArtifacts,
  type LegacyResourcePackageMutationDependencies,
  type LegacyStagedSkillVersion,
  type PreparedResourcePackageMutation,
  type ResourcePackageMutationArtifact,
} from '../infrastructure/aggregateAdapters/legacyResourcePackageMutationParticipants'
