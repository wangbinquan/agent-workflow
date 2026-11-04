# RFC-444 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`RC` = `S/modules/resource-catalog`。以 RFC-443 落地后的源码（`21ae7afa3`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：resource-catalog 的 `domain/systemResources.ts`，模块外经 `public/types`。
- **承担的演进**：
  - W4 B / D 第十步：import `services/` 的路由 10 → 9；
  - 清偿 W4-C 遗留的 KE-03 两条 R2 边（knowledge-evolution application → legacy），`R2` 41 → 39；
  - task-execution 两个 infrastructure 文件、resource-catalog 三个 composition 文件不再为内建资源清单 import legacy。
- **不新增** DAG 之外的边：task-execution → resource-catalog、knowledge-evolution → resource-catalog 都在 `OFFERED_CONTEXT_EDGES` 里；
  domain 文件只 import `@agent-workflow/shared` 与 `@/util/errors`（domain 已有同样的依赖）。
- **留下的债**：内建资源播种改为 participant；其余 9 个路由。
- **偏离项**：无。

## 1. 文件去向

| 原文件                          | 新位置                         | 说明                                                                                       |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `S/services/systemResources.ts` | `RC/domain/systemResources.ts` | 原样搬迁（行号不变，审计锚点 `:24-28` 只改路径）                                           |
| —                               | `RC/public/types.ts`           | 转出 `SKILL_MERGER_AGENT_{ID,NAME}`、`SKILL_FUSION_WORKFLOW_{ID,NAME}`、`assertNotBuiltin` |

## 2. 连接

- resource-catalog 内部（`composition/agentOperations.ts`、`workflowOperations.ts`、`resourceAcl.ts`）改取 `../domain/systemResources`。
- 经 `@/modules/resource-catalog/public/types`：task-execution 的 `taskRouteLaunchOperations.ts`、`taskRouteOperations.ts`；
  bootstrap 的 `daemonModules/scheduledTasks.ts`；路由 `agents.ts`、`resourceAcl.ts`；legacy 的 `taskLaunchGate.ts`、
  `execution/taskExecutionResourceDependencies.ts`；knowledge-evolution 的 `fusionOrchestration.ts`（四个常量）。
- `fusionOrchestration.ts`：`QUARANTINED_FUSION_SKILL_ID` 改取 `@agent-workflow/shared`；删去生产里没有消费者的兼容再导出及其注释
  （`rfc101-builtin-list-hidden`、`rfc104-builtin-readonly` 两个用例改从清单本身取两个 name 常量）。

## 3. 守卫与用例

- **账本**（`architecture/commons-debt.json`）：
  - 删去 KE-03 的两条 R2 边，`outboundEdges` 41 → 39；
  - 审计条目锚点 `services/systemResources.ts:24-28` 改为新路径（同行号）。
- **公共内核清单**（`architecture/commons-manifest.json`）：`systemresources-ts` 条目的 `files` 改指新路径，`layer` 随之由
  `application` 改为 `domain`（RFC-317 的「清单 ↔ 源码闭合」守卫按文件存在性核对）。
- **改 import 的用例与辅助**：十个用例 / 辅助改取 `RC/domain/systemResources`。
- **架构报告**：legacy 归属表删去该行（新文件在模块内按位置归 resource-catalog）。
- **新用例** `T/rfc444-builtin-resources-into-resource-catalog.test.ts`：
  - 原文件不存在，新文件就位；源码里没有文件 import 旧路径（带负对照）；
  - 模块外的引用方只经 `public/types`，`public/types` 只转出上面五个符号；
  - knowledge-evolution 不再 import 也不再转出 legacy 的内建资源清单；`resourceAcl` 路由不 import `services/`；
  - 行为：两个 id 与两个 name 的字面值不变；`assertNotBuiltin` 对内建行抛 `ForbiddenError`、对普通行放行。
- **行为由既有用例覆盖**：RFC-104 内建只读、RFC-101 列表隐藏、RFC-165 迁移字面值、技能融合溯源修复、ACL 端点矩阵。

## 4. 账本与计数（实测为准）

- `commons-debt.json` 如上；`guard-manifest.json`、`counts.json` 不变。

## 5. 失败模式

- **审计锚点失效**：锚点按「路径:行号」校验，原样搬迁保证行号不变，只改路径。
- **public 面扩大**：只转出模块外实际用到的五个符号，新用例锁住转出清单。

## 6. 测试策略

全部实现与用例写完后集中验证一次：静态检查；全量 SQLite；导出仓库（含 PostgreSQL 真库）跑全部架构测试与受影响用例；P0 变异 lane。
