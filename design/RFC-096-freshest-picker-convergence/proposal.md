# RFC-096 — freshest-run picker 收敛：比较器下沉 + 共享挑行 + 四处病理修复

> 状态：Draft。来源：`design/scheduler-audit-2026-06-10.md` 改进路线 **WP-3**（对应既有队列
> 「review freshest-run 共享 pickFreshestUpstreamRun」；S-13 收尾 + 附录 C #2/#5/#7 核实）。
> 触发：2026-06-11 用户「继续」。落档前已做专项事实核查（全部 file:line 实证）。

## 背景

「哪行是最新/权威」的判定权威是 `isFresherNodeRun`（纯 ULID id 序），但它住在 scheduler.ts，
review.ts 反向 import 它构成模块环的一半；周边仍散落 4 个各自手写、**语义有病**的挑行点：

- **C#7 `triggerDesignerRerun`（crossClarify.ts:760-765，病理最重）**：`desc(startedAt)` 无任何
  谓词。三重病：① startedAt 可 NULL（triggerDesignerRerun / review-rerun 自己铸的行都不写
  startedAt），SQLite DESC 下 NULL 沉底——**最新铸的 pending rerun 行永远选不中**；② mark-running
  会重写 startedAt（runner.ts:664-669），旧 iteration 行被 resume 后跳到队首；③ 不滤
  status/parent/iteration，可选中 failed/canceled/子行。后果：rollback 目标错（把后续迭代工作
  回滚掉）、继承错 iteration → 新 pending 行对当前 frontier 不可见 → cross-clarify stall。
- **C#2 `retryNode` 级联继承（task.ts:1131-1155）**：`desc(retryIndex)` 且无 iteration /
  parentNodeRunId 过滤——占位行可从 fanout shard 子行继承 `parentNodeRunId`（frontier 不可见，
  级联静默失效）或落错 iteration；retryIndex 序本身是被团队判死过的语义（task.ts:942-948
  resumeTask 同 bug 修过一次）。
- **C#5 `readPortAtIteration`（scheduler.ts:3776-3814）**：已是 id 序（指控半误），但**缺
  done-only 过滤**——同 iteration 有更新的非 done 行（如并发 designer rerun 刚铸的 pending）
  时读到 `''`：loop 的 `port-empty` 退出条件被空串**误判提前退出**，且把 `''` 持久化为 wrapper
  输出。注释还在描述 RFC-074 已退役的三元组比较器。
- **options-T1.ts:63（核查新发现）**：内存版 `reduce(retryIndex 最大)` 挑复活候选——同
  resumeTask 修过的 shadow 场景，且绕过 s13 的 SQL 文本守卫（守卫只 grep
  `desc(nodeRuns.retryIndex)`）。
- **lifecycleRepair/helpers.ts:33-43 `loadNodeRunsForNode`**：死导出（自 RFC-057 引入起零调用
  点），s13 G5 守卫锁的就是它——直接删除。
- **scheduler.ts:815-827 commit&push 归属挑行**：done-only ✓ 但 `desc(startedAt)` 序——低危
  fork，一并收敛。
- review.ts 的 3 个 picker 已全部 id 序（无现行 bug），迁移到共享 picker 是纯机械收敛；
  `resolveUpstreamInputs` 的两级序（max iteration 再 id）保持手写不强迁。

## 目标

1. **比较器下沉**：`isFresherNodeRun` + `buildFreshestDonePerNode` 移入 freshness.ts（纯模块）；
   scheduler.ts 保留一行 re-export（6 个测试文件零改动）；review.ts 改 import freshness ——
   scheduler↔review 模块环断掉一半。
2. **共享 picker**：freshness.ts 新增 `pickFreshestRun(rows, {topLevelOnly?, statusIn?})`
   （nodeId/iteration 谓词留在调用方 SQL WHERE）；review.ts 三点 + scheduler `priorDoneDesigner`
   机械迁移。
3. **四处病理修复**（各配 red→green 测试）：
   - triggerDesignerRerun → id 序 + top-level 过滤（替换 startedAt 序）；
   - retryNode 级联继承 → id 序 + top-level 过滤（占位行不再继承子行身份/错 iteration）；
   - readPortAtIteration → 加 done-only（与 RFC-074 口径对齐）+ 删过期注释；
   - options-T1 reduce → id 序。
4. **守卫升级**：s13 按各 [FLIP-ON-FIX] 翻转（G1 比较器移籍、G3 task.ts fork 清零、G5 死导出
   删除、G6 全 src `desc(nodeRuns.retryIndex)` 清零）；新增「`desc(nodeRuns.startedAt)` 不得
   用于 node_runs freshest 挑行」与内存 retryIndex-reduce 模式的守卫。

## 非目标

- 不动 `resolveUpstreamInputs` 的两级序与 `task.ts:949-954` resumeTask per-node map（语义
  各异，强行套 picker 反而引入风险；登记为后续）。
- 不动 review.ts `sourceRun` 的 post-check 语义（pick 不滤 status、事后查 done——改成
  statusIn 过滤会把显式失败静默降级为读旧行，见核查报告）。
- 不修 clarify 三表写序（WP-10）。

## 验收标准

- [ ] 比较器/共享 picker 单测在 freshness 名下落地；6 个既有 isFresherNodeRun 测试零改动全绿。
- [ ] 四处病理各有 red→green 用例：designer-rerun 选行（NULL startedAt 新铸行被选中 / 病理行
      不被选中）、retryNode 占位行不继承 parentNodeRunId 且 iteration 正确、loop port-empty
      在同迭代 pending 行存在时不误退出、options-T1 复活候选不被 stale 高 retryIndex 行 shadow。
- [ ] `scheduler-audit-s13-*` 按 FLIP 指引翻转 + 新守卫（startedAt 序 / 内存 reduce）落地。
- [ ] review 全套 / cross-clarify 全套 / lifecycleRepair 全套 / loop exit-condition 既有用例
      全绿；`bun run typecheck` + 根 `bun test` + `bun run format:check` 全绿；CI 全绿。
