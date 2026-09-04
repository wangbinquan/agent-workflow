// RFC-358 §4/§7 —— 「一个变更集 → 图校验结论」。**draft 期与 apply 期共用这一份**。
//
// 两个调用点的差别只有两处，都以参数表达：解析表（draft 用占位 id、apply 用最终 id）与
// `mode`（解析不出时跳过 / 抛）。判据本身一份——applyCommitPlan.ts 的文件头记着 RFC-355
// 的教训：同一判据抄两份，差别只在哪一条先漂。

import {
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  type Agent,
  type IntentChangeset,
  type WorkflowDefinition,
  type WorkflowValidationIssue,
} from '@agent-workflow/shared'
import type {
  WorkflowValidationAgentOverlay,
  WorkflowValidationCandidateOverlays,
  WorkflowValidationWorkflowOverlay,
} from '@/modules/resource-catalog/public/types'
import type { ResolvedIntentOp } from './resolveChangeset'
import type { Actor } from '@/auth/actor'
import { createLogger } from '@/util/log'
import {
  buildIntentGraphCandidates,
  type IntentGraphRefMode,
  type IntentGraphRefResolution,
} from '@/modules/intent/domain/workflowGraphCandidate'
import type { IntentWorkflowGraphValidationPort } from './ports/intentWorkflowGraphValidation'

const log = createLogger('intentGraphValidation')

/** 每个 op 与整体的 issue 上限。
 *
 *  校验器有 108 个错误码，多条规则**逐边 / 逐节点**产出，而意图 schema 允许 1024 条边、
 *  256 节点、64 个 op。不设上限，blocking 段会被一个坏 op 撑爆并淹没第一层的错误。
 *  截断一律显式标注——`intentDoc.ts` 文件头写死的约定：
 *  "Any truncation is explicitly labeled — silence never means completeness"。 */
export const INTENT_GRAPH_ISSUE_CAPS = { perOp: 20, total: 64 } as const

export interface IntentGraphWarning {
  readonly opId: string
  readonly code: string
  readonly where?: string
  readonly message: string
}

export interface IntentGraphValidationOutcome {
  /** 校验没能跑起来（查库失败等）。此时 errors/warnings 均为空，**不得当成绿**。 */
  readonly unavailable: boolean
  /** 已带 `<opId>:` 前缀、已截断的 blocking 文案。 */
  readonly errors: readonly string[]
  readonly warnings: readonly IntentGraphWarning[]
}

/** issue 的位置：优先 target 里的 nodeId（`WorkflowValidationIssue` 没有 nodeId 字段），
 *  否则回落 pointer。 */
function whereOf(issue: WorkflowValidationIssue): string | undefined {
  const target = issue.target
  if (target !== undefined) {
    if (target.kind === 'node' || target.kind === 'node-field' || target.kind === 'node-port') {
      return target.nodeId
    }
    if (target.kind === 'edge') return target.edgeId
  }
  return issue.pointer
}

function formatError(opId: string, issue: WorkflowValidationIssue): string {
  const where = whereOf(issue)
  // 前缀逐字是前端按 op 卡片分组的既有约定：`error.startsWith(`${op.opId}:`)`，
  // 冒号后**没有空格**。code 前置是为了让模型在 INTENT.md 里看到稳定的机器可读串。
  return `${opId}: ${issue.code}${where === undefined ? '' : ` @${where}`} — ${issue.message}`
}

