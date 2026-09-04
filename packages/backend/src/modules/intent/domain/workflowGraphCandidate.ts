// RFC-358 §3 —— 「变更集里的工作流 op → 可校验候选」的**纯判据**。
//
// 工作流图校验器（`workflow.validator.ts`）读的是**已解析**的定义：`agent-single.agentId`、
// `call-workflow.workflowId`。而变更集里是未解析的 `agentRef` / `workflowRef`（`res#agent#3`
// 句柄或 `$new:auditor` tempRef），draft 期更连最终 id 都还没铸。所以要一次「假想解析」。
//
// 三件事在这里一次做完，且**只有这一份**：
//   ① 前置 `WorkflowDefinitionSchema` —— 意图侧的定义 schema 是 loose 的
//      （`edges: z.array(z.unknown())`、node `.passthrough()`），而校验器第一件事就解引用
//      `edge.target.nodeId`。直喂会抛 TypeError，被 turnEngine 的既有 catch 兜成
//      `intent-turn-crashed`：模型这一轮的产出全丢、生成轮白烧、用户只看到一句崩溃 detail。
//      比现状（照常出 draft、apply 时给可读的 `intent-op-canonical-invalid`）更差。
//   ② 引用重写 —— 与 apply 期逐条同形。`resolveChangeset` 的那份改调本文件，避免同判据
//      两份（RFC-355 T1 实测过：同一处 changeset 校验在两个 provider 上真的漂过）。
//      唯一的分叉是解析不出时的处置，见 `IntentGraphRefMode`。
//   ③ 四类覆盖层 —— 本变更集里**即将存在**的资源。少任何一类，一个完全合法的变更集都会
//      被判红，而生成它的 agent 改不掉（它建的技能就在同一批里）。

