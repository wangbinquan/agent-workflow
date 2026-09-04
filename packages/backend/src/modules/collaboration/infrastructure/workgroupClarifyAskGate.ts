// RFC-359 W1-T7e —— 「这个工作组 asker 此刻能否向人反问」的**一份**判定，两个引擎共用。
//
// RFC-207 §1.3 / §3.7.2：唯一的判定点——派发侧把它同时喂给协议块（是否邀请反问）与
// `clarifyEnabled`（是否接受反问），信封侧取反；判两次就会出现「提示邀请了一个 runner 随后
// 拒绝的问题」，白白烧掉协议重试预算。此前该判定只有 SQLite 的 legacy 实现
// （`resource-catalog/infrastructure/legacy/workgroup/lifecycle.ts#resolveWgClarifyAllowed`），
// PostgreSQL 走的中立回合驱动把它简化成「有人类成员且预算 > 0」（不查已问次数、不查 stop）。
// 反问轮与节点 directive 都归 collaboration 所有，判定也落在这里。

import {
  resolveClarifyBudget,
  wgClarifyAskerKey,
  workgroupHasHumanMember,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { clarifyRounds } from '@/db/schema'
import { WORKGROUP_TURN_LEADER_NODE_ID } from '@/modules/task-execution/public/commands'
import { getNodeClarifyDirective } from './legacySqliteTaskClarifyDirective'

export interface WorkgroupClarifyAskInput {
  readonly taskId: string
  readonly nodeId: string
  readonly shardKey: string | null
  readonly members: ReadonlyArray<{ readonly memberType: 'agent' | 'human' }>
  readonly clarifyBudget: number | undefined
}

export interface WorkgroupClarifyAskGate {
  allowed(input: WorkgroupClarifyAskInput): Promise<boolean>
}

/** 该 asker（节点 + 分片）已经发起过的自澄清轮数。 */
export async function countWorkgroupClarifyAsks(
  db: ProviderNeutralDatabase,
  taskId: string,
  askerKey: string,
): Promise<number> {
  const rows = await db
    .select({ nodeId: clarifyRounds.askingNodeId, shard: clarifyRounds.askingShardKey })
    .from(clarifyRounds)
    .where(and(eq(clarifyRounds.kind, 'self'), eq(clarifyRounds.taskId, taskId)))
  return rows.filter(
    (row) => wgClarifyAskerKey(row.nodeId, row.shard, WORKGROUP_TURN_LEADER_NODE_ID) === askerKey,
  ).length
}

export async function resolveWorkgroupClarifyAllowed(
  db: ProviderNeutralDatabase,
  input: WorkgroupClarifyAskInput,
): Promise<boolean> {
  if (!workgroupHasHumanMember(input.members)) return false
  const budget = resolveClarifyBudget({ clarifyBudget: input.clarifyBudget })
  if (budget <= 0) return false
  const askerKey = wgClarifyAskerKey(input.nodeId, input.shardKey, WORKGROUP_TURN_LEADER_NODE_ID)
  // 人类明确让这个 asker 停下——优先于任何剩余预算。
  if ((await getNodeClarifyDirective(db, input.taskId, input.nodeId, askerKey)) === 'stop') {
    return false
  }
  return (await countWorkgroupClarifyAsks(db, input.taskId, askerKey)) < budget
}

export function createWorkgroupClarifyAskGate(
  db: ProviderNeutralDatabase,
): WorkgroupClarifyAskGate {
  return Object.freeze({
    allowed: (input: WorkgroupClarifyAskInput) => resolveWorkgroupClarifyAllowed(db, input),
  })
}
