// RFC-271 决策 29（T6d）—— `RuntimeRef` 域的 resolver。
//
// 把 scheduler 里三处各写各的 `agentId` 裸读收成一处。它们此前是：
//   · 主派发 `:5187`        pickString(node,'agentId') → null 则节点失败
//   · fanoutInnerAgentKey   纯 helper，返回 string | null
//   · hydration `:6997`     内联重算一遍同样的判据（与上一行的 helper 调用重复），
//                           然后 getAgentById，null 就 `continue` 静默跳过
//
// ⚠️ **三处的失败归属实测不同，合并后必须逐条不变**（R7-P1-5）：
//
//   位点            缺 agentId              查不到 agent
//   主派发          节点失败                节点失败
//                   agent-identity-missing   agent-not-found
//   hydration       静默跳过                静默跳过
//
// 所以 resolver **返回 typed Result、绝不 throw**：直接 throw 会被 `runScope`
// 冒泡成任务级 "scheduler error"，把 node/wrapper 级归属整个丢掉。各调用点自己
// 把 Result 映射成它原有的错误码。

import type { Agent } from '@agent-workflow/shared'
import {
  decodeRuntimeIdRef,
  type RefCallPolicy,
  type RefResult,
  type ResourceRefAst,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { getAgentById } from '@/services/agent'

/** 从节点上读出 agent 引用。**这是唯一的读取点**——新增 NodeKind 不要再抄一份。 */
export function agentRefOfNode(node: { agentId?: unknown }): ResourceRefAst | null {
  const raw = node.agentId
  if (typeof raw !== 'string' || raw.length === 0) return null
  return decodeRuntimeIdRef('agent', raw)
}

/**
 * 解析一个节点的 agent。不 throw；调用方按自己的归属映射 Result。
 *
 * `call.onMissing` 只影响**语义标注**，不影响本函数的返回值形状——真正的分支在
 * 调用点。把它收进签名是为了让「这个调用点用的是哪种归属」在代码里可读、可测。
 */
export async function resolveNodeAgentRef(
  db: DbClient,
  node: { agentId?: unknown },
  call: RefCallPolicy,
): Promise<RefResult<Agent>> {
  const ref = agentRefOfNode(node)
  if (ref === null) {
    // 「节点上压根没有 agentId」——与「有 id 但查不到行」是两件事，调用点要分开映射。
    return {
      ok: false,
      reason: 'missing',
      ref: decodeRuntimeIdRef('agent', '<unstamped>'),
    }
  }
  const agent = await getAgentById(db, ref.k === 'id' ? ref.id : '')
  if (agent === null) return { ok: false, reason: 'unreadable', ref }
  void call
  return { ok: true, value: agent }
}

/**
 * wrapper-fanout 的 dedup / lookup key —— 就是节点的 canonical `agentId`。
 * name-only 节点返回 null 并 fail closed（RFC-223 PR-3a impl-gate H2）。
 */
export function fanoutInnerAgentRefKey(node: { agentId?: unknown }): string | null {
  const ref = agentRefOfNode(node)
  return ref === null ? null : ref.k === 'id' ? ref.id : null
}
