// RFC-472 —— 意图侧启动恢复的属主重新准入端口。
//
// 准入的 owner 是 identity-access（它铸登记过的直接权威；目标 DAG 上 intent 对它只有类型依赖）。
// intent 只声明自己要什么：「这个会话的属主 → 它的 Actor，或 null」；identity-access 的
// `composeDurableWorkOwnerAdmission` 按结构满足，由 bootstrap 装配。本模块不认识凭据与权威登记表。

import type { Actor } from '@/auth/actor'

export interface IntentOwnerAdmissionPort {
  /**
   * Re-admit a queued session's owner so boot recovery runs **as that owner**. The actor is a registered
   * direct authority's projection — `resourceCatalogFor` resolves it back to its authority, which a
   * hand-built actor would fail (`foreign-legacy-actor-projection`). Null means the account is disabled
   * or deleted: the caller skips that session and never falls back to another identity.
   */
  admitOwner(ownerUserId: string): Promise<Actor | null>
}
