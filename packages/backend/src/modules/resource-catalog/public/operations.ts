// RFC-345 owned operation descriptors. The tail retains only the exact
// compatibility exports still consumed by already-owned W4-E1/W5 cohorts;
// W4-C public debt must not grow back here.

import {
  AgentSchema,
  CreateAgentSchema,
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
  CopyWorkflowRequestSchema,
  SaveWorkflowReceiptSchema as SaveWorkflowCatalogReceiptSchema,
  WorkflowDetailSchema,
  WorkflowSchema,
  type Workflow,
  CopyWorkgroupRequestSchema,
  CreateWorkgroupSchema,
  RenameWorkgroupSchema,
  SaveWorkgroupReceiptSchema,
  UpdateWorkgroupSchema,
  WorkgroupSchema,
  WorkgroupDetailSchema,
  type Workgroup,
} from '@agent-workflow/shared'
import { z } from 'zod'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import { operationId } from '@/platform/operations/catalog'
import { zodOperationCodec } from '@/platform/operations/codecs'
import { defineCommandOperation, defineQueryOperation } from '@/platform/operations/definitions'
import type {
  CommandOperationDescriptor,
  IdempotentCommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type {
  CheckPluginUpdateCatalogInput,
  CheckPluginUpdateCatalogReceipt,
  CopyWorkflowCatalogInput,
  CopyWorkgroupCatalogInput,
  CreateAgentCatalogInput,
  CreateMcpCatalogInput,
  CreatePluginCatalogInput,
  CreateSkillCatalogInput,
  CreateWorkflowCatalogInput,
  CreateWorkgroupCatalogInput,
  DeleteAgentCatalogInput,
  DeleteAgentCatalogReceipt,
  DeleteMcpCatalogInput,
  DeleteMcpCatalogReceipt,
  DeletePluginCatalogInput,
  DeletePluginCatalogReceipt,
  DeleteSkillCatalogInput,
  DeleteSkillCatalogReceipt,
  DeleteWorkflowCatalogInput,
  DeleteWorkflowCatalogReceipt,
  DeleteWorkgroupCatalogInput,
  DeleteWorkgroupCatalogReceipt,
  RenameAgentCatalogInput,
  RenameMcpCatalogInput,
  RenamePluginCatalogInput,
  RenameWorkgroupCatalogInput,
  SaveSkillCatalogInput,
  UpdateAgentCatalogInput,
  UpdateMcpCatalogInput,
  UpdatePluginCatalogInput,
  UpdateWorkflowCatalogInput,
  UpdateWorkflowCatalogReceipt,
  UpdateWorkgroupCatalogInput,
  UpdateWorkgroupCatalogReceipt,
  UpgradePluginCatalogInput,
  UpgradePluginCatalogReceipt,
} from '../domain/catalogOperationTypes'
import type { SkillFileCommands, SkillVersionCommands } from './commands'
import type {
  AgentAclIdentityParticipant,
  AgentOperationContext,
  McpAclIdentityParticipant,
  McpOperationContext,
  PluginAclIdentityParticipant,
  PluginOperationContext,
  SkillAclIdentityParticipant,
  SkillOperationContext,
  WorkflowAclIdentityParticipant,
  WorkflowOperationContext,
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
  WorkflowQueries,
  WorkgroupQueries,
} from './queries'
import type {
  AgentCatalogResource,
  GetMcpCatalogInput,
  GetAgentCatalogInput,
  GetPluginCatalogInput,
  McpCatalogResource,
  PluginCatalogResource,
  GetWorkgroupCatalogInput,
  WorkgroupCatalogDetail,
  GetSkillCatalogInput,
  SkillCatalogContent,
  SkillCatalogResource,
  GetWorkflowCatalogInput,
  WorkflowCatalogDetail,
  ApplyResourcePackage,
  ExportResourcePackage,
  InspectResourcePackage,
} from './types'

interface AgentCommands {
  create(
    authority: AgentOperationContext,
    input: CreateAgentCatalogInput,
  ): Promise<AgentCatalogResource>
  update(
    authority: AgentOperationContext,
    input: UpdateAgentCatalogInput,
  ): Promise<AgentCatalogResource>
  delete(
    authority: AgentOperationContext,
    input: DeleteAgentCatalogInput,
  ): Promise<DeleteAgentCatalogReceipt>
  rename(
    authority: AgentOperationContext,
    input: RenameAgentCatalogInput,
  ): Promise<AgentCatalogResource>
}

interface SkillCommands {
  create(
    authority: SkillOperationContext,
    input: CreateSkillCatalogInput,
  ): Promise<SkillCatalogResource>
  save(authority: SkillOperationContext, input: SaveSkillCatalogInput): Promise<SkillCatalogContent>
  delete(
    authority: SkillOperationContext,
    input: DeleteSkillCatalogInput,
  ): Promise<DeleteSkillCatalogReceipt>
}

interface McpCommands {
  create(authority: McpOperationContext, input: CreateMcpCatalogInput): Promise<McpCatalogResource>
  update(authority: McpOperationContext, input: UpdateMcpCatalogInput): Promise<McpCatalogResource>
  delete(
    authority: McpOperationContext,
    input: DeleteMcpCatalogInput,
  ): Promise<DeleteMcpCatalogReceipt>
  rename(authority: McpOperationContext, input: RenameMcpCatalogInput): Promise<McpCatalogResource>
}

interface PluginCommands {
  create(
    authority: PluginOperationContext,
    input: CreatePluginCatalogInput,
  ): Promise<PluginCatalogResource>
  update(
    authority: PluginOperationContext,
    input: UpdatePluginCatalogInput,
  ): Promise<PluginCatalogResource>
  delete(
    authority: PluginOperationContext,
    input: DeletePluginCatalogInput,
  ): Promise<DeletePluginCatalogReceipt>
  rename(
    authority: PluginOperationContext,
    input: RenamePluginCatalogInput,
  ): Promise<PluginCatalogResource>
}

interface PluginUpdateCommands {
  checkUpdate(
    authority: PluginOperationContext,
    input: CheckPluginUpdateCatalogInput,
  ): Promise<CheckPluginUpdateCatalogReceipt>
  upgrade(
    authority: PluginOperationContext,
    input: UpgradePluginCatalogInput,
  ): Promise<UpgradePluginCatalogReceipt>
}

interface WorkflowCommands {
  create(
    authority: WorkflowOperationContext,
    input: CreateWorkflowCatalogInput,
  ): Promise<WorkflowCatalogDetail>
  copy(
    authority: WorkflowOperationContext,
    input: CopyWorkflowCatalogInput,
  ): Promise<WorkflowCatalogDetail>
  update(
    authority: WorkflowOperationContext,
    input: UpdateWorkflowCatalogInput,
  ): Promise<UpdateWorkflowCatalogReceipt>
  delete(
    authority: WorkflowOperationContext,
    input: DeleteWorkflowCatalogInput,
  ): Promise<DeleteWorkflowCatalogReceipt>
}

interface WorkgroupCommands {
  create(
    authority: WorkgroupOperationContext,
    input: CreateWorkgroupCatalogInput,
  ): Promise<WorkgroupCatalogDetail>
  copy(
    authority: WorkgroupOperationContext,
    input: CopyWorkgroupCatalogInput,
  ): Promise<WorkgroupCatalogDetail>
  update(
    authority: WorkgroupOperationContext,
    input: UpdateWorkgroupCatalogInput,
  ): Promise<UpdateWorkgroupCatalogReceipt>
  delete(
    authority: WorkgroupOperationContext,
    input: DeleteWorkgroupCatalogInput,
  ): Promise<DeleteWorkgroupCatalogReceipt>
  rename(
    authority: WorkgroupOperationContext,
    input: RenameWorkgroupCatalogInput,
  ): Promise<UpdateWorkgroupCatalogReceipt>
}

interface ResourcePackagePreviewReceipt {
  readonly previewId: string
}

interface GetResourcePackagePreview {
  readonly previewId: string
}

interface ResourcePackagePreviewView {
  readonly previewId: string
  readonly document: string
}

interface ResourcePackageApplyReceipt {
  readonly receiptId: string
}

interface GetResourcePackageApplyReceipt {
  readonly receiptId: string
}

interface ResourcePackageApplyReceiptView {
  readonly receiptId: string
  readonly document: string
}

interface ResourcePackageExportReceipt {
  readonly packageId: string
  readonly filename: string
}

const AGENT_PUBLIC_ERRORS = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)

