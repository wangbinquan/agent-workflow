// RFC-271 — `ResourceBundle` 的六类资源 payload。
//
// **逐字段对照正式 create/snapshot schema**（AC-B3b），不是「相对 Intent*Payload
// 的差异」。R7-P1-2 / R7-P2-10 各查出一处因为照抄 intent 版而丢字段的缺陷：
//
//   · agent.network —— CreateAgentSchema 有、IntentAgentPayloadSchema 没有。
//     照抄 intent 版 ⇒ 导出再导入会静默回落成 'deny'，执行行为改变。
//   · plugin 的字段名 —— 正式是 `options`，intent 是 `optionsJson`。两处规范打架
//     会让 exporter/importer 各按一处实现 ⇒ 严格 parse 失败或选项丢失。
//     **本文件一律用正式名。**
//
// 引用槽存的是**该槽所属域的 wire 编码**（字符串/对象），由 ../ref/codecs 解码。
// 槽位分层是硬约束（R4-P2-9 / R8-P1-1）：
//   dependsOn / mcp / plugins   → BundleIdentityRef（local: | external: | builtin:）
//   skills                      → BundleAgentSkillRef（+ project:）← 第四个域
//   call 目标                   → BundleCallRef（+ name: / builtin:）

import { z } from 'zod'
import {
  AgentInputPortsSchema,
  AgentOutputKindsMapSchema,
  AgentOutputWrapperPortNamesSchema,
  AgentPermissionSchema,
  AgentRoleSchema,
} from '../schemas/agent'
import { McpLocalConfigSchema, McpRemoteConfigSchema } from '../schemas/mcp'
import { PluginOptionsSchema, PluginSourceKindSchema } from '../schemas/plugin'
import type { AclResourceType } from '../schemas/resourceAcl'
import { WorkgroupModeSchema, WorkgroupSwitchesSchema } from '../schemas/workgroup'
import {
  decodeBundleAgentSkillRef,
  decodeBundleCallRef,
  decodeBundleIdentityRef,
  type ResourceRefAst,
} from '../ref'

// --- 引用槽的 wire 形态（词法校验；语义解码在 ../ref/codecs） ---

/**
 * `local:<slug>` | `external:<token>` | `builtin:<type>/<name>`
 *
 * 第三种是框架 built-in（`agents` / `workflows` 有 `builtin` 列，owner 通常
 * `__system__`）。它**照常进包**（否则引用无从解释）但**不产 create op**，导入时
 * 按名字绑到对端自己 seed 的那一个 —— 复制一份只会在对端多出 owner 错、
 * `builtin=false` 的同名副本，而真正的 built-in 仍在原处。
 */
export const BundleIdentityRefWireSchema = z
  .string()
  .refine((wire) => decodeBundleIdentityRef(wire) !== null, {
    message: 'must be local:<slug>, external:<token> or builtin:<type>/<name>',
  })

/** 上面两种 + `project:<name>`。**仅** agent 的 `skills` 槽（R8-P1-1）。 */
export const BundleAgentSkillRefWireSchema = z
  .string()
  .refine((wire) => decodeBundleAgentSkillRef(wire) !== null, {
    message: 'must be local:/external:/project:',
  })

/** 上面两种 + `name:<type>/<name>`（late-bound）。仅 call 目标槽。 */
export const BundleCallRefWireSchema = z
  .string()
  .refine((wire) => decodeBundleCallRef(wire) !== null, {
    message: 'must be local:/external:/name:/builtin:',
  })

/**
 * Identity 域本身合法不等于具体槽合法。`builtin:` 自带声明类型，必须在
 * payload schema 边界就与槽位 expected type 对上；否则 `mcp: ['builtin:agent/x']`
 * 会得到 preview 假阳性，只在 lowering 才报错。
 */
function identityRefWireFor(expectedType: AclResourceType) {
  return BundleIdentityRefWireSchema.superRefine((wire, ctx) => {
    const decoded = decodeBundleIdentityRef(wire)
    if (decoded?.k !== 'builtin' || decoded.type === expectedType) return
    ctx.addIssue({
      code: 'custom',
      message: `builtin ref declares ${decoded.type}, but this slot expects ${expectedType}`,
    })
  })
}

const BundleAgentIdentityRefWireSchema = identityRefWireFor('agent')
const BundleMcpIdentityRefWireSchema = identityRefWireFor('mcp')
const BundlePluginIdentityRefWireSchema = identityRefWireFor('plugin')

