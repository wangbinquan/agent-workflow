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

import type {
  MemoryMembershipParticipantInTx,
  MemoryMembershipUnfuseSelector,
} from '../../memory/public/participants'
import { memoriesToUnfuseOnRestore } from '../domain/skillRestore'

/** 回滚请求：调用方只说「哪个技能回到第几版」。 */
export interface SkillRestoreMembershipRequest {
  readonly skillId: string
  readonly targetVersion: number
}

/** memory 的同步写入面（SQLite：`apply` / `commitSkillVersion` 跑在同步事务回调里）。 */
export interface SyncMemoryMembershipUnfuse<TTx> {
  (tx: TTx, selector: MemoryMembershipUnfuseSelector): string[]
}

/**
 * SQLite 侧的协调器：拿到已开好的同步事务，按 KE 的判据退回记忆，返回被退回的 id。
 * 顺序由 memory domain 单一裁定（字典序），这里不再排一次。
 */
export function createSyncSkillRestoreMembership<TTx>(unfuse: SyncMemoryMembershipUnfuse<TTx>): {
  unfuseForRestore(tx: TTx, request: SkillRestoreMembershipRequest): string[]
} {
  return Object.freeze({
    unfuseForRestore(tx: TTx, request: SkillRestoreMembershipRequest): string[] {
      return unfuse(tx, memoriesToUnfuseOnRestore(request))
    },
  })
}

/** PostgreSQL 侧的协调器：`prepareRestore` 本来就是 async，直接吃 memory 的 tx-bound participant。 */
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