export async function validateChangesetWorkflowGraphs(
  deps: { readonly graphValidation: IntentWorkflowGraphValidationPort },
  input: {
    readonly actor: Actor
    readonly changeset: IntentChangeset
    readonly resolution: IntentGraphRefResolution
    readonly mode: IntentGraphRefMode
  },
): Promise<IntentGraphValidationOutcome> {
  const built = buildIntentGraphCandidates({
    changeset: input.changeset,
    resolution: input.resolution,
    mode: input.mode,
  })
  if (built.candidates.length === 0) {
    return { unavailable: false, errors: [...built.errors], warnings: [] }
  }

  const errors: string[] = [...built.errors]
  const warnings: IntentGraphWarning[] = []
  let truncated = 0
  for (const candidate of built.candidates) {
    let result: Readonly<{ ok: boolean; issues: readonly WorkflowValidationIssue[] }>
    try {
      result = await deps.graphValidation.validate({
        actor: input.actor,
        definition: candidate.definition,
        currentWorkflow: candidate.currentWorkflow,
        ...(built.overlays === undefined ? {} : { overlays: built.overlays }),
      })
    } catch (err) {
      // 绿是一个有后果的判断——拿不到判据就不能给。但也不丢模型的产出：
      // 调用方据此标记「校验不可用」并照常落 draft（RFC-358 决策 D7）。
      log.warn('intent-graph-validation-unavailable', {
        opId: candidate.opId,
        err: err instanceof Error ? err.message : String(err),
      })
      return { unavailable: true, errors: [], warnings: [] }
    }
    let perOp = 0
    for (const issue of result.issues) {
      if ((issue.severity ?? 'error') === 'warning') {
        warnings.push({
          opId: candidate.opId,
          code: issue.code,
          message: issue.message,
          ...(whereOf(issue) === undefined ? {} : { where: whereOf(issue) as string }),
        })
        continue
      }
      if (
        perOp >= INTENT_GRAPH_ISSUE_CAPS.perOp ||
        errors.length >= INTENT_GRAPH_ISSUE_CAPS.total
      ) {
        truncated += 1
        continue
      }
      perOp += 1
      errors.push(formatError(candidate.opId, issue))
    }
  }
  if (truncated > 0) {
    errors.push(`… and ${truncated} more graph validation error(s) not listed`)
  }
  return { unavailable: false, errors, warnings }
}

/**
 * RFC-358 §7（决策 D3）—— apply preflight 的二次硬拦。
 *
 * 与 draft 期是同一套判据、同一个端口，差别只在输入：这里的 op 已经解析完毕，
 * `definition` 里是**最终 canonical id**、payload 是 canonical 形状。所以不再走
 * 「假想解析」，直接从 resolved op 派生覆盖层。
 *
 * 为什么 draft 绿了还要再拦一次：draft 与 apply 之间 live 库可能变（别人改了被引用
 * agent 的输出端口）、草稿可能产生于本功能上线之前、`finalName` 槽可能改名从而断掉
 * 按名字建立的 call 边。这三类都不是「用户此刻做错了什么」，所以文案要分类。
 */
