// Intent 对外的 exact 合同。
//
// RFC-355 T9（RFC-294 W4-E4a）：这里此前挂着 26 个符号，其中 24 个的「消费者」要么是本模块
// 自己的文件，要么只是**这张表上的另一个符号**（`IntentPersistence` 那一大族没有任何模块外
// 消费者，纯粹在互相引用）。RFC-294 design §3.3 的规矩是「无 consumer 不公开」——公开一个
// 没人从外面用的类型，等于把内部形状钉死成合同，本模块此后每次改端口都要先动 public。
//
// 现在只留真正跨出去的三件（按实际 import 点逐个核过）：
//
//   - `canAuditIntentSessions` —— `services/resourceAcl.ts` 再导出；
//   - `IntentApplyOperations` —— `server.ts` 装配时的形参类型；
//   - 它签名里出现的 `IntentApplyInput / IntentApplyDecision / IntentApplyReceipt`。
//
// 本模块自己的文件（application / inbound / composition）一律直接取
// `application/ports/*`——inbound 是自家的投递适配器，**不经自己的 public**（同 RFC-353 T12
// 给 knowledge-evolution 立下的口径）。

import type { Actor } from '@/auth/actor'

/** Intent owns its audit visibility policy; Resource Catalog has no role in it. */
export function canAuditIntentSessions(actor: Actor): boolean {
  return actor.permissions.has('intent:audit')
}

export type {
  IntentApplyInput,
  IntentApplyDecision,
  IntentApplyOperations,
  IntentApplyReceipt,
} from '../application/ports/intentApplyOperations'
