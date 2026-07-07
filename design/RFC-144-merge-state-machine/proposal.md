# RFC-144 · merge_state 状态机化（proposal）

- **状态**：Draft（待用户批准）
- **来源**：`design/flag-audit-2026-07-07.md` §4.4（六大 P0 之一，路线编号 RFC-G2）
- **前置调研**：2026-07-07/08 四路并行只读调研 + 两轮定点核实（写点全景 / 读点分桶口径 / RFC-053/097 范式模板 / RFC-130 原始设计与测试群 / 取代路径与 abandon 接线）

## 1. 背景

`node_runs.merge_state` 是 RFC-130（节点 worktree 隔离）引入的第二正交生命周期列：一个隔离运行的
delta 是否已落回任务 canonical worktree。它驱动四类关键判定——settled 门（done 行不算 completed
除非 merged）、frontier done 分支分桶（conflict-human→awaiting_human、merge-failed→failed）、
任务入口崩溃重放（replayPendingMerges / replayConflictHumanResolutions）、fanout shard 重跑撤销。

对比同表的 `status` 列（RFC-053/097/108 建成的四层防护：事件 ADT + 转移表 + CAS + 源码守卫棘轮），
`merge_state` 是**零层防护**：

- **19 处写点**全部是 `db.update(nodeRuns).set({ mergeState })` 裸直写（全在
  `services/scheduler.ts`），零事务、零 CAS，WHERE 只按主键；
- **无任何类型定义**：无 TS union、无常量集、无 zod、无 DB CHECK——纯裸 `text` 列；
- **文档已漂移**：`db/schema.ts:770-773` 注释声称的值域包含从未写入的 `conflict-resolving`，
  漏掉两个热路径值 `isolating` / `merge-failed`（这两个值是实现期新增，RFC-130 三份设计文档全无）；
- **读点口径靠隐式跨点不变量**：settled 门与 done 分支的分桶只在「replay 先于 frontier 跑」这个
  调用顺序上成立，无编译链接；新增第 7 个值会静默落入 not-complete / blocked / 不被选中，零报错。

### 1.1 调研坐实的真 bug：stale replay（被取代行的过期 delta 重放）

`runTask` 入口**每次**（fresh / resume / retry 不分）都会执行两个重放：

```
replayPendingMerges        WHERE task_id=? AND merge_state='pending-merge'    (scheduler.ts:1704)
replayConflictHumanResolutions  WHERE task_id=? AND merge_state='conflict-human' (scheduler.ts:1776)
```

两者**只按 (taskId, merge_state) 捞行**——无 status 过滤、无「是否被取代」过滤；而全部取代路径
（retryNode 级联、review supersede、scheduler stale-redispatch、cancel 后复活）都**不清理旧行的
merge_state**。后果：一个停在 `pending-merge` 的被取代旧行，会在下一次任务入口被重放，把**过期
delta 物化进主树**——静默脏 canon。具体触发链（已核实各环节，file:line 见 design.md §7）：

1. 节点 agent 成功、delta 已 pin（`pending-merge`），daemon 在 merge-back 前崩溃 → 任务 `interrupted`；
2. 用户对该节点 **retryNode**（interrupted 任务允许）——旧行原样保留（status 与 merge_state 都不动），
   新行 mint 后 `runTask` 被踢起；
3. 入口 `replayPendingMerges` 捞到旧行 → 把旧 delta 合并进 canon → 新行随后以「含旧 delta 的 canon」
   为基础重跑 → 双重应用 / 幽灵改动。

同理 review reject/iterate 的 supersede（旧行打 `canceled` 但 merge_state 不动）、fanout wrapper
失败后 resume 时旧 shard 的 `conflict-human` 决议重放，都在同一风险面上。

## 2. 目标

1. **merge_state 获得与 status 同级的四层防护**（照抄 RFC-053/097 已验证范式）：
   - shared 纯函数转移表（事件 ADT + `never` 穷举 + 派生 allowedFrom + 终态集）；
   - backend CAS 包装（`transitionMergeState`，`UPDATE … WHERE merge_state=from RETURNING`）；
   - 守卫豁免标记 + grep-guard 源码守卫测试（allowlist 精确计数棘轮）；
   - 转移表穷举测试 + CAS 竞态测试。