export async function validateResolvedBundleWorkflowGraphs(
  deps: { readonly graphValidation: IntentWorkflowGraphValidationPort },
  input: {
    readonly actor: Actor
    readonly ops: readonly ResolvedIntentOp[]
  },
): Promise<IntentGraphValidationOutcome> {
  const workflowOps = input.ops.filter((op) => op.resourceType === 'workflow')
  if (workflowOps.length === 0) return { unavailable: false, errors: [], warnings: [] }

  const agents: WorkflowValidationAgentOverlay[] = []
  const skills: { id: string; name: string }[] = []
  const mcps: { id: string; name: string; enabled: boolean }[] = []
  const plugins: { id: string; name: string; enabled: boolean }[] = []
  const callWorkflows: WorkflowValidationWorkflowOverlay[] = []
  for (const op of input.ops) {
    const payload = op.payload as Record<string, unknown>
    const name = String(payload.name ?? op.resourceId)
    switch (op.resourceType) {
      case 'agent':
        agents.push({
          agentId: op.resourceId,
          isNew: op.action === 'create',
          fields: {
            name,
            outputs: (payload.outputs ?? []) as readonly string[],
            skills: (payload.skills ?? []) as Agent['skills'],
            dependsOn: (payload.dependsOn ?? []) as readonly string[],
            mcp: (payload.mcp ?? []) as readonly string[],
            plugins: (payload.plugins ?? []) as readonly string[],
            ...(payload.outputKinds === undefined
              ? {}
              : { outputKinds: payload.outputKinds as Readonly<Record<string, string>> }),
            ...(payload.branchPorts === undefined
              ? {}
              : { branchPorts: payload.branchPorts as readonly string[] }),
            ...(payload.outputWrapperPortNames === undefined
              ? {}
              : {
                  outputWrapperPortNames: payload.outputWrapperPortNames as Readonly<
                    Record<string, string>
                  >,
                }),
            ...(payload.role === undefined ? {} : { role: payload.role as Agent['role'] }),
          },
        })
        break
      case 'skill':
        skills.push({ id: op.resourceId, name })
        break
      case 'mcp':
        mcps.push({ id: op.resourceId, name, enabled: payload.enabled !== false })
        break
      case 'plugin':
        plugins.push({ id: op.resourceId, name, enabled: payload.enabled !== false })
        break
      default:
        break
    }
  }

  const candidates: { opId: string; definition: WorkflowDefinition; name: string }[] = []
  for (const op of workflowOps) {
    const payload = op.payload as { name?: unknown; definition?: unknown }
    const parsed = WorkflowDefinitionSchema.safeParse(payload.definition)
    if (!parsed.success) {
      // canonical schema 在 `prepare` 里会给出 `intent-op-canonical-invalid`，
      // 这里不抢它的判据，只是不把畸形定义送进校验器。
      continue
    }
    const definition = migrateWorkflowDefinitionToLatest(parsed.data)
    const name = String(payload.name ?? op.resourceId)
    candidates.push({ opId: op.opId, definition, name })
    callWorkflows.push({ id: op.resourceId, name, definition })
  }

  const overlays: WorkflowValidationCandidateOverlays = {
    ...(agents.length === 0 ? {} : { agents }),
    ...(skills.length === 0 ? {} : { skills }),
    ...(mcps.length === 0 ? {} : { mcps }),
    ...(plugins.length === 0 ? {} : { plugins }),
    ...(callWorkflows.length === 0 ? {} : { callWorkflows }),
  }

  const errors: string[] = []
  const warnings: IntentGraphWarning[] = []
  for (const candidate of candidates) {
    const op = workflowOps.find((each) => each.opId === candidate.opId)
    const result = await deps.graphValidation.validate({
      actor: input.actor,
      definition: candidate.definition,
      currentWorkflow: { id: op?.resourceId ?? candidate.opId, name: candidate.name },
      overlays,
    })
    let perOp = 0
    for (const issue of result.issues) {
      if ((issue.severity ?? 'error') === 'warning') {
        warnings.push({ opId: candidate.opId, code: issue.code, message: issue.message })
        continue
      }
      if (perOp >= INTENT_GRAPH_ISSUE_CAPS.perOp || errors.length >= INTENT_GRAPH_ISSUE_CAPS.total)
        continue
      perOp += 1
      errors.push(formatError(candidate.opId, issue))
    }
  }
  return { unavailable: false, errors, warnings }
}

/**
 * RFC-358 B-2 —— 提交被图校验拦下时的文案。
 *
 * 一律说「引用的资源发生了变化」会把用户引到错误方向：这道门的触发面不止 live 库漂移，
 * 还包括本功能上线前产生的存量草稿、以及 `finalName` 改名断掉按名字建立的 call 边。
 * 所以文案讲清楚「这份草稿现在过不了工作流校验」并给出可执行的下一步。
 */
export function intentWorkflowInvalidMessage(errors: readonly string[]): string {
  const head = errors.slice(0, 3).join('; ')
  const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : ''
  return (
    `this draft no longer passes workflow validation: ${head}${more}. ` +
    'The referenced resources may have changed since the draft was generated, ' +
    'or the draft predates workflow graph validation — regenerate a turn and review the fixes.'
  )
}
