// RFC-300 — admission policy for immediate cleanup of direct Webhook task
// workspaces. This module deliberately owns only the integration attribution
// rule. Lifecycle owns the atomic status+claim write and GC/source-control owns
// physical deletion.

import { eq } from 'drizzle-orm'

import type { SpaceKind, TaskStatus } from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import type { TerminalWorkspacePrunePolicy } from '@/services/lifecycle'

export interface WebhookTerminalWorkspacePolicyInput {
  to: TaskStatus
  webhookTriggerId: string | null
  /** RFC-310 generic Event Center attribution; absent on pre-migration callers. */
  eventSubscriptionId?: string | null
  spaceKind: SpaceKind
  workspacePruningAt: number | null
  workspacePruneCause: 'webhook-terminal' | null
  workspacePrunedAt: number | null
}

/**
 * Exact RFC-300 candidate predicate. `triggerContextJson` is intentionally not
 * accepted: child call tasks inherit that context but do not own their parent
 * call-node workspace. Direct legacy Webhook or generic Event subscription
 * attribution plus an owning space kind are required.
 */
export function shouldRequestWebhookWorkspacePrune(
  enabled: boolean,
  input: WebhookTerminalWorkspacePolicyInput,
): boolean {
  return (
    enabled &&
    (input.to === 'done' || input.to === 'canceled') &&
    (input.webhookTriggerId !== null || input.eventSubscriptionId != null) &&
    (input.spaceKind === 'remote' || input.spaceKind === 'scratch') &&
    input.workspacePruningAt === null &&
    input.workspacePruneCause === null &&
    input.workspacePrunedAt === null
  )
}

/**
 * RFC-317 LC-04 —— 把「谁该被回收」连同「这次回收叫什么名字」一起收进本模块。
 *
 * 归属列（`webhook_trigger_id` / `event_subscription_id`）由这里**自己读**，不再让
 * `services/lifecycle.ts` 那个通用写点替我们选列——那个写点是所有任务状态转移的公共
 * 内核，它一旦在类型签名里点名某个集成，就再也无法脱离该集成被抽取。
 *
 * 为什么另起一次查询而不是让 kernel 把整行转发过来：`tasks` 有 68 列、含最大 32 KiB
 * 的 `trigger_context_json`，宽行读会落在**每一次**状态写上；而本策略只在 done /
 * canceled 这两个终态被调用一次，多这一次按主键的窄查询代价可忽略。
 *
 * 归属列在任务创建后不再变动，所以它与 kernel 那次读之间的时间差不产生新的竞态；
 * 真正的并发防线仍是终态 CAS 里的三列墓碑条件（本策略同样要求它们为空）。
 */
export function createWebhookTerminalWorkspacePrunePolicy(deps: {
  readonly db: DbClient
  /** 每次转移都重读，配置保持热更新（沿用 RFC-300 既有语义）。 */
  readonly enabled: () => boolean
}): TerminalWorkspacePrunePolicy {
  return (row, to) => {
    const attribution = deps.db
      .select({
        webhookTriggerId: tasks.webhookTriggerId,
        eventSubscriptionId: tasks.eventSubscriptionId,
      })
      .from(tasks)
      .where(eq(tasks.id, row.taskId))
      .limit(1)
      .all()[0]
    if (attribution === undefined) return { prune: false }
    const prune = shouldRequestWebhookWorkspacePrune(deps.enabled(), {
      to,
      webhookTriggerId: attribution.webhookTriggerId,
      eventSubscriptionId: attribution.eventSubscriptionId,
      spaceKind: row.spaceKind,
      workspacePruningAt: row.workspacePruningAt,
      workspacePruneCause: row.workspacePruneCause,
      workspacePrunedAt: row.workspacePrunedAt,
    })
    return prune ? { prune: true, cause: 'webhook-terminal' } : { prune: false }
  }
}
