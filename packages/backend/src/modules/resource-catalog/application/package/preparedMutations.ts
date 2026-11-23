// RFC-550 (RFC-294 S9): the package mutations a bundle apply prepares — the per-resource mutation and prepared types,
// their union, its kind guards and the per-resource receipt. They sat on `public/types` without any other module
// consuming them.
import type { PackageResourceKind } from '../../public/types'
import type { BundleOp } from '@agent-workflow/shared'

export interface ResourcePackageMutationReceipt<
  K extends PackageResourceKind = PackageResourceKind,
> {
  readonly resourceType: K
  readonly operationId: string
  readonly resourceId: string
  readonly action: 'create' | 'update'
  readonly name: string
}

export type PreparedPackageMutation =
  | PreparedAgentPackageMutation
  | PreparedSkillPackageMutation
  | PreparedMcpPackageMutation
  | PreparedPluginPackageMutation
  | PreparedWorkflowPackageMutation
  | PreparedWorkgroupPackageMutation
  | PreparedCapabilityTemplatePackageMutation

/**
 * RFC-359 W8 —— 「这条已准备好的包变更属于哪类资源」：**一份实现，两个 provider 共用**。
 *
 * 合一前 `platform/persistence/sqlite/legacyResourcePackageBundleApply.ts` 与
 * `platform/persistence/postgresqlResourcePackageAtomicApply.ts` 各揣一份**整族七个**逐字相同
 * 的类型谓词，差别只有函数名（`isPreparedAgentPackageMutation` vs `isPreparedAgent`）。
 *
 * 2026-10-22 RFC-395 II-a A6：当前 apply 场景已迁入 resource-catalog infrastructure，共用 AtomicApply 机制。
 *
 * 判据本身是上面这个可辨识联合的**性质**，不是任一 provider 的性质：`mutation.kind` 的取值
 * 由公共合同定义，两个应用引擎只是消费者。两份并存的唯一后果是——往联合里加一种 kind 时
 * 漏改一侧，那一侧的引擎会**静默跳过**该类变更（谓词返回 false，走不到对应分支），
 * 而两条路径各自的用例都还绿着。
 *
 * 收成一个冻结对象而不是七个具名导出：消费者只多一条 import 边，而不是七条。
 *
 * 键名保留 `isPrepared*` 前缀而不是更短的 `isAgent`：`rfc317-registry-reverse-completeness`
 * 的键级判据按**键名文本**找消费者（`census.ts` 的注释里自陈了这个弱点，靠符号级判据兜底），
 * 一个叫 `isAgent` 的键会被算成 `NODE_KIND_BEHAVIORS.isAgent` 的直接消费者，把那条豁免判成过期。我的键名是任意的，注册表的不是——所以让路的是这边。
 */
export const preparedPackageMutation = Object.freeze({
  isPreparedAgent: (prepared: PreparedPackageMutation): prepared is PreparedAgentPackageMutation =>
    prepared.mutation.kind === 'agent-create' || prepared.mutation.kind === 'agent-update',
  isPreparedSkill: (prepared: PreparedPackageMutation): prepared is PreparedSkillPackageMutation =>
    prepared.mutation.kind === 'skill-create' || prepared.mutation.kind === 'skill-update',
  isPreparedMcp: (prepared: PreparedPackageMutation): prepared is PreparedMcpPackageMutation =>
    prepared.mutation.kind === 'mcp-create' || prepared.mutation.kind === 'mcp-update',
  isPreparedPlugin: (
    prepared: PreparedPackageMutation,
  ): prepared is PreparedPluginPackageMutation =>
    prepared.mutation.kind === 'plugin-create' || prepared.mutation.kind === 'plugin-update',
  isPreparedWorkflow: (
    prepared: PreparedPackageMutation,
  ): prepared is PreparedWorkflowPackageMutation =>
    prepared.mutation.kind === 'workflow-create' || prepared.mutation.kind === 'workflow-update',
  isPreparedWorkgroup: (
    prepared: PreparedPackageMutation,
  ): prepared is PreparedWorkgroupPackageMutation =>
    prepared.mutation.kind === 'workgroup-create' || prepared.mutation.kind === 'workgroup-update',
  isPreparedCapabilityTemplate: (
    prepared: PreparedPackageMutation,
  ): prepared is PreparedCapabilityTemplatePackageMutation =>
    prepared.mutation.kind === 'capability-framework-create' ||
    prepared.mutation.kind === 'capability-framework-update' ||
    prepared.mutation.kind === 'capability-binding-create' ||
    prepared.mutation.kind === 'capability-binding-update' ||
    prepared.mutation.kind === 'capability-template-create' ||
    prepared.mutation.kind === 'capability-template-update',
})

declare const preparedPackageMutationBrand: unique symbol

export interface PreparedAgentPackageMutation {
  readonly [preparedPackageMutationBrand]: 'agent'
  readonly mutation: AgentPackageMutation
}

export interface PreparedSkillPackageMutation {
  readonly [preparedPackageMutationBrand]: 'skill'
  readonly mutation: SkillPackageMutation
}

export interface PreparedMcpPackageMutation {
  readonly [preparedPackageMutationBrand]: 'mcp'
  readonly mutation: McpPackageMutation
}

export interface PreparedPluginPackageMutation {
  readonly [preparedPackageMutationBrand]: 'plugin'
  readonly mutation: PluginPackageMutation
}

export interface PreparedWorkflowPackageMutation {
  readonly [preparedPackageMutationBrand]: 'workflow'
  readonly mutation: WorkflowPackageMutation
}

export interface PreparedWorkgroupPackageMutation {
  readonly [preparedPackageMutationBrand]: 'workgroup'
  readonly mutation: WorkgroupPackageMutation
}

export interface PreparedCapabilityTemplatePackageMutation {
  readonly [preparedPackageMutationBrand]: 'capability_template'
  readonly mutation: CapabilityTemplatePackageMutation
}

export type AgentPackageMutation = Extract<BundleOp, { kind: 'agent-create' | 'agent-update' }>

export type SkillPackageMutation = Extract<BundleOp, { kind: 'skill-create' | 'skill-update' }>

export type McpPackageMutation = Extract<BundleOp, { kind: 'mcp-create' | 'mcp-update' }>

export type PluginPackageMutation = Extract<BundleOp, { kind: 'plugin-create' | 'plugin-update' }>

export type WorkflowPackageMutation = Extract<
  BundleOp,
  { kind: 'workflow-create' | 'workflow-update' }
>

export type WorkgroupPackageMutation = Extract<
  BundleOp,
  { kind: 'workgroup-create' | 'workgroup-update' }
>

export type CapabilityTemplatePackageMutation = Extract<
  BundleOp,
  {
    kind:
      | 'capability-framework-create'
      | 'capability-framework-update'
      | 'capability-binding-create'
      | 'capability-binding-update'
      | 'capability-template-create'
      | 'capability-template-update'
  }
>
