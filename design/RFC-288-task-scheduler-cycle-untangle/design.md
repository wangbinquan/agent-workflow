# RFC-288 — 技术设计（design）

> 现状测绘（2026-08-13 只读子代理，Tarjan 重算）全文为准；锚基线 da706b19。
> ⚠️ 2026-08-03 审计文档的行号已漂（scheduler.ts:182→:202、:3196/3237/3256→
> :3406/:3447/:3468、:3880→:4102、9021 行→9847 行），实现期以本文锚为准 +
> 每批逐锚复核。

## 1. 环地图（测绘摘要）

- **SCC 成员 8**（值级；含 type 边为 10——launchMultipart 与 execution/types
  仅以 `import type` 挂边，被 `.dependency-cruiser.cjs:137` type-only 豁免。
  **风险登记**：任何人把这两条改值 import 即 SCC=10 + 门禁新红）。
- 边全集：A1（task.ts:114 runTask 上行，唯一）；B1（scheduler.ts:202
  emitTaskStatus/getTask 静态——消费仅 :9108-9109 两行，全环最薄边）；
  B2/B3/B4（:3406/:3447/:3468 动态 cancelTask/resumeTask/isTaskActive）；
  C1（:3903 动态 startExecution）；C2（:4102 动态 startWorkgroupTaskFromFrozen
  ——facade 旁路）；C3（:253 getExecutionOutcome 静态，方向正确）；
  D1-D7（executor/agentLaunch/workgroup.launch → task 的启动臂边，方向正确，
  A1 断后自然无环；D7=AGENT_HOST_AGENT_NODE_ID 单常量）；E1-E3（gc 旁支：
  materializingSpaces 共享 Map / invalidateCallGraphIndex / expandService
  getTask）。
- 极小环 C-1..C-7 与 6 条账的映射见测绘 §2.3；**C-6（经 outcome→agentLaunch）
  无独立账目**——断 C-3 后 depcruise 可能改报 C-6 的 (from,to) 对，触发
  「unknown 新违规 + stale 旧条目」双红（账本身份是 (rule,from,to) 三元组，
  depcheck.ts:317）。

## 2. taskDriver 叶子契约（G1）

```ts
// services/taskDriver.ts —— 真叶子（判据同 scheduledTaskRefs.ts:8-12：
// 零 service 依赖；仅 ws/broadcaster + AbortController + shared 类型）。
export const activeTasks: Map<string, ActiveTaskHandle>   // 自 task.ts:191 迁入
export function isTaskActive(taskId): boolean
export function abortAllActiveTasks(): void               // shutdown.ts 消费
export function emitTaskStatus(task): void                // 自 task.ts:3959-3980 迁入
// kick 注入面（组合根注册，形状沿 orphanReconcile.ts:86 的 taskHasDriver seam 先例）：
export function registerSchedulerDriver(d: { kick(taskId, opts): Promise<void>;
  cancel(taskId): Promise<void>; resume(taskId, deps): Promise<void> }): void
export const driver: Readonly<...>                        // 未注册即调用 → 响亮 throw
```

- task.ts 三个 kick 点（:2498/:3158/:3916）与 scheduler 的 B2/B3/B4 全改经
  driver / 叶子函数；A1 删除。
- cli/start.ts（daemon 组合根）与测试 harness（createApp 处）注册真身；
  测试专用出口（**setActiveTaskForTesting / **registerActiveTaskForTesting）
  随 activeTasks 迁址并保名（88+ 测试文件 import 路径批量改）。
- C1/C2 转静态：scheduler → executor 方向在 A1 断后无环；
  startWorkgroupTaskFromFrozen 收 executor facade（invoker 分支），
  scheduler.ts 进 CALL_FACES（rfc243-executor-facade.test.ts:45-51 手工清单），
  oracle=「`startWorkgroupTaskFromFrozen(` 不再出现在 scheduler.ts」。
- D7 常量下沉 `services/agentHostConstants.ts`（或 shared）——独立小刀可先落
  （同 .dependency-cruiser.cjs:118-122 workgroup/constants.ts 先例）。

## 3. 第二/三刀（G2/G3）

- workspace/materialize.ts：task.ts:379-1741 物化域整体迁移（函数名保持；
  task.ts 留薄 re-export 过渡一刀内清干净——不留 facade，88 个测试文件
  import 改锚随刀）。agentLaunch 的 D5 三符号改 import 新址。
- taskReadModel.ts：getTask 族读模型迁出；expandService.ts:12 改锚（E3 断）；
  scheduler B1 的 getTask 消费同步改锚。
- workspaceLeases.ts：materializingSpaces Map 叶子化（E1 断），gc.ts:35 的
  E2 方向本就正确保留。

## 4. 中间态账本策略（AC-2 的实现细则）

每刀 PR 的 depcheck 账本操作**必须原子**：删除已销条 + 若 depcruise 改报同环
另一代表对（C-6 型），当刀新增临时条目（why 注明「WP-5 中间态，removeWhen=
RFC-288 T<下一刀>」，满足 gate 的格式棘轮 depcheck-gate.test.ts:200-238）。
gate fixture 硬编码的 scheduler↔task 样例对（:63-64 等五处）在末刀改为
仍真实存在的违规对（如 git 环族），防误导。

## 5. 测试策略

- 每刀：depcheck 全绿（销账即 oracle——WP-5 原文 :310 的门禁即预言机策略）+
  受影响家族全套件 + kick/shutdown/orphanReconcile 行为对拍。
- 新源锁：scheduler.ts 禁 `from '@/services/task'`（rfc257:26-33 同型）；
  export 面收缩断言；CALL_FACES 更新对。
- 终局：Tarjan 复算脚本断言零值级 SCC（可做成常驻棘轮测试）。
- 实现门：双路独立子代理。
