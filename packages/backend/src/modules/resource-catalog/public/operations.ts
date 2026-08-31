// RFC-345 compatibility operations. Legacy inbound/service adapters consume
// this exact entrypoint while their call sites move to the data-only command,
// query and participant contracts.

import {
  AgentSchema,
  CombinedSaveSkillSchema,
  CreateManagedSkillSchema,
  CreateAgentSchema,
  DeleteAgentSchema,
  DeleteSkillSchema,
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
  RenameAgentRequestSchema,
  ResourceVisibilitySchema,
  SkillContentSchema,
  SkillSchema,
  UpdatePluginRequestSchema,
  UpdateAgentRequestSchema,
  CopyWorkgroupRequestSchema,
  CreateWorkgroupSchema,
  DeleteWorkgroupSchema,
  RenameWorkgroupSchema,
  SaveWorkgroupReceiptSchema,
  UpdateWorkgroupSchema,
  WorkgroupSchema,
  WorkgroupDetailSchema,
} from '@agent-workflow/shared'
import { z } from 'zod'
import { defineCommandOperation, defineQueryOperation } from '@/platform/operations/definitions'
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type {
  AgentCommands,
  McpCommands,
  PluginCommands,
  PluginUpdateCommands,
  SkillCommands,
  SkillFileCommands,
  SkillVersionCommands,
  WorkgroupCommands,
} from './commands'
import type {
  AgentAclIdentityParticipant,
  AgentOperationContext,
  McpAclIdentityParticipant,
  McpOperationContext,
  PluginAclIdentityParticipant,
  PluginOperationContext,
  SkillAclIdentityParticipant,
  SkillOperationContext,
  WorkgroupAclIdentityParticipant,
  WorkgroupOperationContext,
} from './participants'
import type {
  AgentQueries,
  AgentReferenceQueries,
  McpQueries,
  PluginQueries,
  SkillFileQueries,
  SkillQueries,
  SkillVersionQueries,
  WorkgroupQueries,
} from './queries'
import type {
  AgentCatalogResource,
  CheckPluginUpdateCatalogInput,
  CheckPluginUpdateCatalogReceipt,
  CreateMcpCatalogInput,
  CreateAgentCatalogInput,
  CreatePluginCatalogInput,
  DeleteMcpCatalogInput,
  DeleteMcpCatalogReceipt,
  DeleteAgentCatalogReceipt,
  DeletePluginCatalogInput,
  DeletePluginCatalogReceipt,
  GetMcpCatalogInput,
  GetAgentCatalogInput,
  GetPluginCatalogInput,
  McpCatalogResource,
  PluginCatalogResource,
  RenameMcpCatalogInput,
  RenameAgentCatalogInput,
  RenamePluginCatalogInput,
  UpdateMcpCatalogInput,
  UpdatePluginCatalogInput,
  UpgradePluginCatalogInput,
  UpgradePluginCatalogReceipt,
  CopyWorkgroupCatalogInput,
  CreateWorkgroupCatalogInput,
  DeleteWorkgroupCatalogReceipt,
  GetWorkgroupCatalogInput,
  RenameWorkgroupCatalogInput,
  UpdateWorkgroupCatalogInput,
  UpdateWorkgroupCatalogReceipt,
  WorkgroupCatalogDetail,
  WorkgroupCatalogResource,
  DeleteSkillCatalogReceipt,
  GetSkillCatalogInput,
  SkillCatalogContent,
  SkillCatalogResource,
} from './types'

const AGENT_PUBLIC_ERRORS = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)

const emptyAgentInputSchema = z.object({}).strict()
const getAgentInputSchema = z.object({ id: z.string().min(1) }).strict()
const updateAgentInputSchema = z
  .object({ id: z.string().min(1), update: UpdateAgentRequestSchema })
  .strict()
const deleteAgentInputSchema = z
  .object({ id: z.string().min(1), deletion: DeleteAgentSchema })
  .strict()