2. **引入第 7 值 `abandoned`**（用户 2026-07-07 拍板）：行被取代时，其 merge_state 若停在
   {`isolating`, `pending-merge`, `conflict-human`}，显式打到 `abandoned`——replay 天然不捞、
   列自解释。不变量：**abandoned ⇔ 该行已被更新一代取代**。
3. **修复 stale replay 真 bug**：mint 后代行时原子废弃前代行（含其子行）的在途 merge_state；
   migration 清洗存量僵尸行。先写复现测试（红）再修（绿）。
4. **读点表派生**：settled 集、frontier done 分支分桶改为从 shared 单源派生 + 穷举 switch。
5. **文档与命名对齐**：矫正 schema 注释；统一同文件内 `awaiting_human` / `conflict-human`
   两套内存联合命名；补齐 `merge-failed` 的行为测试（现状 13 处写点近零行为断言）。

## 3. 非目标

- **不改 merge-back 的 git 语义**：三路合并、writeSem 锁序、合并 agent、resolve-iso 机制全部不动。
- **不改 frontier 现有分桶行为**（除新增 `abandoned` 一格落入既有 blocked 桶）：settled 门仍是
  {NULL, merged}，conflict-human 仍冒 awaiting_human，merge-failed 仍冒 failed。
- **不加 DB CHECK 约束**：与 status 列一致，合法性在应用层守卫（零迁移风险、滚动升级安全）。
- **不触前端 / API**：该列从未序列化给客户端（调研核实零暴露），本 RFC 纯 backend + shared。
- **不做 merge-failed 的重试语义**：merge-failed 保持终态 sink（重试走新行、从 `isolating` 重新起步），
  「merge-back 抛错后原地重试合并」是独立产品问题，不在本 RFC。
- **不动 iso GC**：GC 只读 task status（调研核实），abandoned 不需要 GC 判据变更；abandon 是
  **纯列写入、绝不删 iso worktree**（clarify D19 的答后续跑依赖保留的 iso）。

## 4. 用户故事（对内质量）

- **作为平台开发者**，我新增一种 merge 事件时，编译器强制我填转移表（`never` 穷举），漏接一处
  读点分桶会在编译期或守卫测试红掉，而不是运行时静默落错桶。
- **作为排障者**，我看到一行 `merge_state='abandoned'` 就知道「这行被取代、它的 delta 永不落
  canon」，不用再去反推「pending-merge 的行为什么六天没人动」。
- **作为用户**，我在任务中断后 retry 节点，不会再看到旧一代的改动幽灵般出现在 worktree 里。

## 5. 验收标准

1. `services/scheduler.ts` 中 19 处 `mergeState` 裸直写清零，全部经由 `transitionMergeState` /
   `abandonSupersededMergeStates`（唯一合法写者 `services/lifecycle.ts`，grep-guard 锁定精确计数）。
2. shared 转移表对 7 事件 × 8 态（含 NULL）穷举测试全绿：合法转移全通过、非法转移全抛
   `IllegalMergeStateTransition`、`allowedFromForMergeEvent` 与转移函数自洽。
3. CAS 竞态测试：SELECT 与 UPDATE 之间插入竞争写者时，后写者以
   `ConcurrentMergeStateTransition` 失败（或 try 变体返回 false），不产生覆盖。
4. **stale replay 回归测试（先红后绿）**：retryNode 取代一个 `pending-merge` 旧行后 kick 任务入口，
   旧 delta 不再物化进 canon（旧行变 `abandoned`、replay 零命中）；review supersede 同理。
5. migration 0076 把存量僵尸行（存在更新的同代 top-level 兄弟行、且 merge_state 在
   {isolating, pending-merge, conflict-human}）清洗为 `abandoned`；合法崩溃窗口行（freshest）不受影响；
   journal 75→76、upgrade-rolling 锁同步。
6. `merge-failed` 获得行为级断言：merge-back 抛错 → 行 `merge-failed` → frontier 冒泡任务 `failed`。
7. RFC-130 既有测试群（rfc130-* 全套 + scheduler.test.ts iso 用例）保持全绿（golden 回归网）。
8. 门禁：`bun run typecheck && bun run lint && bun run test && bun run format:check` + binary smoke 全绿。
