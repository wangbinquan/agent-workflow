# RFC-358 任务分解

> r2（2026-09-04）——按设计门两路评审重排：新增 T9（copy 回填）/ T10（下游知情提示），
> T8 前移到批次 2，T3 不再标「无行为变化」，收口补架构账本重采。

编号 `RFC-358-T{n}`。本仓在 `main` 上直接提交、不开 PR（CLAUDE.md §工作准则），下面的「提交批次」即建议的 commit 切分。

## 依赖图

```
T1 (validator 覆盖层 + 防崩) ──┬─► T2 (public 合同) ──► T4 (intent port + draft 接线)
                               │                          ├─► T5 (前端)
T3 (domain 候选构造) ──────────┴──────────────────────────┼─► T6 (图修复轮)
                                                          │
T9 (copy sidecar 回填) ───────────────────────────────────┴─► T7 (apply 二次拦)
T8 (teaching mistakes) 并入批次 2   ·   T10 (下游提示) 独立   ·   T11 收口依赖全部
```

## 任务

### RFC-358-T1 — validator 层接受候选覆盖层 + 两处防崩

- `workflow.validator.ts`：`WorkflowValidationCandidate` 增 `overlays?: WorkflowValidationCandidateOverlays`（agents / skills / mcps / plugins / callWorkflows 五类，design §3.3–§3.5）；新增纯函数 `withValidationOverlays(ctx, overlays)`（新行插入 / 存行 ⊕ 覆盖 / `isNew` 不符即抛 / callWorkflows 按名字+id 双键落）。
- 给 `:1716`（`agent.skills`）与 `:1772`（`agent.dependsOn`）补 `?? []`——与同段 `mcp`/`plugins` 的既有保护对齐。
- `loadWorkflowValidationContext` 与 `postgresqlWorkflowValidation.ts` 的自建 context **各调一次**该函数。
- 单测：合并规则各分支；覆盖层为空时逐字节等价于现状；**合成的 agent 新行经 validator 全判据不抛**。
- 验收：AC-8 / AC-9 的合并语义。

### RFC-358-T2 — resource-catalog public 合同新增 `validateCandidate`

- `public/types.ts`：五类覆盖层类型 + `ValidateWorkflowCandidateCatalogInput` + 结果类型。
- `public/queries.ts`：`WorkflowValidationQueries.validateCandidate`（不要求已存工作流行；不做 admission——引用可用性由第一层与 apply 的 `assertRefsUsableInTx` 负责）。
- `application/workflows/{ports,workflowValidation}.ts`：port **扩既有输入类型**透传 overlays（不新开 port 方法，design §1 注），application 实现新 query。
- 单测：无行候选可校验；overlays 透传到 port；`currentWorkflow` 按 design §3.6 传入。

### RFC-358-T3 — intent domain 候选构造

- 新建 `modules/intent/domain/workflowGraphCandidate.ts`：`WorkflowDefinitionSchema` 前置 safeParse（失败 → op 级 error，不进 validator）、ref 重写、四类覆盖层派生、`currentWorkflow` 派生。
- 覆盖层字段表**逐字段镜像** `resolveChangeset.ts:587-610`（无条件覆盖 5 个 / 省略保留 6 个），并加测试锁死两处同形。
- 把 `resolveChangeset.ts:662-690` 的 apply 期重写改为调用同一函数，**保留「draft 跳过 / apply 抛 `intent-ref-unknown`」的分叉参数**。
- 顺带把第一层 `resolveChangeset.ts:204-215` 那处「safeParse 失败静默跳过」补成 error（既有假绿）。
- ⚠️ **本任务不是「无行为变化」**：它触及 apply 期的引用重写与第一层的一条判据，测试必须覆盖两侧。
- 验收：AC-8、AC-10。

### RFC-358-T4 — draft 接线 + warning / 不可用标记 + shared schema

- 新建 `application/ports/intentWorkflowGraphValidation.ts`；`composition/` 绑到 T2 的 public query。
- `turnEngine.ts`：`validateDraftChangeset` 之后调用；error 汇入 `report.errors`（`<opId>:` 前缀，冒号后无空格）；warning 进 `graphWarnings`；条数上限每 op 20 / 全局 64 且显式标注截断。
- **显式 try/catch**：查库失败 → `graphValidationUnavailable: true`，draft 照落（D7）；不要指望 `intent-graph-validation-failed` 自然出现（既有 catch 会兜成 `intent-turn-crashed`）。
- **`packages/shared/src/schemas/intentSession.ts`**：`IntentDraftDtoSchema.shape.validation` 增两个可选字段——**不改就 500**（`.strict()` + 抛错版 `.parse`）。
- 单测：design §10 的 3、4、5、6、7、8、12 条。
- 验收：AC-1、AC-3、AC-4、AC-9、AC-10、AC-11、AC-12（后端半）。

