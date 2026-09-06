// RFC-353 T7（RFC-294 W4-E3）—— 技能回滚的**成员关系协调**，由 knowledge-evolution 拥有。
//
// resource-catalog 负责「铸一个内容等于 v{target} 的新版本」，memory 负责「退回这批记忆」，
// 而「回滚时该退回哪些、必须与版本推进同事务」这条规则属于知识演化。此前它没有归属：
// SQLite 侧由 `resource-catalog/infrastructure/sqliteSkillRepository.ts` 直接
// `import { unfuseAboveVersionSync } from '@/modules/memory/infrastructure/...'`
// （跨 context **内部** import，RFC-317 R2 明令禁止），PostgreSQL 侧由 RC 的 composition
// 直接注入 memory 的 participant 工厂——两条路径各自把同一句 `aboveVersion` 写了一遍。
//
// 现在两侧都收到 KE 铸的协调器：RC 只认识一个「给我事务、还我一组 id」的窄端口，
// 既不认识 memory，也不必知道 aboveVersion 是怎么算出来的。

import type { MemoryMembershipParticipantInTx } from '../../memory/public/participants'
import { memoriesToUnfuseOnRestore } from '../domain/skillRestore'

/** 回滚请求：调用方只说「哪个技能回到第几版」。 */
export interface SkillRestoreMembershipRequest {
  readonly skillId: string
  readonly targetVersion: number
}

// RFC-359 W4-D23b：legacy 的同步回滚路径已改吃中立事务，`SyncMemoryMembershipUnfuse` 与
// `createSyncSkillRestoreMembership` 随之退役——三个 bootstrap 接的都是下面这一个异步协调器。

export function createAsyncSkillRestoreMembership<TTx>(memory: {
  inTransaction(transaction: TTx): MemoryMembershipParticipantInTx
}): {
  unfuseForRestore(tx: TTx, request: SkillRestoreMembershipRequest): Promise<readonly string[]>
} {
  return Object.freeze({
    async unfuseForRestore(
      tx: TTx,
      request: SkillRestoreMembershipRequest,
    ): Promise<readonly string[]> {
      return await memory.inTransaction(tx).unfuseAboveVersion(memoriesToUnfuseOnRestore(request))
    },
  })
}