const renameAgentInputSchema = z
  .object({ id: z.string().min(1), rename: RenameAgentRequestSchema })
  .strict()
const deleteAgentReceiptSchema = z.object({ deleted: AgentSchema }).strict()

export interface AgentOperationDescriptors {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    AgentCatalogResource[],
    AgentOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetAgentCatalogInput,
    AgentCatalogResource | null,
    AgentOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateAgentCatalogInput,
    AgentCatalogResource,
    AgentOperationContext
  >
  readonly update: CommandOperationDescriptor<
    z.infer<typeof updateAgentInputSchema>,
    AgentCatalogResource,
    AgentOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    z.infer<typeof deleteAgentInputSchema>,
    DeleteAgentCatalogReceipt,
    AgentOperationContext
  >
  readonly rename: CommandOperationDescriptor<
    RenameAgentCatalogInput,
    AgentCatalogResource,
    AgentOperationContext
  >
}

export interface AgentCatalogModule {
  readonly commands: AgentCommands
  readonly queries: AgentQueries
  readonly referenceQueries: AgentReferenceQueries
  readonly operations: AgentOperationDescriptors
  readonly participants: Readonly<{
    aclIdentity: AgentAclIdentityParticipant
  }>
}

export function createAgentOperationDescriptors(
  commands: AgentCommands,
  queries: AgentQueries,
): AgentOperationDescriptors {
  return Object.freeze({
    list: defineQueryOperation({
      id: 'agent-catalog.list-agents.v1',
      summary: 'List agents visible to the caller',
      permissions: ['agents:read'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: emptyAgentInputSchema,
      outputSchema: z.array(AgentSchema),
      invoke: async (authority: AgentOperationContext) => [...(await queries.list(authority))],
    }),
    get: defineQueryOperation({
      id: 'agent-catalog.get-agent.v1',
      summary: 'Get one agent',
      permissions: ['agents:read'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: getAgentInputSchema,
      outputSchema: AgentSchema.nullable(),
      invoke: (authority: AgentOperationContext, input: GetAgentCatalogInput) =>
        queries.get(authority, input),
    }),
    create: defineCommandOperation({
      id: 'agent-catalog.create-agent.v1',
      summary: 'Create an agent',
      permissions: ['agents:create'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: CreateAgentSchema,
      outputSchema: AgentSchema,
      invoke: (authority: AgentOperationContext, input: CreateAgentCatalogInput) =>
        commands.create(authority, input),
    }),
    update: defineCommandOperation({
      id: 'agent-catalog.update-agent.v1',
      summary: 'Replace an agent',
      permissions: ['agents:update'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: updateAgentInputSchema,
      outputSchema: AgentSchema,
      invoke: (authority: AgentOperationContext, input: z.infer<typeof updateAgentInputSchema>) =>
        commands.update(authority, {
          id: input.id,
          submission: { kind: 'json-body', body: JSON.stringify(input.update) ?? '{}' },
        }),
    }),
    delete: defineCommandOperation({
      id: 'agent-catalog.delete-agent.v1',
      summary: 'Delete an agent',
      permissions: ['agents:delete'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: deleteAgentInputSchema,
      outputSchema: deleteAgentReceiptSchema,
      invoke: (authority: AgentOperationContext, input: z.infer<typeof deleteAgentInputSchema>) =>
        commands.delete(authority, {
          id: input.id,
          submission: { kind: 'json-body', body: JSON.stringify(input.deletion) ?? '{}' },
        }),
    }),
    rename: defineCommandOperation({
      id: 'agent-catalog.rename-agent.v1',
      summary: 'Rename an agent',
      permissions: ['agents:update'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: renameAgentInputSchema,
      outputSchema: AgentSchema,
      invoke: (authority: AgentOperationContext, input: RenameAgentCatalogInput) =>
        commands.rename(authority, input),
    }),
  })
}

const SKILL_PUBLIC_ERRORS = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)

const emptySkillInputSchema = z.object({}).strict()
const getSkillInputSchema = z.object({ id: z.string().min(1) }).strict()
const saveSkillInputSchema = z
  .object({ id: z.string().min(1), save: CombinedSaveSkillSchema })
  .strict()
const deleteSkillInputSchema = z
  .object({ id: z.string().min(1), deletion: DeleteSkillSchema })
  .strict()
const deleteSkillReceiptSchema = z.object({ deleted: SkillSchema }).strict()

export interface SkillOperationDescriptors {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    SkillCatalogResource[],
    SkillOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetSkillCatalogInput,
    SkillCatalogResource | null,
    SkillOperationContext
  >
  readonly create: CommandOperationDescriptor<
    z.infer<typeof CreateManagedSkillSchema>,
    SkillCatalogResource,
    SkillOperationContext
  >
  readonly save: CommandOperationDescriptor<
    z.infer<typeof saveSkillInputSchema>,
    SkillCatalogContent,
    SkillOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    z.infer<typeof deleteSkillInputSchema>,
    DeleteSkillCatalogReceipt,
    SkillOperationContext
  >
}

export interface SkillCatalogModule {
  readonly commands: SkillCommands
  readonly fileCommands: SkillFileCommands
  readonly versionCommands: SkillVersionCommands
  readonly queries: SkillQueries
  readonly fileQueries: SkillFileQueries
  readonly versionQueries: SkillVersionQueries
  readonly operations: SkillOperationDescriptors
  readonly participants: Readonly<{
    aclIdentity: SkillAclIdentityParticipant
  }>
}

export function createSkillOperationDescriptors(
  commands: SkillCommands,
  queries: SkillQueries,
): SkillOperationDescriptors {
  return Object.freeze({
    list: defineQueryOperation({
      id: 'skill-catalog.list-skills.v1',
      summary: 'List skills visible to the caller',
      permissions: ['skills:read'],
      publicErrors: SKILL_PUBLIC_ERRORS,
      inputSchema: emptySkillInputSchema,
      outputSchema: z.array(SkillSchema),
      invoke: async (authority: SkillOperationContext) => [...(await queries.list(authority))],
    }),
    get: defineQueryOperation({
      id: 'skill-catalog.get-skill.v1',
      summary: 'Get one skill',
      permissions: ['skills:read'],
      publicErrors: SKILL_PUBLIC_ERRORS,
      inputSchema: getSkillInputSchema,
      outputSchema: SkillSchema.nullable(),
      invoke: (authority: SkillOperationContext, input: GetSkillCatalogInput) =>
        queries.get(authority, input),
    }),
    create: defineCommandOperation({
      id: 'skill-catalog.create-skill.v1',
      summary: 'Create a skill',
      permissions: ['skills:create'],
      publicErrors: SKILL_PUBLIC_ERRORS,
      inputSchema: CreateManagedSkillSchema,
      outputSchema: SkillSchema,
      invoke: (authority: SkillOperationContext, input: z.infer<typeof CreateManagedSkillSchema>) =>
        commands.create(authority, {
          submission: { kind: 'json-body', body: JSON.stringify(input) ?? '{}' },
        }),
    }),
    save: defineCommandOperation({
      id: 'skill-catalog.save-skill.v1',
      summary: 'Save skill metadata and content',
      permissions: ['skills:update'],
      publicErrors: SKILL_PUBLIC_ERRORS,
      inputSchema: saveSkillInputSchema,
      outputSchema: SkillContentSchema,
      invoke: (authority: SkillOperationContext, input: z.infer<typeof saveSkillInputSchema>) =>
        commands.save(authority, {
          id: input.id,
          submission: { kind: 'json-body', body: JSON.stringify(input.save) ?? '{}' },
        }),
    }),
    delete: defineCommandOperation({
      id: 'skill-catalog.delete-skill.v1',
      summary: 'Delete a skill',
      permissions: ['skills:delete'],
      publicErrors: SKILL_PUBLIC_ERRORS,
      inputSchema: deleteSkillInputSchema,
      outputSchema: deleteSkillReceiptSchema,
      invoke: (authority: SkillOperationContext, input: z.infer<typeof deleteSkillInputSchema>) =>
        commands.delete(authority, {
          id: input.id,
          submission: { kind: 'json-body', body: JSON.stringify(input.deletion) ?? '{}' },
        }),
    }),
  })
}

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
  readonly updateCommands: PluginUpdateCommands
  readonly queries: PluginQueries
  readonly operations: PluginOperationDescriptors
  readonly participants: Readonly<{
    aclIdentity: PluginAclIdentityParticipant
  }>
}

export function createPluginOperationDescriptors(
  commands: PluginCommands,
  updateCommands: PluginUpdateCommands,
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
        updateCommands.checkUpdate(authority, input),
    }),
    upgrade: defineCommandOperation({
      id: 'plugin-catalog.upgrade-plugin.v1',
      summary: 'Upgrade a plugin to the latest upstream version',
      permissions: ['plugins:update'],
      publicErrors: PLUGIN_PUBLIC_ERRORS,
      inputSchema: upgradePluginInputSchema,
      outputSchema: PluginUpgradeResultSchema,
      invoke: (authority: PluginOperationContext, input: UpgradePluginCatalogInput) =>
        updateCommands.upgrade(authority, input),
    }),
  })
}