### RFC-358-T5 — 前端 warning 段 / 截断提示 / 提交禁用

- `intent.detail.tsx`：blocking 段下方新增 warning 段，**用既有 `<NoticeBanner tone="warning">`**（本页 `:647` 已在用）；`graphValidationUnavailable` 时提交按钮按不可用禁用并给出原因文案。
- 顶部 banner 的 `.slice(0, 10)`（`:654`）补 `+N more`——静默截断与 `intentDoc.ts:14` 的约定冲突。
- `<li key={error}>`（`:655`、`components/intent/IntentOpPreview.tsx:154`）改成带 index 的 key：图校验会引入大量同形消息，重复串触发 React duplicate-key。
- i18n（zh/en）。前端测试：warning 渲染 / warning 不禁用提交 / error 禁用提交 / 不可用禁用。
- 验收：AC-2、AC-4、AC-12（前端半）。

### RFC-358-T6 — 图修复轮

- **扩契约**：`IntentTurnOutcome` 增 `blockingErrors` / `graphRepairTurn`；`settleTurn` 返回值同步（`ports/intentPersistence.ts:335-340` + 共用实现）；`dispatchIntentTurn` 接住 `runIntentTurn` 的返回值。
- 标记在 `settle` 闭包（`turnEngine.ts:294-327`）**统一注入**，覆盖全部 11 个调用点。
- 新增**非抛出**的 `reserveGraphRepairTurn`（照 `activateWorkingSetChange` 的形状返回 null），**不要**复用零调用方的 `reserveIntentRetryTurn`。
- **预约在 settle 的同一事务内完成**，消灭 `inFlightTurnId` 空窗（否则用户在窗口里点取消会静默失效）。
- 判据覆盖「**任何非用户直接发起的轮**」（含 working-set successor 轮）。
- 命名用 `graphRepairTurn`，避开既有 `services/autoRepair.ts`。
- 前端：轮次列表标识 + 该轮期间的禁用文案「正在自动修复图校验错误」+ 取消入口显眼；`intent-budget-exhausted` 补文案说明自动轮也计入。
- 单测：design §10 第 9 条全部分支。
- 验收：AC-5、B-3、B-4。

### RFC-358-T9 — copy 的 sidecar 回填（决策 D5 / B-5）

- `legacyIntentApplyResourceParticipants.ts:809-822`：create 分支在 `plan.copiedFromHandle` 存在时，从源行回填 `branchPorts` / `outputKinds` / `role` / `outputWrapperPortNames`（与 update 分支 `:823-858` 同源，抽成一份）。
- PostgreSQL 侧对应路径同步。
- 单测：copy 一个带 sidecar 的 agent → 副本保留四个字段（**红→绿**：改前会丢）；copy 场景下 draft 与 apply 的覆盖层同形。
- ⚠️ 这是**范围外的既有行为修正**，已列 proposal §6 B-5 呈用户确认。

### RFC-358-T7 — apply preflight 二次硬拦

- `intent/application/` 新增共享判据函数，在两个 provider 的 preflight 段各调一次，位置在 **`prepare` 循环之后、`prestage` 之前**（放 `prepare` 之前会拿到未校验定义 → 500，并推红 `rfc234-apply-changeset.test.ts:808`）。
- 红则 `ValidationError('intent-workflow-invalid', …, { issues })`，journal `failed`，零落库。
- **文案按 issue 成因分类**：live 漂移 / 上线前存量草稿 / `finalName` 改名断掉 call 边。
- 单测：design §10 第 10、11 条；并更新 `rfc234-apply-changeset.test.ts:1258-1272` 的预期（该 fixture 的 call-workflow 套 loop 实为 `wrapper-loop-exit-condition` 红，AC-6 会拦下——改动里写明理由）。
- 验收：AC-6、AC-7、B-2。

### RFC-358-T8 — teaching registry 补实证条目（批次 2）

- `domain/teaching/nodeKinds.ts`：补 design §11 列出的几条系统性 warning 到对应 kind 的 `mistakes`。
- 同步 `intent-teaching-registry.test.ts` 的常驻 baseline（该测试带反向 AST 检查）。

### RFC-358-T10 — agent update 的下游知情提示（决策 D6）

- 抽出 `deleteAgent` 里现成的 `workflowsUsingAgentIn`（`legacy/agent.ts:766-816`）供复用。
- 会话详情投影出「引用该 agent 的既有工作流」列表；确认页展示，**不阻塞、不进 INTENT.md**。
- `docs/audit-backlog.md` 记一条：改 agent 无下游守卫、删 agent 有，不对称。
- 单测：AC-13。

### RFC-358-T11 — 收口

- 重跑 `scripts/architecture-census.ts` 并提交 `architecture/*.json`（新增 public 方法与新文件必然改动账本，守卫以生产源码重建为准）。
- `design/plan.md` RFC 索引状态改 Done；`STATE.md` 已完成表加行。
- 通用踩坑 → `docs/dev-gotchas.md`。
- push 后按 exact SHA 盯 CI 到绿。

