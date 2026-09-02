// RFC-352（RFC-294 W4-E2）—— memory 对外提供的**注入渲染**合同。
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

export {
  DEFAULT_INJECTION_BUDGET,
  clipByBudget,
  estimateTokens,
  formatMemoryBlock,
  formatMemoryBlockFromSnapshot,
  formatMemoryBlockWithSnapshot,
  memoryFencingForNonce,
  parseInjectedSnapshotJson,
  type InjectableMemoryRow,
  type InjectableMemorySet,
  type MemoryEnvelopeFencing,
  type ScopeBudget,
} from '../domain/injectionRendering'
