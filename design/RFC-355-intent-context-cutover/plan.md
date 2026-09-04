# RFC-355 实施计划 —— Intent bounded context 归位

- 状态：Draft（待用户批准）
- current-source pin：`c7c6fb81b`
- 开工分母：W4-E4a exact **176**（legacy-inbound 117 / temporary-internal-debt 30 / legacy-outbound 29）、
  facade **18**（17 legacy-implementation + 1 thin-facade）、`services/intent/` **5136 行**、
  `routes/intentSessions.ts` **1088 行**

## 1. 任务分解

| 任务 | 内容 | 依赖 | 冲突面 |
| --- | --- | --- | --- |
| **T0** | 查清 `postgresqlIntentApplyArtifactOwners.ts` 为何 SQLite 侧无对应物（design §7 R1）。结论写进 `design.md` 后才动手；若判定是漏实现，本刀按「先红后绿」处理 | — | 仅读源码 |
| **T1** | 先落双 provider 等价 oracle 与诊断词汇 oracle（`rfc355-intent-apply-equivalence` / `…-diagnostic-vocabulary`）。**改造前必须红** | — | 仅新增测试 |
| **T2** | `intentResourcePlanOf` 提进 `domain/intentResourcePlan.ts`，两个 provider 共用；加判据矩阵 + 源码断言 | T1 | 两个 provider 的 apply 文件 |
| **T3** | claim / settle 判据提进 `domain/applyPreconditions.ts`；session 串行锁提进 `application/sessionApplyLock.ts` | T2 | 同上 |
| **T4** | 落 `ports/intentApplyPersistence.ts`，两个 provider 各实现一份薄 adapter；apply 编排收成 `application/applyChangeset.ts` 一份（design §2 逐段裁决） | T0,T3 | **本刀最重的一步**，两个 provider 的 apply 主文件 |
| **T5** | 日志收敛合一（`application/journalConvergence.ts`）；诊断标签统一 → T1 的 oracle 转绿 | T4 | 同上 |
| **T6** | RC 落 `SkillArtifactParticipantInTx`（public 合同 + 两个 provider adapter + composition 装配出口）；intent 的 30 条深取改经窄端口，bootstrap 注入 | T4 | RC `public/participants.ts`、RC infrastructure、三个 bootstrap 根 |
| **T7** | `services/intent/` 的 18 个文件迁进 `modules/intent/{domain,application}`；逐字文本加字节级绊线 | T5 | `services/intent/**`（整目录删除） |
| **T8** | `routes/intentSessions.ts` → `modules/intent/inbound/intentSessionRoutes.ts`，收成 decode-call-map | T7 | `routes/intentSessions.ts`、`server.ts`、`cli/*` 的挂载点 |
| **T9** | 清理 `modules/intent/public/*`：撤掉只被自家 inbound 消费的符号（RFC-353 T12 的教训），按实际 consumer 增删 | T8 | intent public |
| **T10** | `architecture:write` 重采 + 收口（`STATE.md` / `design/plan.md` / RFC-294 N18 与 W4-E4a 勾选 + exact-SHA CI 取证） | T9 | `architecture/*`（与并发 session 排队） |

## 2. PR 拆分建议

单 RFC 单 PR（本仓直推 main）。提交按 T 分批，每批自带测试：

`T0`（纯文档结论）→ `T1` → `T2+T3`（判据提取，两批一起避免中间态两套判据）→ **`T4+T5`（不可拆：
拆开会留下「一份编排已落、另一个 provider 还在用旧的」的半截形状）** → `T6` → `T7` → `T8` → `T9` → `T10`。

## 3. 回滚点

- T2/T3 是纯提取，可整批 revert；
- **T4+T5 不可拆着回滚**：回滚要同时恢复两个 provider 的旧编排；
- T6 回滚需同时把 intent 的深取改回去，否则 apply 断；
- T7 是纯平移，可整批 revert；
- T8 回滚需把路由挂载点指回 `routes/`。