## 建议提交批次

1. **T1 + T2 + T3**（校验能力与纯判据）——注意 T3 触及 apply 重写与第一层判据，**不是零行为变化**，测试要覆盖两侧。
2. **T4 + T5 + T8**（draft 阶段生效——B-1 在此生效；T8 同批是因为 D1 让 agent 看不见 warning，teaching 是唯一缓解）。
3. **T6**（图修复轮——B-3 / B-4 在此生效）。
4. **T9 → T7**（先回填再硬拦：顺序反了会让 copy 场景被自己的分叉误拦——B-5 / B-2 在此生效）。
5. **T10 + T11**。

每批都自带测试（CLAUDE.md §Test-with-every-change：没有「先实现、之后补测试」这一档）。

## 实现后的 CI 归因（三轮红，逐条落账）

实现推上 `main` 后连红三轮，四条根因全部是本 RFC 的，已逐条修掉并各带回归锁：

| 根因                                                     | 性质                                                                                                                                                                   | 修复                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `topology-cycle` 对**嵌套 wrapper 里的合法循环**误报     | validator 既有缺陷，被接上校验后才暴露：`buildLoopMembership` 只登记 wrapper-loop 的**直接**成员，`loop{ git{ a, b } }` 里 a↔b 的反馈环因此失去豁免                    | `1541c5e54` 改为沿容器链取最近的 loop 祖先；e2e 的 nested-cycle fixture 逐字内联进单测 |
| PostgreSQL ports 文件注释里出现 "SQLite"                 | 撞 provider 隔离守卫                                                                                                                                                   | 同上，措辞改掉                                                                         |
| 图修复轮由 `blockingErrors` **总数**触发                 | **实现执行错误**：第一层的错误（未挂载目标等，要用户做动作）也会自动重跑，白烧一轮并把 draft revision 序列整体后移，`rfc319-intent-draft-and-commit` 两个 shard 同时红 | `e6670a093` 单独记 `graphErrors` 作判据，补回归锁                                      |
| 新错误码 `intent-workflow-invalid` 未登记进 apply 面清单 | 仓里有明文守卫要求「改这张表并说明为什么」                                                                                                                             | `82d4af53b` 登记并写清它挡什么                                                         |

另有一条流程疏漏：改了生产源码却没重采账本（`3b4bb659d` 补）。**教训：改生产源码就要重采，sourceDigest 是全树 canonical 投影的哈希，一行也会变。**

本地预检清单据此补齐（下次改意图 / 校验链路照跑）：意图单测面 + validator 面 + **`e2e/intent-builder.spec.ts` 与 `e2e/rfc319-intent-draft-and-commit.spec.ts`** + 架构守卫（干净副本）+ 改生产源码则重采账本。前两轮红都源于只跑了单测面。

最终状态：`a9b3cb660` 的 19 个 backend/e2e job 中 16 success，两条 failure 属并发 RFC-359（新增两个 persistence 文件未重采账本），与本 RFC 无关。

## 验收清单

- [x] AC-1 图校验 error 带 `<opId>:` 前缀进 blocking 列表
- [x] AC-2 blocking 非空禁用提交
- [x] AC-3 error 进 INTENT.md
- [x] AC-4 warning 只在 UI、不阻塞
- [x] AC-5 图修复轮恰好一轮、无 in-flight 空窗
- [x] AC-6 apply 二次硬拦、零落库、文案分类
- [x] AC-7 两 provider 同一组 issue code（skill 可用性差异已规避或豁免）
- [x] AC-8 bundle 内新建/修改的 agent 以变更后形态参与校验，字段口径与 apply 一致
- [x] AC-9 同批新建 skill / MCP / plugin / 被调工作流无假阳性
- [x] AC-10 畸形定义给可读 error 而非崩溃
- [x] AC-11 issue 条数上限 + 显式截断标注
- [x] AC-12 校验不可用时 draft 照落 + 提交禁用
- [x] AC-13 agent update 的下游知情提示
- [x] B-5 copy 回填经用户确认并落地
- [x] 既有测试影响：`rfc234-apply-changeset.test.ts:808` 未受影响（门放在 `prepare` 之后）、`:1258-1272` 未变红（测试装配缺省不接门）、teaching baseline 已同步
- [x] 架构账本已重采并提交（`ed3000176`，`git archive` 干净副本法，并发在制品 0 条）
- [x] 设计门（只审功能）findings 全部折入 —— r2（12 P0 / 13 P1）
- [x] 实现门 —— **用户 2026-09-04 决定不跑**（Codex 配额至 09-08；本 RFC 的实现证据改由三轮 CI 归因 + 本地 e2e 实跑承担，见下）
- [ ] CI 按 exact SHA 全绿
