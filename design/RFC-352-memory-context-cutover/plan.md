# RFC-352 实施计划 — Memory bounded context 合同归位

- 状态：Draft（待用户批准；批准前不改任何生产代码）
- current-source pin：`6752ec8c7`
- 开工分母（账本重分桶 `48078eaa2` 之后）：W4-E2 exact edge **67**、facade **8**

## 1. 任务分解

| 任务    | 内容                                                                                                                                                                                               | 依赖  | 冲突面                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| **T1**  | 落权限矩阵 characterization oracle（六 scope × 三角色 × 读/管），**先红后绿的反向用法**：迁移前它必须全绿，之后每一步都不许它变                                                                    | —     | 仅新增测试文件                                                               |
| **T2**  | `domain/` 建四个纯函数模块（注入渲染 / 蒸馏输出解析 / 源上下文 / prompt），从 `memoryInject.ts` / `memoryDistiller.ts` / `distillerSourceContext.ts` 平移，零行为改动                              | T1    | 三个 legacy 文件                                                             |
| **T3**  | `domain/scopeAuthorization.ts` + `application/memoryAuthorization.ts`：授权谓词从 `infrastructure/sqliteMemoryCatalog.ts:1098,1117` 上移，`hasResourceAclBypass` 改经 `ResourceAclBypassPort` 注入 | T1,T2 | `modules/memory/infrastructure/*`、`cli/start.ts:1917`                       |
| **T4**  | source-control 落 offered `RepositoryScopeAuthorizationInTx`（行为逐字等于今天），memory 的 repo/repo_group 分支改经它                                                                             | T3    | `modules/source-control/public/participants.ts`（新增）                      |
| **T5**  | 注入迁入 `application/injection/`，实现 `TaskMemoryInjectionPort`；`parseInjectedSnapshotJson` 经 `memory/public/types` 供 TE                                                                      | T2    | `modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts:111` |
| **T6**  | 蒸馏迁入 `application/distill/` + `infrastructure/distillerProcess.ts`（`DistillerProcessPort`）                                                                                                   | T2    | `services/memoryDistiller.ts`                                                |
| **T7**  | 调度迁入 `application/distill/schedule.ts`；保持 `memory-distill` 可暂停 handle 与 `beforeStart: recoverRunning`                                                                                   | T6    | `cli/start.ts:785`、`cli/postgresqlDaemonApplication.ts`                     |
| **T8**  | 列表分页下推进 typed query；`routes/memories.ts` / `memoryDistillJobs.ts` 收成 decode/call/map                                                                                                     | T3    | 两个路由文件                                                                 |
| **T9**  | 删 8 个 facade（生产 consumer 归零后）；转交 18 条不属于 memory 的 exact ids（fusion 9→E3、runtime 3→E4b、off-dag 6 登记进 DAG offered 集）                                                        | T2–T8 | `services/memory*.ts`、`rfc294Canonical.ts` 的 `TARGET_CONTEXT_EDGES`        |
| **T10** | `architecture:write` 重采 + 收口（`STATE.md` / `design/plan.md` / RFC 状态改 Done + exact-SHA CI 取证）                                                                                            | T9    | `architecture/*`（与并发 session 排队）                                      |

## 2. PR 拆分建议

单 RFC 单 PR（本仓直推 main）。提交按 T 分批，每批自带测试：
`T1` → `T2` → `T3+T4`（授权一刀，避免中间态两套判据）→ `T5` → `T6+T7` → `T8` → `T9` → `T10`。

## 3. 回滚点

- T2 是纯平移，可整批 revert；
- T3+T4 只切授权取数路径，不改判据——回滚先恢复 infrastructure 出口再切 binding；
- T6+T7 回滚需同时恢复 handle 注册，否则蒸馏 worker 会脱离可暂停集合（RFC-349 不变量）；
- T9 只在 consumer=0 后删 facade，回滚先恢复 facade 再切 import。

## 4. 验收清单

对齐 `proposal.md §7`：AC-1 facade 归零 / AC-2 模块不反向借 / AC-3 授权不在 infrastructure /
AC-4 SC participant 落地且错绑必红 / AC-5 权限矩阵逐格不变 / AC-6 路由只 decode-call-map /
AC-7 分页两 provider 对拍 / AC-8 蒸馏行为 oracle / AC-9 冻结守卫 / AC-10 转交记账 /
AC-11 零 schema-wire-前端 / AC-12 exact-SHA hosted CI 终态成功。

## 5. 并发协调

- `cli/start.ts` / `cli/postgresqlDaemonApplication.ts`：`agent-workflow-58`（RFC-349）已于 2026-09-03 明示
  「不占了」，但其 T10/T11 取证若再暴出 provider-session 问题会回来动 `start.ts`——开工前先 `git fetch` 看 tip。
- `architecture/*`：任何重采前先确认 census 源码面
  （`packages/{backend,shared,frontend}/src` + `.dependency-cruiser.cjs` + `scripts/depcheck.ts`）只剩自己的改动；
  推之前用 `git archive <本提交>` 导出重跑做逐字节自验。
- `services/fusion.ts` 属 E3，本 RFC 只保证它消费的 memory public 面稳定，不改它。