const WORKGROUP_PUBLIC_ERRORS = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)

const emptyWorkgroupInputSchema = z.object({}).strict()
const getWorkgroupInputSchema = z.object({ id: z.string().min(1) }).strict()
const copyWorkgroupInputSchema = z
  .object({ id: z.string().min(1), copy: CopyWorkgroupRequestSchema })
  .strict()
const updateWorkgroupInputSchema = z
  .object({ id: z.string().min(1), update: UpdateWorkgroupSchema })
  .strict()
const deleteWorkgroupInputSchema = z
  .object({ id: z.string().min(1), deletion: DeleteWorkgroupSchema })
  .strict()
const renameWorkgroupInputSchema = z
  .object({ id: z.string().min(1), rename: RenameWorkgroupSchema })
  .strict()
const deleteWorkgroupReceiptSchema = z
  .object({
    id: z.string().min(1),
    deletedVersion: z.number().int().positive(),
    clientMutationId: z.string().min(1),
  })
  .strict()

export interface WorkgroupOperationDescriptors {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    WorkgroupCatalogResource[],
    WorkgroupOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetWorkgroupCatalogInput,
    WorkgroupCatalogDetail | null,
    WorkgroupOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateWorkgroupCatalogInput,
    WorkgroupCatalogDetail,
    WorkgroupOperationContext
  >
  readonly copy: CommandOperationDescriptor<
    CopyWorkgroupCatalogInput,
    WorkgroupCatalogDetail,
    WorkgroupOperationContext
  >
  readonly update: CommandOperationDescriptor<
    UpdateWorkgroupCatalogInput,
    UpdateWorkgroupCatalogReceipt,
    WorkgroupOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    z.infer<typeof deleteWorkgroupInputSchema>,
    DeleteWorkgroupCatalogReceipt,
    WorkgroupOperationContext
  >
  readonly rename: CommandOperationDescriptor<
    RenameWorkgroupCatalogInput,
    UpdateWorkgroupCatalogReceipt,
    WorkgroupOperationContext
  >
}

