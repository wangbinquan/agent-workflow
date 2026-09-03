// RFC-352（RFC-294 W4-E2）—— memory 对外提供的**注入渲染 / 快照编解码**合同。
//
// 落在 `public/types.ts` 而不是自起一个 `public/injection.ts`：RFC-317 T24 规定 public/ 下
// 只允许 commands / queries / participants / events / operations / types 这几个 exact 入口，
// 别的文件名等于给消费者开一个不受合同约束的入口。这里导出的正是
// `node_runs.injected_memories_json` 那一列的**类型契约**（编解码器 + 渲染器），归 types 面。
//
// 为什么需要它：task-execution 侧有两个真实消费者不走「查记忆」这条路，而是要按
// 已经持久化在 `node_runs.injected_memories_json` 里的快照**重建当年的注入片段**：
//
//   - `services/runner.ts`：RFC-042 同会话追问要逐字复刻首轮的 persona 片段；
//   - `modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts`：
//     REST 投影要把那一列解码成 DTO。
//
// 它们要的是**纯函数**，不是查询：不碰 DB、不碰端口、不看 ACL。所以这里只把 domain 的
// 渲染/解码面原样 re-export，正文查询仍然只经 `TaskMemoryInjectionPort`（见
// `public/queries.ts` 的 `MemoryInjectionQueries`），不从 public 暴露。
//
// 不要往这里加任何取数函数——加了就等于给 memory 开了第二条绕过授权的读路径。

// 只导出**真的有生产 consumer** 的那几个（RFC-294 design §3.3「无 consumer 不公开」，
// `rfc294-review-public-consumer-ledger` 逐条钉死）。预算常量、逐档裁剪、token 估算与另外
// 两个 format 变体都只在 memory 自己内部用，留在 domain 里。
export {
  formatMemoryBlockFromSnapshot,
  memoryFencingForNonce,
  parseInjectedSnapshotJson,
  type MemoryEnvelopeFencing,
  type ScopeBudget,
} from '../domain/injectionRendering'
