// RFC-358 §4/§7 —— 「一个变更集 → 图校验结论」。**draft 期与 apply 期共用这一份**。
//
// 两个调用点的差别只有两处，都以参数表达：解析表（draft 用占位 id、apply 用最终 id）与
// `mode`（解析不出时跳过 / 抛）。判据本身一份——applyCommitPlan.ts 的文件头记着 RFC-355
// 的教训：同一判据抄两份，差别只在哪一条先漂。

import type { IntentChangeset, WorkflowValidationIssue } from '@agent-workflow/shared'
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