function declaredTypeMatches(
  ref: ResourceRefAst,
  expected: 'agent' | 'workflow' | 'workgroup',
): boolean {
  return (ref.k !== 'name' && ref.k !== 'builtin') || ref.type === expected
}

/**
 * definition 内的 wire 槽不能因为外层是 `record` 就绕过域 codec。这里只校验
 * lowering 负责的三种引用字段；其余 workflow canonical 结构仍由正式 schema
 * 在 apply 时校验。
 */
export const BundleWorkflowDefinitionSchema = z
  .record(z.string(), z.unknown())
  .superRefine((definition, ctx) => {
    if (!Array.isArray(definition.nodes)) return
    const check = (
      node: Record<string, unknown>,
      index: number,
      field: 'agentRef' | 'workflowRef' | 'workgroupRef',
      expected: 'agent' | 'workflow' | 'workgroup',
    ): void => {
      const wire = node[field]
      if (wire === undefined) return
      const decoded =
        typeof wire !== 'string'
          ? null
          : field === 'agentRef'
            ? decodeBundleIdentityRef(wire)
            : decodeBundleCallRef(wire)
      if (decoded !== null && declaredTypeMatches(decoded, expected)) return
      ctx.addIssue({
        code: 'custom',
        path: ['nodes', index, field],
        message: `${field} must be a valid ${expected} bundle reference`,
      })
    }

    for (const [index, raw] of definition.nodes.entries()) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const node = raw as Record<string, unknown>
      // Bundle wire 必须只携带 portable ref。若允许 canonical id/name 字段夹带进来，
      // hand-built 包就能绕开 external/builtin 的 provider 解析、manifest 对照与预检面。
      for (const field of [
        'agentId',
        'workflowName',
        'workflowId',
        'workgroupName',
        'workgroupId',
      ] as const) {
        if (node[field] === undefined) continue
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, field],
          message: `${field} is canonical-only; bundle definitions must use *Ref fields`,
        })
      }
      check(node, index, 'agentRef', 'agent')
      check(node, index, 'workflowRef', 'workflow')
      check(node, index, 'workgroupRef', 'workgroup')

      const requiredRef =
        node.kind === 'agent-single'
          ? 'agentRef'
          : node.kind === 'call-workflow'
            ? 'workflowRef'
            : node.kind === 'call-workgroup'
              ? 'workgroupRef'
              : null
      if (requiredRef !== null && node[requiredRef] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, requiredRef],
          message: `${String(node.kind)} nodes require ${requiredRef} in bundle wire`,
        })
      }
    }
  })

// --- agent ---

export const BundleAgentPayloadSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(4096).default(''),
    outputs: z.array(z.string()).default([]),
    outputKinds: AgentOutputKindsMapSchema.optional(),
    inputs: AgentInputPortsSchema.optional(),
    outputWrapperPortNames: AgentOutputWrapperPortNamesSchema.optional(),
    role: AgentRoleSchema.optional(),
    syncOutputsOnIterate: z.boolean().default(true),
    /** runtime PROFILE NAME（不是资源引用——runtime 不是六类 ACL 资源之一）。
     *  它进 manifest.requirements.runtimes，导入方需自备同名执行档。 */
    runtime: z.string().min(1).max(128).optional(),
    /** ⚠️ AC-B3b：intent 版没有这个字段，照抄会让导入后静默回落成 'deny'。 */
    network: z.enum(['deny', 'allow']).optional(),
    permission: AgentPermissionSchema.default({}),
    /** 第四个槽位域：唯一允许 `project:` 的地方。 */
    skills: z.array(BundleAgentSkillRefWireSchema).max(64).default([]),
    dependsOn: z.array(BundleAgentIdentityRefWireSchema).max(64).default([]),
    mcp: z.array(BundleMcpIdentityRefWireSchema).max(64).default([]),
    plugins: z.array(BundlePluginIdentityRefWireSchema).max(64).default([]),
    frontmatterExtra: z.record(z.string(), z.unknown()).default({}),
    bodyMd: z.string().default(''),
  })
  .strict()
export type BundleAgentPayload = z.infer<typeof BundleAgentPayloadSchema>

// --- skill ---

/** 技能文件是任意字节（含二进制），因此走**外部载体引用**而不是内联。 */
export const BundleSkillFileSchema = z
  .object({
    /** 相对路径。词法与正式写路径一致：相对、不越界；**允许非 ASCII**（AC-B3b）。 */
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
        message: 'path must be relative and must not traverse',
      }),
    /** 载体引用：包内 zip 路径 / intent 的内联句柄。由 provider 的 readSkillFile 解。 */
    ref: z.string().min(1).max(1024),
  })
  .strict()

