// RFC-353 T2（RFC-294 W4-E3）—— memory 提供给 knowledge-evolution 的成员关系 participant（SQLite 侧）。
//
// design §638 把 `MemoryMembershipParticipantInTx` 列为 memory offered、**KE-only** 的面：
// 融合把记忆标记为 fused、技能回滚把它们退回 approved，这两件事都必须与技能版本写入**同一事务**
// ——不变式是「fused ⟺ 该知识在技能的当前版本里」，中间态被别人读到就会出现
// 「状态说已融合、技能里却没有这段知识」的幽灵行。
//
// 为什么本刀要新建它：这半边今天 PostgreSQL 有（`postgresqlSkillMemoryFusionParticipant.ts`，
// 注释自称 "Memory-owned half of Skill restore"），SQLite 没有——SQLite 侧是 resource-catalog 的
// `legacy/skillVersion.ts` 直接 `import { unfuseMemoriesTx } from '@/services/memory'`。
// 同一判据两个来源，实测已经漂了：两边选中的集合一样，**返回顺序不一样**
// （SQLite 按插入顺序、PostgreSQL 排过序），而这个数组经
// `skill-catalog.restore-skill-version.v1` 的 `unfusedMemoryIds` 直接上 wire。

import { and, eq, gt, inArray } from 'drizzle-orm'

import { memories } from '@/db/schema'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'

import type { MemoryMembershipWrites } from '../application/memoryMembership'
import type { MemoryMembershipFuseCommand } from '../public/participants'
import {
  fusedProvenanceStamp,
  memoriesToMarkFused,
  memoriesToUnfuseAbove,
} from '../domain/fusionMembership'

/**
 * SQL 里保留 WHERE 是有意的——那是索引用得上的形状。
 * 但**选中结果与顺序的裁定权归 domain 的纯函数**：SQL 取候选，纯函数定集合与顺序，
 * 两者的等价性由 `rfc353-memory-membership-participant.test.ts` 的真库全矩阵锁死。
 */
/**
 * SQLite 侧的成员关系写入面。
 *
 * 这里**故意不返回 T7 才落的 branded participant**：capability 类型只能有唯一 owner 工厂
 * （RFC-294 capability-forge 守卫），provider 文件再造一个就成了第二个工厂。
 * 与 RFC-352 给 source-control 落 `RepositoryScopeExistenceReads` 是同一形状——
 * provider 只出「怎么读怎么写」，capability 由 application 的唯一工厂铸。
 */
export function sqliteMemoryMembershipWrites(tx: DbTxSync): MemoryMembershipWrites {
  return Object.freeze({
    async unfuseAboveVersion(input: {
      readonly skillId: string
      readonly aboveVersion: number
    }): Promise<readonly string[]> {
      return unfuseAboveVersionSync(tx, input)
    },
    async markFused(command: MemoryMembershipFuseCommand): Promise<readonly string[]> {
      return markFusedSync(tx, command)
    },
  })
}

/** 同步核心，理由同 `unfuseAboveVersionSync`：SQLite 侧的调用方跑在 `dbTxSync` 的同步回调里。 */
export function markFusedSync(tx: DbTxSync, command: MemoryMembershipFuseCommand): string[] {
  const candidates = tx
    .select({
      id: memories.id,
      status: memories.status,
      fusedIntoSkillId: memories.fusedIntoSkillId,
      fusedIntoSkillVersion: memories.fusedIntoSkillVersion,
    })
    .from(memories)
    .where(inArray(memories.id, [...command.memoryIds]))
    .all()
  const ids = memoriesToMarkFused(candidates, command.memoryIds)
  const stamp = fusedProvenanceStamp({
    skillId: command.skillId,
    skillName: command.skillName,
    skillVersion: command.skillVersion,
    fusionId: command.fusionId,
    actorUserId: command.actorUserId,
    now: command.now,
  })
  for (const id of ids) {
    tx.update(memories).set(stamp).where(eq(memories.id, id)).run()
  }
  return ids
}

/**
 * 同步核心。participant 的合同是 Promise（provider 中性），但 bun:sqlite 本身是同步的，
 * 而 resource-catalog 的 legacy restore 路径跑在 `dbTxSync` 的**同步**回调里——
 * 那里拿不到 await。所以真正的实现放这里，异步只是外面那层壳。
 * T7 把 skill-restore coordinator 迁进 knowledge-evolution 之后，这个导出随之消失。
 */
export function unfuseAboveVersionSync(
  tx: DbTxSync,
  input: { readonly skillId: string; readonly aboveVersion: number },
): string[] {
  const candidates = tx
    .select({
      id: memories.id,
      status: memories.status,
      fusedIntoSkillId: memories.fusedIntoSkillId,
      fusedIntoSkillVersion: memories.fusedIntoSkillVersion,
    })
    .from(memories)
    .where(
      and(
        eq(memories.status, 'fused'),
        eq(memories.fusedIntoSkillId, input.skillId),
        gt(memories.fusedIntoSkillVersion, input.aboveVersion),
      ),
    )
    .all()
  const ids = memoriesToUnfuseAbove(candidates, input)
  const stamp = fusedProvenanceStamp(null)
  for (const id of ids) {
    tx.update(memories).set(stamp).where(eq(memories.id, id)).run()
  }
  return ids
}

/**
 * RFC-353 T6 —— RFC-223 provenance 修复用的**非事务**写入面。
 *
 * 与上面两个不同：`repairProvenance` 是 daemon 启动期逐条修复，没有外层事务
 * （每条独立、可中断、下次启动继续），所以这里收 `DbClient` 而不是 `DbTxSync`。
 * 收进 memory 的理由不变——`memories.fused_into_skill_id` 是 memory 的列，
 * 只是「谁能写」这件事，不该由 knowledge-evolution 自己伸手。
 */
export function reassignFusedSkillSync(
  db: DbClient,
  input: { readonly memoryId: string; readonly skillId: string },
): void {
  db.update(memories)
    .set({ fusedIntoSkillId: input.skillId })
    .where(eq(memories.id, input.memoryId))
    .run()
}
