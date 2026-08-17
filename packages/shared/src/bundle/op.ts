// RFC-271 — `ResourceBundle` 的操作集与顶层。
//
// ⚠️ **必须是 12 分支 discriminated union，不能是 optional 字段全开的对象**
// （R4-P1-4 / R7-P1-4）。反例：`{kind:'mcp-update', target, payload}` 不带 `expect`
// 能通过宽松 schema，而 `commitMcpUpdateInTx` 只在 `expectedConfigHash !== undefined`
// 时才 CAS ⇒ **无栅栏覆盖**。
//
// create：必须有 slug、禁 target/expect
// update：必须是 external target、禁 slug、**必须**带该资源类型专属的 expect

import { z } from 'zod'
import {
  BundleAgentPayloadSchema,
  BundleCapabilityBindingPayloadSchema,
  BundleCapabilityTemplatePayloadSchema,
  BundleCapabilityFrameworkPayloadSchema,
  BundleMcpPayloadSchema,
  BundlePluginPayloadSchema,
  BundleSkillPayloadSchema,
  BundleWorkflowPayloadSchema,
  BundleWorkgroupPayloadSchema,
} from './payload'

/** 单个包最多 512 个 op（AC-B5：产品限制，显式披露 + 专门错误码）。 */
export const BUNDLE_MAX_OPS = 512

export const BundleOpIdSchema = z.string().regex(/^op-[1-9][0-9]{0,3}$/, 'opId must be op-<n>')
export const BundleSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
export const BundleExternalTargetSchema = z
  .string()
  .regex(/^external:[A-Za-z0-9._:#/-]{1,128}$/, 'update target must be an external ref')

// --- 内容级 CAS token（AC-24 / R7-P2-13：各类型用它自己的**完整**形态） ---

/** 工作流 / 工作组。 */
const VersionExpect = z.object({ expectedVersion: z.number().int().positive() }).strict()
/** 代理：正式 mutation revision 是这**两个**（agent.ts:414），少一个就漏漂移。 */
const AgentExpect = z
  .object({
    expectedUpdatedAt: z.number().int(),
    expectedAclRevision: z.number().int().nonnegative(),
  })
  .strict()
/** MCP / 插件。 */
const ConfigHashExpect = z.object({ expectedConfigHash: z.string().min(1) }).strict()
/** 技能：只改 description 会推进 metaRevision 而 contentVersion 不变 ⇒ 两个都要。 */
const SkillExpect = z
  .object({
    expectedContentVersion: z.number().int().nonnegative(),
    expectedMetaRevision: z.number().int().nonnegative(),
    expectedAclRevision: z.number().int().nonnegative(),
  })
  .strict()

export const BundleExpectTokenSchema = z.union([
  VersionExpect,
  AgentExpect,
  ConfigHashExpect,
  SkillExpect,
])
export type BundleExpectToken = z.infer<typeof BundleExpectTokenSchema>

// --- 16 分支 ---

const createOp = <K extends string, P extends z.ZodTypeAny>(kind: K, payload: P) =>
  z
    .object({
      opId: BundleOpIdSchema,
      kind: z.literal(kind),
      slug: BundleSlugSchema,
      payload,
    })
    .strict()

const updateOp = <K extends string, P extends z.ZodTypeAny, E extends z.ZodTypeAny>(
  kind: K,
  payload: P,
  expect: E,
) =>
  z
    .object({
      opId: BundleOpIdSchema,
      kind: z.literal(kind),
      target: BundleExternalTargetSchema,
      expect,
      payload,
    })
    .strict()

export const BundleOpSchema = z.discriminatedUnion('kind', [
  createOp('agent-create', BundleAgentPayloadSchema),
  updateOp('agent-update', BundleAgentPayloadSchema, AgentExpect),
  createOp('skill-create', BundleSkillPayloadSchema),
  updateOp('skill-update', BundleSkillPayloadSchema, SkillExpect),
  createOp('mcp-create', BundleMcpPayloadSchema),
  updateOp('mcp-update', BundleMcpPayloadSchema, ConfigHashExpect),
  createOp('plugin-create', BundlePluginPayloadSchema),
  updateOp('plugin-update', BundlePluginPayloadSchema, ConfigHashExpect),
  createOp('workflow-create', BundleWorkflowPayloadSchema),
  updateOp('workflow-update', BundleWorkflowPayloadSchema, VersionExpect),
  createOp('workgroup-create', BundleWorkgroupPayloadSchema),
  updateOp('workgroup-update', BundleWorkgroupPayloadSchema, VersionExpect),
  // RFC-304 T17a — the two capability template layers.
  //
  // Both use `AgentExpect`'s shape because both tables carry exactly that drift
  // surface (`updatedAt` + `aclRevision`) — the same reasoning that put agents
  // on it, not a coincidence worth a fourth expect type.
  createOp('capability-framework-create', BundleCapabilityFrameworkPayloadSchema),
  updateOp('capability-framework-update', BundleCapabilityFrameworkPayloadSchema, AgentExpect),
  createOp('capability-binding-create', BundleCapabilityBindingPayloadSchema),
  updateOp('capability-binding-update', BundleCapabilityBindingPayloadSchema, AgentExpect),
  // RFC-309 — the merged template. The four ops above are kept so packages
  // exported before the merge still import (AC-12); only this one is produced.
  createOp('capability-template-create', BundleCapabilityTemplatePayloadSchema),
  updateOp('capability-template-update', BundleCapabilityTemplatePayloadSchema, AgentExpect),
])
export type BundleOp = z.infer<typeof BundleOpSchema>

export const BUNDLE_OP_KINDS = [
  'agent-create',
  'agent-update',
  'skill-create',
  'skill-update',
  'mcp-create',
  'mcp-update',
  'plugin-create',
  'plugin-update',
  'workflow-create',
  'workflow-update',
  'workgroup-create',
  'workgroup-update',
  'capability-framework-create',
  'capability-framework-update',
  'capability-binding-create',
  'capability-binding-update',
  'capability-template-create',
  'capability-template-update',
] as const
export type BundleOpKind = (typeof BUNDLE_OP_KINDS)[number]