export const BundleSkillPayloadSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(4096).default(''),
    /** SKILL.md 的 frontmatter + 正文（正式形态，见 shared/skill-md.ts）。 */
    frontmatterExtra: z.record(z.string(), z.unknown()).default({}),
    bodyMd: z.string().default(''),
    /** 除 SKILL.md 外的辅助文件。 */
    files: z.array(BundleSkillFileSchema).max(2000).default([]),
  })
  .strict()
  .superRefine((payload, ctx) => {
    for (const key of ['path', 'ref'] as const) {
      const seen = new Set<string>()
      for (const [index, file] of payload.files.entries()) {
        if (!seen.has(file[key])) {
          seen.add(file[key])
          continue
        }
        ctx.addIssue({
          code: 'custom',
          path: ['files', index, key],
          message: `skill file ${key} must be unique`,
        })
      }
    }
  })
export type BundleSkillPayload = z.infer<typeof BundleSkillPayloadSchema>

// --- mcp ---

/** ⚠️ 保留 `McpLocalConfig` / `McpRemoteConfig` 的**原结构**：脱敏只换值不换形状，
 *  否则产物过不了自己的 schema（R2-D1：dump 投影把 oauth 变成字符串的教训）。 */
export const BundleMcpPayloadSchema = z.discriminatedUnion('type', [
  z
    .object({
      name: z.string().min(1).max(128),
      description: z.string().max(4096).default(''),
      type: z.literal('local'),
      enabled: z.boolean().default(true),
      config: McpLocalConfigSchema,
    })
    .strict(),
  z
    .object({
      name: z.string().min(1).max(128),
      description: z.string().max(4096).default(''),
      type: z.literal('remote'),
      enabled: z.boolean().default(true),
      config: McpRemoteConfigSchema,
    })
    .strict(),
])
export type BundleMcpPayload = z.infer<typeof BundleMcpPayloadSchema>

// --- plugin ---

export const BundlePluginPayloadSchema = z
  .object({
    name: z.string().min(1).max(128),
    /** ⚠️ 正式字段名是 `options`（intent 版叫 `optionsJson`）—— R7-P2-10。 */
    options: PluginOptionsSchema.default({}),
    spec: z.string().min(1).max(512),
    description: z.string().max(4096).default(''),
    enabled: z.boolean().default(true),
    sourceKind: PluginSourceKindSchema,
    // 决策 13：不带 cachedPath / resolvedVersion / installedAt（机器本地产物）。
  })
  .strict()
export type BundlePluginPayload = z.infer<typeof BundlePluginPayloadSchema>

// --- workflow ---

/** 节点里的引用槽已经被 lowering 成 wire 形态；definition 其余部分原样。 */
export const BundleWorkflowPayloadSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(4096).default(''),
    definition: BundleWorkflowDefinitionSchema,
  })
  .strict()
export type BundleWorkflowPayload = z.infer<typeof BundleWorkflowPayloadSchema>

// --- workgroup ---

/**
 * 成员。agent 成员走 identity 域；human 成员带 **username**（跨实例标识）——
 * intent 版只有占位符（模型不许绑人），包必须能带。
 */
export const BundleWorkgroupMemberSchema = z.discriminatedUnion('memberType', [
  z
    .object({
      memberType: z.literal('agent'),
      agentRef: BundleAgentIdentityRefWireSchema,
      displayName: z.string().min(1).max(64),
      roleDesc: z.string().max(2048).default(''),
      sortOrder: z.number().int(),
    })
    .strict(),
  z
    .object({
      memberType: z.literal('human'),
      username: z.string().min(1).max(64),
      displayName: z.string().min(1).max(64),
      roleDesc: z.string().max(2048).default(''),
      sortOrder: z.number().int(),
    })
    .strict(),
])

export const BundleWorkgroupPayloadSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(4096).default(''),
    instructions: z.string().max(65536).default(''),
    mode: WorkgroupModeSchema,
    switches: WorkgroupSwitchesSchema,
    maxRounds: z.number().int().positive(),
    completionGate: z.boolean(),
    clarifyBudget: z.number().int().min(0).max(50).optional(),
    fanOut: z.boolean().optional(),
    members: z.array(BundleWorkgroupMemberSchema).max(64).default([]),
    /** `leaderMemberId` 是本地行 id，不可移植；组内 displayName 唯一，可作稳定键。 */
    leaderDisplayName: z.string().min(1).max(64).nullable(),
  })
  .strict()
export type BundleWorkgroupPayload = z.infer<typeof BundleWorkgroupPayloadSchema>
