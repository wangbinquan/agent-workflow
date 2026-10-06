# RFC-371 空覆盖工作区读取修复

本补充落实已批准的完整统计性能要求。原 AW 100,000 任务 / 10,000,000 用量的 self-total 场景四小时未完成，原失败保留。`completeCoverageWorkspace.root` 对没有覆盖区间的每个请求反复读取原 TEMP 根关系；请求独有的 tree 会使缺失查询随完整人口增长。CS 已在 `52c8eb74fd8354f15c9f1254106cb38d08b0949d` 修正同一路径，AW 采用相同的原 EOF 判据，不改算法、人口或原验收预算。

只修改 run-observability infrastructure 的原覆盖工作区，并在原 `rfc371-complete-workspace.test.ts` 增加功能回归。原 namespace 的第一条 roots 点查保留；同时用原 `rows.page(rootSpace, null, 1)` 获取完整空关系 EOF。只有 `items.length === 0 && nextCursor === null` 才能复用关系为空的结论。非空关系继续按原键读取，不能因为某个键缺失就推断整个关系为空。

空点查以 `{tree, id: null}` 进入现有 4096 项缓存；淘汰仅导致重新查询原关系，不限制统计身份。任何 `setRoot` 都在写入前立即使空关系证明失效，并推进该 workspace 的 BigInt 写入修订；它仅标识异步原点查是否跨过写入，不记录任何统计值。原 page 正在等待时若发生写入，不得覆盖已失效的证明；等待结束后重新读取 dirty/cache，再决定是否点查。原 get 正在等待时也必须重新读取 dirty/cache；若期间修订改变且缓存没有当前键，重新执行原点查，不能将可能过期的缺失覆盖新根，即使新根已被 flush 和缓存淘汰。flush、原全部覆盖区间与祖先冲突判据保持。证明只属于同一个独占原 snapshot/TEMP namespace 和该 workspace 实例，不跨报告、快照、重启或 namespace 复用。

保留原三项回归全部断言与 30 秒预算；增加空关系 10,001 个原 tree、非空原关系、等待 EOF 时写入、等待点查时写入（包括其 flush/缓存淘汰后重查）、超过缓存容量后仍读取原实际根的回归。通过真实原 `CompleteWorkingRows` 接口记录 page/point 次数，不把内部 mock 时间当作规模通过。原 hosted 100K/10M、全部 identity/bitmap/EOF、四桶 Token/CNY 与 500 ms 读取目标继续单独验收；该修复不预先宣称全规模或启动修复完成。

先进行独立有限功能设计检视，随后实现、独立有限功能检视及 exact-SHA hosted CI。只审本补充功能，不增加其他检视范围。
