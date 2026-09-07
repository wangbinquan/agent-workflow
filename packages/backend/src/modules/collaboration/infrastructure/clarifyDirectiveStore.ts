// RFC-359 W7 —— RFC-122 澄清指令覆盖的持久化：**一份实现，两个 provider 共用**。
//
// 合一前这里是一对适配器：`sqliteClarifyDirectiveStore.ts`（34 行，纯转发）与
// `postgresqlClarifyDirectiveStore.ts`（86 行，把同一段逻辑逐行内联抄了一遍）。七条判据
// （shardKey 回退 / 缺行返回 / listNodeDirectives 只取节点级 / upsert 三列复合键 /
// RFC-207 节点级 continue 级联删除 / `now` 缺省 / 事务包裹）当时确实一致，但**抄写就是漂移的
// 前提**——同一对里已经有一处真实分叉：PG 那份直接调 `db.transaction`，不走
// `databaseSessionFor`，于是它**不可重入**：在外层显式事务里调用 `set` 会另开一条连接、
// 独立提交，外层回滚也带不走它（2026-09-06 双引擎实测：SQLite 回滚后 0 行、PG 回滚后 1 行）。
//
// 正典是 `taskClarifyDirective.ts`——它早已是中立实现（`ProviderNeutralDatabase`
// 上的 drizzle query builder + `databaseSessionFor(db).transaction`），还额外导出
// `setNodeClarifyDirectiveTx`（RFC-341 的澄清决定 seal 拿它当事务参与者）与
// `isAskingNodeInSnapshot`。本工厂只是把那三个中立函数适配到 `ClarifyDirectiveStore` 端口
// 的形状上，装配点因此对两个引擎是同一个工厂。
// RFC-359 W12：正典文件及其消费路径已统一使用中立名称。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { ClarifyDirectiveStore } from '../application/ports/clarifyDirectiveStore'
import {
  getNodeClarifyDirectiveRow,
  listNodeClarifyDirectives,
  setNodeClarifyDirective,
} from './taskClarifyDirective'

export function createClarifyDirectiveStore(db: ProviderNeutralDatabase): ClarifyDirectiveStore {
  const store: ClarifyDirectiveStore = {
    async get(input) {
      return (
        (await getNodeClarifyDirectiveRow(db, input.taskId, input.nodeId, input.shardKey)) ?? null
      )
    },
    async listNodeDirectives(taskId) {
      return Object.entries(await listNodeClarifyDirectives(db, taskId)).map(
        ([nodeId, directive]) => ({ nodeId, directive }),
      )
    },
    async set(input) {
      await setNodeClarifyDirective(
        db,
        input.taskId,
        input.nodeId,
        input.directive,
        input.setBy,
        input.shardKey,
        input.now,
      )
    },
  }
  return Object.freeze(store)
}