export interface WorkgroupCatalogModule {
  readonly commands: WorkgroupCommands
  readonly queries: WorkgroupQueries
  readonly operations: WorkgroupOperationDescriptors
  readonly participants: Readonly<{
    aclIdentity: WorkgroupAclIdentityParticipant
  }>
}

export function createWorkgroupOperationDescriptors(
  commands: WorkgroupCommands,
  queries: WorkgroupQueries,
): WorkgroupOperationDescriptors {
  return Object.freeze({
    list: defineQueryOperation({
      id: 'workgroup-catalog.list-workgroups.v1',
      summary: 'List workgroups visible to the caller',
      permissions: ['workgroups:read'],
      publicErrors: WORKGROUP_PUBLIC_ERRORS,
      inputSchema: emptyWorkgroupInputSchema,
      outputSchema: z.array(WorkgroupSchema),
      invoke: async (authority: WorkgroupOperationContext) => [...(await queries.list(authority))],
    }),
    get: defineQueryOperation({
      id: 'workgroup-catalog.get-workgroup.v1',
      summary: 'Get one workgroup',
      permissions: ['workgroups:read'],
      publicErrors: WORKGROUP_PUBLIC_ERRORS,
      inputSchema: getWorkgroupInputSchema,
      outputSchema: WorkgroupDetailSchema.nullable(),
      invoke: (authority: WorkgroupOperationContext, input: GetWorkgroupCatalogInput) =>
        queries.get(authority, input),
    }),
    create: defineCommandOperation({
      id: 'workgroup-catalog.create-workgroup.v1',
      summary: 'Create a workgroup',
      permissions: ['workgroups:create'],
      publicErrors: WORKGROUP_PUBLIC_ERRORS,
      inputSchema: CreateWorkgroupSchema,
      outputSchema: WorkgroupDetailSchema,
      invoke: (authority: WorkgroupOperationContext, input: CreateWorkgroupCatalogInput) =>
        commands.create(authority, input),
    }),
    copy: defineCommandOperation({
      id: 'workgroup-catalog.copy-workgroup.v1',
      summary: 'Copy a workgroup into a private duplicate',
      permissions: ['workgroups:create'],
      publicErrors: WORKGROUP_PUBLIC_ERRORS,
      inputSchema: copyWorkgroupInputSchema,
      outputSchema: WorkgroupDetailSchema,
      invoke: (authority: WorkgroupOperationContext, input: CopyWorkgroupCatalogInput) =>
        commands.copy(authority, input),
    }),
    update: defineCommandOperation({
      id: 'workgroup-catalog.update-workgroup.v1',
      summary: 'Replace a workgroup document',
      permissions: ['workgroups:update'],
      publicErrors: WORKGROUP_PUBLIC_ERRORS,
      inputSchema: updateWorkgroupInputSchema,
      outputSchema: SaveWorkgroupReceiptSchema,
      invoke: (authority: WorkgroupOperationContext, input: UpdateWorkgroupCatalogInput) =>
        commands.update(authority, input),
    }),
    delete: defineCommandOperation({
      id: 'workgroup-catalog.delete-workgroup.v1',
      summary: 'Delete a workgroup',
      permissions: ['workgroups:delete'],
      publicErrors: WORKGROUP_PUBLIC_ERRORS,
      inputSchema: deleteWorkgroupInputSchema,
      outputSchema: deleteWorkgroupReceiptSchema,
      invoke: (
        authority: WorkgroupOperationContext,
        input: z.infer<typeof deleteWorkgroupInputSchema>,
      ) =>
        commands.delete(authority, {
          id: input.id,
          deletion: {
            kind: 'json-body',
            body: JSON.stringify(input.deletion) ?? '{}',
          },
        }),
    }),
    rename: defineCommandOperation({
      id: 'workgroup-catalog.rename-workgroup.v1',
      summary: 'Rename a workgroup',
      permissions: ['workgroups:update'],
      publicErrors: WORKGROUP_PUBLIC_ERRORS,
      inputSchema: renameWorkgroupInputSchema,
      outputSchema: SaveWorkgroupReceiptSchema,
      invoke: (authority: WorkgroupOperationContext, input: RenameWorkgroupCatalogInput) =>
        commands.rename(authority, input),
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