const jsonBodySubmissionSchema = z
  .object({ kind: z.literal('json-body'), body: z.string() })
  .strict()
const emptyAgentInputSchema = z.object({}).strict()
const getAgentInputSchema = z.object({ id: z.string().min(1) }).strict()
const updateAgentInputSchema = z
  .object({ id: z.string().min(1), submission: jsonBodySubmissionSchema })
  .strict()
const deleteAgentInputSchema = z
  .object({ id: z.string().min(1), submission: jsonBodySubmissionSchema })
  .strict()
const renameAgentInputSchema = z
  .object({ id: z.string().min(1), rename: RenameAgentRequestSchema })
  .strict()
// Historical rows and source-backed fixtures predate the lowercase-only authoring
// rule and may contain an uppercase ULID suffix in `name`. Keep create/update/
// rename inputs on the strict shared schemas, while preserving the established
// response contract for already-persisted resources.
const agentCatalogResourceSchema = AgentSchema.extend({ name: z.string().min(1).max(128) })
const deleteAgentReceiptSchema = z.object({ deleted: agentCatalogResourceSchema }).strict()

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
    UpdateAgentCatalogInput,
    AgentCatalogResource,
    AgentOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteAgentCatalogInput,
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
      outputSchema: z.array(agentCatalogResourceSchema),
      invoke: async (authority: AgentOperationContext) => [...(await queries.list(authority))],
    }),
    get: defineQueryOperation({
      id: 'agent-catalog.get-agent.v1',
      summary: 'Get one agent',
      permissions: ['agents:read'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: getAgentInputSchema,
      outputSchema: agentCatalogResourceSchema.nullable(),
      invoke: (authority: AgentOperationContext, input: GetAgentCatalogInput) =>
        queries.get(authority, input),
    }),
    create: defineCommandOperation({
      id: 'agent-catalog.create-agent.v1',
      summary: 'Create an agent',
      permissions: ['agents:create'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: CreateAgentSchema,
      outputSchema: agentCatalogResourceSchema,
      invoke: (authority: AgentOperationContext, input: CreateAgentCatalogInput) =>
        commands.create(authority, input),
    }),
    update: defineCommandOperation({
      id: 'agent-catalog.update-agent.v1',
      summary: 'Replace an agent',
      permissions: ['agents:update'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: updateAgentInputSchema,
      outputSchema: agentCatalogResourceSchema,
      invoke: (authority: AgentOperationContext, input: UpdateAgentCatalogInput) =>
        commands.update(authority, input),
    }),
    delete: defineCommandOperation({
      id: 'agent-catalog.delete-agent.v1',
      summary: 'Delete an agent',
      permissions: ['agents:delete'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: deleteAgentInputSchema,
      outputSchema: deleteAgentReceiptSchema,
      invoke: (authority: AgentOperationContext, input: DeleteAgentCatalogInput) =>
        commands.delete(authority, input),
    }),
    rename: defineCommandOperation({
      id: 'agent-catalog.rename-agent.v1',
      summary: 'Rename an agent',
      permissions: ['agents:update'],
      publicErrors: AGENT_PUBLIC_ERRORS,
      inputSchema: renameAgentInputSchema,
      outputSchema: agentCatalogResourceSchema,
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
  .object({ id: z.string().min(1), submission: jsonBodySubmissionSchema })
  .strict()
const deleteSkillInputSchema = z
  .object({ id: z.string().min(1), submission: jsonBodySubmissionSchema })
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
    CreateSkillCatalogInput,
    SkillCatalogResource,
    SkillOperationContext
  >
  readonly save: CommandOperationDescriptor<
    SaveSkillCatalogInput,
    SkillCatalogContent,
    SkillOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteSkillCatalogInput,
    DeleteSkillCatalogReceipt,
    SkillOperationContext
  >
}

export interface SkillCatalogModule {
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
      inputSchema: z.object({ submission: jsonBodySubmissionSchema }).strict(),
      outputSchema: SkillSchema,
      invoke: (authority: SkillOperationContext, input: CreateSkillCatalogInput) =>
        commands.create(authority, input),
    }),
    save: defineCommandOperation({
      id: 'skill-catalog.save-skill.v1',
      summary: 'Save skill metadata and content',
      permissions: ['skills:update'],
      publicErrors: SKILL_PUBLIC_ERRORS,
      inputSchema: saveSkillInputSchema,
      outputSchema: SkillContentSchema,
      invoke: (authority: SkillOperationContext, input: SaveSkillCatalogInput) =>
        commands.save(authority, input),
    }),
    delete: defineCommandOperation({
      id: 'skill-catalog.delete-skill.v1',
      summary: 'Delete a skill',
      permissions: ['skills:delete'],
      publicErrors: SKILL_PUBLIC_ERRORS,
      inputSchema: deleteSkillInputSchema,
      outputSchema: deleteSkillReceiptSchema,
      invoke: (authority: SkillOperationContext, input: DeleteSkillCatalogInput) =>
        commands.delete(authority, input),
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

const WORKFLOW_PUBLIC_ERRORS = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)

const emptyWorkflowInputSchema = z.object({}).strict()
const getWorkflowInputSchema = z.object({ id: z.string().min(1) }).strict()
const copyWorkflowInputSchema = z
  .object({ id: z.string().min(1), copy: CopyWorkflowRequestSchema })
  .strict()
const createWorkflowInputSchema = z.object({ submission: jsonBodySubmissionSchema }).strict()
const updateWorkflowInputSchema = z
  .object({ id: z.string().min(1), submission: jsonBodySubmissionSchema })
  .strict()
const deleteWorkflowInputSchema = z
  .object({ id: z.string().min(1), submission: jsonBodySubmissionSchema })
  .strict()
const workflowAclIdentitySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    ownerUserId: z.string().nullable(),
    visibility: ResourceVisibilitySchema,
    builtin: z.boolean(),
  })
  .strict()
const deleteWorkflowReceiptSchema = z
  .object({
    deleted: workflowAclIdentitySchema,
    clientMutationId: z.string().min(1),
    deletedVersion: z.number().int().positive(),
  })
  .strict()

export interface WorkflowOperationDescriptors {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    Workflow[],
    WorkflowOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetWorkflowCatalogInput,
    WorkflowCatalogDetail | null,
    WorkflowOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateWorkflowCatalogInput,
    WorkflowCatalogDetail,
    WorkflowOperationContext
  >
  readonly copy: CommandOperationDescriptor<
    CopyWorkflowCatalogInput,
    WorkflowCatalogDetail,
    WorkflowOperationContext
  >
  readonly update: CommandOperationDescriptor<
    UpdateWorkflowCatalogInput,
    UpdateWorkflowCatalogReceipt,
    WorkflowOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteWorkflowCatalogInput,
    DeleteWorkflowCatalogReceipt,
    WorkflowOperationContext
  >
}

export interface WorkflowCatalogModule {
  readonly queries: WorkflowQueries
  readonly operations: WorkflowOperationDescriptors
  readonly participants: Readonly<{
    aclIdentity: WorkflowAclIdentityParticipant
  }>
}

export function createWorkflowOperationDescriptors(
  commands: WorkflowCommands,
  queries: WorkflowQueries,
): WorkflowOperationDescriptors {
  return Object.freeze({
    list: defineQueryOperation({
      id: 'workflow-catalog.list-workflows.v1',
      summary: 'List workflows visible to the caller',
      permissions: ['workflows:read'],
      publicErrors: WORKFLOW_PUBLIC_ERRORS,
      inputSchema: emptyWorkflowInputSchema,
      outputSchema: z.array(WorkflowSchema),
      invoke: async (authority: WorkflowOperationContext) => [...(await queries.list(authority))],
    }),
    get: defineQueryOperation({
      id: 'workflow-catalog.get-workflow.v1',
      summary: 'Get one workflow',
      permissions: ['workflows:read'],
      publicErrors: WORKFLOW_PUBLIC_ERRORS,
      inputSchema: getWorkflowInputSchema,
      outputSchema: WorkflowDetailSchema.nullable(),
      invoke: (authority: WorkflowOperationContext, input: GetWorkflowCatalogInput) =>
        queries.get(authority, input),
    }),
    create: defineCommandOperation({
      id: 'workflow-catalog.create-workflow.v1',
      summary: 'Create a workflow',
      permissions: ['workflows:create'],
      publicErrors: WORKFLOW_PUBLIC_ERRORS,
      inputSchema: createWorkflowInputSchema,
      outputSchema: WorkflowDetailSchema,
      invoke: (authority: WorkflowOperationContext, input: CreateWorkflowCatalogInput) =>
        commands.create(authority, input),
    }),
    copy: defineCommandOperation({
      id: 'workflow-catalog.copy-workflow.v1',
      summary: 'Copy a workflow into a private duplicate',
      permissions: ['workflows:create'],
      publicErrors: WORKFLOW_PUBLIC_ERRORS,
      inputSchema: copyWorkflowInputSchema,
      outputSchema: WorkflowDetailSchema,
      invoke: (authority: WorkflowOperationContext, input: CopyWorkflowCatalogInput) =>
        commands.copy(authority, input),
    }),
    update: defineCommandOperation({
      id: 'workflow-catalog.update-workflow.v1',
      summary: 'Replace a workflow',
      permissions: ['workflows:update'],
      publicErrors: WORKFLOW_PUBLIC_ERRORS,
      inputSchema: updateWorkflowInputSchema,
      outputSchema: SaveWorkflowCatalogReceiptSchema,
      invoke: (authority: WorkflowOperationContext, input: UpdateWorkflowCatalogInput) =>
        commands.update(authority, input),
    }),
    delete: defineCommandOperation({
      id: 'workflow-catalog.delete-workflow.v1',
      summary: 'Delete a workflow',
      permissions: ['workflows:delete'],
      publicErrors: WORKFLOW_PUBLIC_ERRORS,
      inputSchema: deleteWorkflowInputSchema,
      outputSchema: deleteWorkflowReceiptSchema,
      invoke: (authority: WorkflowOperationContext, input: DeleteWorkflowCatalogInput) =>
        commands.delete(authority, input),
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
  .object({ id: z.string().min(1), deletion: jsonBodySubmissionSchema })
  .strict()
const renameWorkgroupInputSchema = z
  .object({ id: z.string().min(1), rename: RenameWorkgroupSchema })
  .strict()
const deleteWorkgroupReceiptSchema = z
  .object({
    id: z.string().min(1),
    deletedVersion: z.number().int().positive(),
    clientMutationId: z.string().min(1),
    deleted: WorkgroupDetailSchema,
  })
  .strict()

export interface WorkgroupOperationDescriptors {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    Workgroup[],
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
    DeleteWorkgroupCatalogInput,
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
      invoke: (authority: WorkgroupOperationContext, input: DeleteWorkgroupCatalogInput) =>
        commands.delete(authority, input),
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

const RESOURCE_PACKAGE_PUBLIC_ERRORS = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)
const resourcePackageSubmissionSchema = z
  .object({
    kind: z.literal('staged-resource-package'),
    handle: z.string().min(1).max(128),
  })
  .strict()
const inspectResourcePackageSchema = z
  .object({ submission: resourcePackageSubmissionSchema })
  .strict()
const applyResourcePackageSchema = z
  .object({
    submission: resourcePackageSubmissionSchema,
    idempotencyKey: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict()
const exportResourcePackageSchema = z
  .object({ submission: resourcePackageSubmissionSchema })
  .strict()
const resourcePackagePreviewReceiptSchema = z.object({ previewId: z.string().min(1) }).strict()
const getResourcePackagePreviewSchema = z.object({ previewId: z.string().min(1) }).strict()
const resourcePackagePreviewViewSchema = z
  .object({ previewId: z.string().min(1), document: z.string() })
  .strict()
const resourcePackageApplyReceiptSchema = z.object({ receiptId: z.string().min(1) }).strict()
const getResourcePackageApplyReceiptSchema = z.object({ receiptId: z.string().min(1) }).strict()
const resourcePackageApplyReceiptViewSchema = z
  .object({ receiptId: z.string().min(1), document: z.string() })
  .strict()
const resourcePackageExportReceiptSchema = z
  .object({ packageId: z.string().min(1), filename: z.string().min(1) })
  .strict()

export interface ResourcePackageOperationDescriptors {
  readonly inspect: CommandOperationDescriptor<
    InspectResourcePackage,
    ResourcePackagePreviewReceipt,
    CommandContext
  >
  readonly apply: IdempotentCommandOperationDescriptor<
    ApplyResourcePackage,
    ResourcePackageApplyReceipt,
    CommandContext
  >
  readonly getPreview: QueryOperationDescriptor<
    GetResourcePackagePreview,
    ResourcePackagePreviewView,
    QueryContext
  >
  readonly getReceipt: QueryOperationDescriptor<
    GetResourcePackageApplyReceipt,
    ResourcePackageApplyReceiptView,
    QueryContext
  >
  readonly exports: Readonly<{
    agent: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    skill: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    mcp: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    plugin: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    workflow: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    workgroup: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    capability_template: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
  }>
}

export interface ResourcePackageCatalogModule {
  readonly operations: ResourcePackageOperationDescriptors
}

interface ResourcePackageOperationCommands {
  inspect(
    context: CommandContext,
    input: InspectResourcePackage,
  ): Promise<ResourcePackagePreviewReceipt>
  apply(context: CommandContext, input: ApplyResourcePackage): Promise<ResourcePackageApplyReceipt>
  export(
    context: CommandContext,
    input: ExportResourcePackage,
  ): Promise<ResourcePackageExportReceipt>
}

interface ResourcePackageOperationQueries {
  getPreview(
    context: QueryContext,
    input: GetResourcePackagePreview,
  ): Promise<ResourcePackagePreviewView>
  getReceipt(
    context: QueryContext,
    input: GetResourcePackageApplyReceipt,
  ): Promise<ResourcePackageApplyReceiptView>
}

export function createResourcePackageOperationDescriptors(
  commands: ResourcePackageOperationCommands,
  queries: ResourcePackageOperationQueries,
): ResourcePackageOperationDescriptors {
  const exportOperation = (
    id: string,
    summary: string,
    permission: Parameters<typeof defineCommandOperation>[0]['permissions'][number],
  ): CommandOperationDescriptor<
    ExportResourcePackage,
    ResourcePackageExportReceipt,
    CommandContext
  > =>
    defineCommandOperation({
      id,
      summary,
      permissions: [permission],
      publicErrors: RESOURCE_PACKAGE_PUBLIC_ERRORS,
      inputSchema: exportResourcePackageSchema,
      outputSchema: resourcePackageExportReceiptSchema,
      invoke: (context: CommandContext, input: ExportResourcePackage) =>
        commands.export(context, input),
    })
  const apply: ResourcePackageOperationDescriptors['apply'] = Object.freeze({
    id: operationId('resource-catalog.apply-package.v1'),
    kind: 'idempotent-command',
    contextKind: 'authenticated-command',
    summary: 'Apply a previewed resource package',
    permissions: [],
    publicReason: 'Package entries determine their own exact resource permissions.',
    publicErrors: RESOURCE_PACKAGE_PUBLIC_ERRORS,
    idempotencyKey: {
      field: 'idempotencyKey' as const,
      minLength: 8,
      maxLength: 256,
      pattern: /^[A-Za-z0-9._:-]+$/,
    },
    input: zodOperationCodec('resource-catalog.package.apply.input.v1', applyResourcePackageSchema),
    output: zodOperationCodec(
      'resource-catalog.package.apply.output.v1',
      resourcePackageApplyReceiptSchema,
    ),
    invoke: (context: CommandContext, input: ApplyResourcePackage) =>
      commands.apply(context, input),
  })
  return Object.freeze({
    inspect: defineCommandOperation({
      id: 'resource-catalog.inspect-package.v1',
      summary: 'Inspect a staged resource package',
      permissions: [],
      publicReason: 'Package entries determine their own exact resource permissions.',
      publicErrors: RESOURCE_PACKAGE_PUBLIC_ERRORS,
      inputSchema: inspectResourcePackageSchema,
      outputSchema: resourcePackagePreviewReceiptSchema,
      invoke: (context: CommandContext, input: InspectResourcePackage) =>
        commands.inspect(context, input),
    }),
    apply,
    getPreview: defineQueryOperation({
      id: 'resource-catalog.get-package-preview.v1',
      summary: 'Read one staged resource package preview',
      permissions: [],
      publicReason: 'The preview handle is minted by the authenticated package operation.',
      publicErrors: RESOURCE_PACKAGE_PUBLIC_ERRORS,
      inputSchema: getResourcePackagePreviewSchema,
      outputSchema: resourcePackagePreviewViewSchema,
      invoke: (context: QueryContext, input: GetResourcePackagePreview) =>
        queries.getPreview(context, input),
    }),
    getReceipt: defineQueryOperation({
      id: 'resource-catalog.get-package-receipt.v1',
      summary: 'Read one resource package apply receipt',
      permissions: [],
      publicReason: 'The receipt handle is minted by the authenticated package operation.',
      publicErrors: RESOURCE_PACKAGE_PUBLIC_ERRORS,
      inputSchema: getResourcePackageApplyReceiptSchema,
      outputSchema: resourcePackageApplyReceiptViewSchema,
      invoke: (context: QueryContext, input: GetResourcePackageApplyReceipt) =>
        queries.getReceipt(context, input),
    }),
    exports: Object.freeze({
      agent: exportOperation(
        'resource-catalog.export-agent-package.v1',
        'Export an agent with its transitive closure',
        'agents:read',
      ),
      skill: exportOperation(
        'resource-catalog.export-skill-package.v1',
        'Export a skill with its transitive closure',
        'skills:read',
      ),
      mcp: exportOperation(
        'resource-catalog.export-mcp-package.v1',
        'Export an MCP with its transitive closure',
        'mcps:read',
      ),
      plugin: exportOperation(
        'resource-catalog.export-plugin-package.v1',
        'Export a plugin with its transitive closure',
        'plugins:read',
      ),
      workflow: exportOperation(
        'resource-catalog.export-workflow-package.v1',
        'Export a workflow with its transitive closure',
        'workflows:read',
      ),
      workgroup: exportOperation(
        'resource-catalog.export-workgroup-package.v1',
        'Export a workgroup with its transitive closure',
        'workgroups:read',
      ),
      capability_template: exportOperation(
        'resource-catalog.export-capability-template-package.v1',
        'Export a capability template',
        'capability-templates:read',
      ),
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