## 4. 门禁

- **设计门**：本三件套写完、请批前跑一次 Codex 设计门（**只审功能；安全类一律不扫描、不分析、不提 findings**）。
- **实现门**：declare done 前跑一次，范围按路径限定到本刀改过的文件。
- **CI**：唯一权威门禁。push 后按 exact SHA 盯**到 run 级 `conclusion == success`**
  （job 级 `cancelled` 不等于失败，汇总 job `CI required` 在 run 被取消时也显示 failure——
  RFC-353 §12 已实撞并记档）。
- **本地秒级自查**：只对改过的文件跑 `bunx prettier --check` 与 `bunx eslint --max-warnings 0`；
  再按 `docs/dev-gotchas.md` 那条——拿被改动路径的字符串去 `tests/` 搜字面量，命中的账本 / 守卫全部跑一遍。
  **RFC-353 实撞**：路由迁位后 `api-contract-coverage` / `route-error-code-coverage` 会红，
  本刀因 RFC-353 已扩过扫描面而不再复现，但**新端点仍须登记契约注册表**。
- **账本涨了必须两笔一次 push**（`docs/dev-gotchas.md` §账本）：内容笔带 `allowGrowth`，
  紧接着的退许可笔删掉它再重采，两笔**同一次 `git push`**。

## 5. 并发协调

- `modules/resource-catalog/**`：T6 会动它的 `public/participants.ts` 与 composition 出口；
  RFC-353 刚动过同一区域，开工前 `git fetch` 看 tip。
- `cli/start.ts` / `server.ts` / `cli/postgresqlDaemonApplication.ts`：T6/T8 各动几行，
  这三个是全仓最热的并发面——**按路径精确 `git add`，提交前 `git diff --cached -- <file>` 逐 hunk 认领**
  （RFC-353 §11.1：只看 `--name-only` 会把别人同一文件里的未提交 hunk 一起推上主干，已实撞）。
- `architecture/*`：重采按 `git archive <自己的 commit>` 导出树跑；
  **导出树只隔离按路径读的源码，不隔离 workspace 包**（`node_modules/@agent-workflow/shared` 回指工作树），
  跑测试仍会吃到别人未提交的改动——判「这条红是不是我的」优先查 CI 上该 sha 的结果。
- 拷回 `architecture/*` 时**不要整目录 `cp`**：RFC-353 曾因此覆盖并发 session 未提交的 `guard-manifest.json`。

## 6. 验收清单

对齐 `proposal.md §7`：AC-1 `services/intent/` 归零 / AC-2 consumer 逐条确认或转交 /
AC-3 apply 编排单一实现（含变异测试）/ AC-4 30 条深取归零 / AC-5 诊断词汇统一且 15 条错误码不变 /
AC-6 路由只 decode-call-map 且 wire 面逐字冻结 / AC-7 行为 oracle 一行未改 /
AC-8 W4-E4a 自有 ids 归零且**全局 exception 净变化如实记账（不写「不增」）** /
AC-9 exact-SHA hosted CI run 级 success。

## 7. 工作量的诚实估计

| 面 | 规模 | 风险 |
| --- | ---: | --- |
| 纯平移 | 5136 行 | 低，量大 |
| 两份 apply 合一 | ~1500 行 → 一份 + 两个薄 adapter | **高**（本刀主要风险） |
| RC participant | 30 条边 | 中，形态已验证 |
| 路由迁位 + 收口 | 1088 行 | 中 |

**比 RFC-353 大**：那一刀是 1218 + 226 行平移 + 两个 participant；这一刀是 5136 + 1088 行平移
+ 一份编排合并 + 一个 participant。按 RFC-353 的实际节奏（T1→T12 约一个工作日连续推进），
本刀预计需要 1.5～2 倍的推进量，且 T4 那一步无法并行。