import {
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  isIntentTempRef,
  type Agent,
  type IntentChangeset,
  type IntentOp,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type {
  WorkflowValidationAgentOverlay,
  WorkflowValidationCandidateOverlays,
  WorkflowValidationWorkflowOverlay,
} from '@/modules/resource-catalog/public/types'

/**
 * 解析不出引用时的处置——draft 与 apply 的**唯一**差别。
 *
 * · `draft`：跳过该 op 的图校验。第一层已经报过同源的错误（未知句柄 / 未声明 tempRef），
 *   在这里重复报只会淹没真正的图问题，而且此刻本来就没有可校验的定义。
 * · `apply`：抛。`resolveChangeset` 的既有行为是 `intent-ref-unknown`，不得改变。
 */
export type IntentGraphRefMode = 'draft' | 'apply'

export interface IntentGraphRefResolution {
  /** 句柄 → 真实 canonical id（来自本轮 manifest）。 */
  readonly byHandle: ReadonlyMap<string, string>
  /** tempRef → 本次校验用的 id（draft 期占位、apply 期最终）。 */
  readonly byTempRef: ReadonlyMap<string, string>
}

export class IntentGraphRefUnresolved extends Error {
  readonly ref: string
  constructor(ref: string) {
    super(`unknown reference ${ref}`)
    this.name = 'IntentGraphRefUnresolved'
    this.ref = ref
  }
}

/** draft 期的占位 id。只要求本次校验内唯一且不与真实 ULID 相撞——校验器对 agent id
 *  只做字典查找，不校验形状。 */
export function pendingGraphIdOf(opId: string): string {
  return `intent-pending:${opId}`
}

/** draft 期的解析表：句柄取 manifest 的真实 id，create op 取占位 id。 */
export function draftGraphResolution(
  manifest: readonly { handle: string; resourceId: string }[],
  changeset: IntentChangeset,
): IntentGraphRefResolution {
  const byTempRef = new Map<string, string>()
  for (const op of changeset.ops) {
    if (op.action === 'create') byTempRef.set(op.tempRef, pendingGraphIdOf(op.opId))
  }
  return {
    byHandle: new Map(manifest.map((entry) => [entry.handle, entry.resourceId])),
    byTempRef,
  }
}

function resolveRef(
  ref: string,
  resolution: IntentGraphRefResolution,
  mode: IntentGraphRefMode,
): string | undefined {
  const resolved = isIntentTempRef(ref)
    ? resolution.byTempRef.get(ref)
    : resolution.byHandle.get(ref)
  if (resolved !== undefined) return resolved
  if (mode === 'apply') throw new IntentGraphRefUnresolved(ref)
  return undefined
}

/**
 * 把定义里的 `agentRef` / `workflowRef` / `workgroupRef` 换成 id 缓存。
 *
 * 与 apply 期（`resolveChangeset.ts` 的 workflow 分支）**逐条同形**——保留 `workflowId` /
 * `workgroupId` 缓存正是那边的要点：名字本身无法消歧两个同名行，丢掉缓存会让下一次启动
 * 回落到「最老的可见 ULID」，静默跑另一个工作流。
 *
 * 返回 `undefined` = 有引用解析不出（仅 draft 模式；apply 模式已经抛了）。
 */
export function rewriteIntentWorkflowRefs(
  definition: unknown,
  resolution: IntentGraphRefResolution,
  mode: IntentGraphRefMode,
): Record<string, unknown> | undefined {
  const def = JSON.parse(JSON.stringify(definition)) as {
    nodes?: Array<Record<string, unknown>>
  }
  for (const node of def.nodes ?? []) {
    if (node.kind === 'agent-single' && typeof node.agentRef === 'string') {
      const resolved = resolveRef(node.agentRef, resolution, mode)
      if (resolved === undefined) return undefined
      delete node.agentRef
      node.agentId = resolved
      continue
    }
    if (node.kind === 'call-workflow' && typeof node.workflowRef === 'string') {
      const resolved = resolveRef(node.workflowRef, resolution, mode)
      if (resolved === undefined) return undefined
      delete node.workflowRef
      node.workflowId = resolved
    } else if (node.kind === 'call-workgroup' && typeof node.workgroupRef === 'string') {
      const resolved = resolveRef(node.workgroupRef, resolution, mode)
      if (resolved === undefined) return undefined
      delete node.workgroupRef
      node.workgroupId = resolved
    }
  }
  return def as Record<string, unknown>
}

/** 本 op 在本次校验里的身份 id。 */
function graphIdOfOp(
  op: IntentOp,
  resolution: IntentGraphRefResolution,
  mode: IntentGraphRefMode,
): string | undefined {
  return op.action === 'create'
    ? resolveRef(op.tempRef, resolution, mode)
    : resolveRef(op.target, resolution, mode)
}

/**
 * agent 覆盖层。
 *
 * 「省略 = 保留存值」**不是**统一规则：zod 的 `.default([])` 让 `outputs` / `skills` /
 * `dependsOn` / `mcp` / `plugins` 解析后永远存在，apply 无条件覆盖；只有 `.optional()` 的
 * `outputKinds` / `branchPorts` / `outputWrapperPortNames` / `role` 才是省略即保留。
 * 这张表**逐字段镜像** `resolveChangeset.ts` 的 agent 分支——两份判据只要有两处，迟早会漂。
 */
function agentOverlayOf(
  op: Extract<IntentOp, { resourceType: 'agent' }>,
  agentId: string,
  resolution: IntentGraphRefResolution,
  mode: IntentGraphRefMode,
): WorkflowValidationAgentOverlay | undefined {
  const p = op.payload
  const mapRefs = (refs: readonly string[]): readonly string[] | undefined => {
    const out: string[] = []
    for (const ref of refs) {
      const resolved = resolveRef(ref, resolution, mode)
      if (resolved === undefined) return undefined
      out.push(resolved)
    }
    return out
  }
  const skills: Agent['skills'] = []
  for (const entry of p.skills) {
    if (typeof entry === 'string') {
      const resolved = resolveRef(entry, resolution, mode)
      if (resolved === undefined) return undefined
      skills.push({ kind: 'managed', skillId: resolved })
      continue
    }
    skills.push(entry)
  }
  const dependsOn = mapRefs(p.dependsOn)
  const mcp = mapRefs(p.mcp)
  const plugins = mapRefs(p.plugins)
  if (dependsOn === undefined || mcp === undefined || plugins === undefined) return undefined
  return {
    agentId,
    isNew: op.action === 'create',
    fields: {
      // 无条件覆盖（`.default([])`，apply 侧同样无条件写）
      name: p.name,
      outputs: p.outputs,
      skills,
      dependsOn,
      mcp,
      plugins,
      // 省略即保留（`.optional()`）
      ...(p.outputKinds === undefined ? {} : { outputKinds: p.outputKinds }),
      ...(p.branchPorts === undefined ? {} : { branchPorts: p.branchPorts }),
      ...(p.outputWrapperPortNames === undefined
        ? {}
        : { outputWrapperPortNames: p.outputWrapperPortNames }),
      ...(p.role === undefined ? {} : { role: p.role }),
    },
  }
}

export interface IntentWorkflowGraphCandidate {
  readonly opId: string
  readonly definition: WorkflowDefinition
  /** 候选自己的身份——自调用判据读 name、环走查以 id 为根，两者都必须给。 */
  readonly currentWorkflow: { readonly id: string; readonly name: string }
}

export interface IntentGraphCandidateSet {
  readonly candidates: readonly IntentWorkflowGraphCandidate[]
  readonly overlays: WorkflowValidationCandidateOverlays
  /** op 级 blocking error（畸形定义 / 引用解析不出），已带 `<opId>: ` 前缀。 */
  readonly errors: readonly string[]
  /** 因引用解析不出而跳过图校验的 opId（仅 draft 模式）。 */
  readonly skipped: readonly string[]
}

export function buildIntentGraphCandidates(input: {
  readonly changeset: IntentChangeset
  readonly resolution: IntentGraphRefResolution
  readonly mode: IntentGraphRefMode
}): IntentGraphCandidateSet {
  const { changeset, resolution, mode } = input
  const candidates: IntentWorkflowGraphCandidate[] = []
  const errors: string[] = []
  const skipped: string[] = []
  const agents: WorkflowValidationAgentOverlay[] = []
  const skills: { id: string; name: string }[] = []
  const mcps: { id: string; name: string; enabled: boolean }[] = []
  const plugins: { id: string; name: string; enabled: boolean }[] = []
  const callWorkflows: WorkflowValidationWorkflowOverlay[] = []

  for (const op of changeset.ops) {
    const id = graphIdOfOp(op, resolution, mode)
    if (id === undefined) {
      skipped.push(op.opId)
      continue
    }
    switch (op.resourceType) {
      case 'agent': {
        const overlay = agentOverlayOf(op, id, resolution, mode)
        if (overlay === undefined) skipped.push(op.opId)
        else agents.push(overlay)
        break
      }
      case 'skill':
        skills.push({ id, name: op.payload.name })
        break
      case 'mcp':
        mcps.push({ id, name: op.payload.name, enabled: op.payload.enabled ?? true })
        break
      case 'plugin':
        plugins.push({ id, name: op.payload.name, enabled: op.payload.enabled ?? true })
        break
      case 'workflow': {
        const rewritten = rewriteIntentWorkflowRefs(op.payload.definition, resolution, mode)
        if (rewritten === undefined) {
          skipped.push(op.opId)
          break
        }
        // ① 前置 canonical schema：畸形定义在这里变成一条可读的 op 级 error，
        //    而不是让 validator 在 `edge.target.nodeId` 上抛。
        const parsed = WorkflowDefinitionSchema.safeParse(rewritten)
        if (!parsed.success) {
          errors.push(
            `${op.opId}: workflow definition is malformed — ${parsed.error.issues
              .slice(0, 4)
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')}`,
          )
          break
        }
        const definition = migrateWorkflowDefinitionToLatest(parsed.data)
        candidates.push({
          opId: op.opId,
          definition,
          currentWorkflow: { id, name: op.payload.name },
        })
        callWorkflows.push({ id, name: op.payload.name, definition })
        break
      }
      default:
        break
    }
  }

  return {
    candidates,
    overlays: {
      ...(agents.length === 0 ? {} : { agents }),
      ...(skills.length === 0 ? {} : { skills }),
      ...(mcps.length === 0 ? {} : { mcps }),
      ...(plugins.length === 0 ? {} : { plugins }),
      ...(callWorkflows.length === 0 ? {} : { callWorkflows }),
    },
    errors,
    skipped,
  }
}
