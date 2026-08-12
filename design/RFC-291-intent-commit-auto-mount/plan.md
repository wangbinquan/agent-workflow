# RFC-291 任务分解 — 意图会话提交入库后的自动挂载

> 产品视角见 [`proposal.md`](./proposal.md)，技术设计见 [`design.md`](./design.md)。

## 状态

Draft（2026-08-12 落档，待设计门 + 用户批准）。

## 用户拍板记录（2026-08-12）

| #   | 问题                                         | 决策                                                                                                                                             |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | 自动挂载范围                                 | **本次创建的资源全部设为挂载根**（先答「只挂顶层是不是会导致改不了」，核实闭包边不全 + 取消挂载连坐 + 引用变化掉出详情三点后改选全挂）           |
| P2  | 是否设根数量上限                             | **不设上限**                                                                                                                                     |
| P3  | copy 场景原件处置                            | **挂副本 + 卸原件**                                                                                                                              |
| P4  | 失效挂载硬失败                               | **纳入本 RFC，跳过并提示**                                                                                                                       |
| P5  | 闭包缺 call-workflow / call-workgroup 两条边 | **纳入本 RFC 顺带修**                                                                                                                            |
| P6  | copy 链                                      | **只留最新副本为挂载根**（用户：「你现在需要挂载最新的修改副本啊，不然下次修改的基础都没了」）——同一原件再派生时旧副本退根；派生关系须跨轮次持久 |
| P7  | 存量会话回填                                 | **不做**（proposal §7 Q1）                                                                                                                       |

## 任务

### T1 — 清单迁移纯函数 `applyCommitMounts` + 派生字段

- 文件：`packages/backend/src/services/intent/manifest.ts`
- 内容：
  - `IntentManifestEntry` 加可选 `copiedFromResourceId`（design §4.3）。
  - `AutoMountInput` 类型 + `applyCommitMounts(manifest, input)`，三步语义见 design §3.3（**同源旧副本退根 → 原件退根 → 创建物挂根**，顺序不可交换）。
  - `inheritCopyProvenance(next, prior)` 纯函数：按 `(resourceType, resourceId)` 从旧清单承继 `copiedFromResourceId`。
- 测试：`packages/backend/tests/rfc291-auto-mount-manifest.test.ts`（design §8.1，含顺序回归锁与旧清单退化用例）。
- 依赖：无。

### T2 — `ResolvedIntentOp.copiedFromHandle`

- 文件：`packages/backend/src/services/intent/resolveChangeset.ts`
- 内容：类型加可选字段（`:300-313`），`resolved.push`（`:643`）在 `isCopy` 时置 `copiedFromHandle: op.target`。**不动** `manifestEntry` 在 copy 时被丢弃的既有逻辑（design §4.1）。
- 测试：并入 T3 的 copy 集成用例（纯类型字段单测价值低）。
- 依赖：无。

### T2b — dump 重建时承继派生关系

- 文件：`packages/backend/src/services/intent/dumpBuilder.ts`
- 内容：`buildIntentDump` 返回前调 `inheritCopyProvenance(manifest, input.priorManifest)`，一处覆盖 detail / inventory / 不可用根三条构造路径（design §4.3）。
- 测试：并入 T3 的跨轮承继用例（design §8.2 第三条）。
- 依赖：T1。**漏掉这一步 AC-8b 只在同轮成立、跨轮静默失效**，故与面 A+B 同提交。

### T3 — 提交大事务接线

- 文件：`packages/backend/src/services/intent/applyChangeset.ts`
- 内容：大事务内收集 `applied` 中 `action === 'create'` 的资源、`preparedOps` 中的 `copiedFromHandle`，并把 copy 项的 `copiedFromResourceId` 从**提交前清单**解析出来（design §4.2），调 `applyCommitMounts`，结果并入 `:1070` 那条 `tx.update(intentSessions).set({...})`（与 `contextRevision` 递增同语句，不额外 bump）。
- 测试：`packages/backend/tests/rfc291-commit-auto-mount.test.ts`（design §8.2，含连续两次同源 copy 与跨轮承继）。
- 依赖：T1、T2、T2b。

### T4 — 端到端「提交后可改」回归锚

- 文件：`packages/backend/tests/rfc291-commit-then-update.test.ts`（新增，仅测试）
- 内容：design §8.3 —— 正向（提交 → dump → detail+fence → update 通过）与负向（未挂载目标仍拒）双锁；文件顶注明锁的是本次用户报告的缺陷。
- 依赖：T3。

### T5 — 失效挂载跳过

- 文件：`services/intent/dumpBuilder.ts`（`:241` throw → skip + 保留条目 + `unavailableMounts`）、`services/intent/turnEngine.ts`（传 note）、`services/intent/intentDoc.ts`（`unavailableMountNote` 入参，与 `hiddenDependencyNote` 同 `## Access notes` 段）。
- 测试：`packages/backend/tests/rfc291-unavailable-mount.test.ts`（design §8.4）。
- 依赖：无（可与 T1-T4 并行）。

### T6 — 闭包扩边 + 判据同源

- T6a：抽 `pickCallTarget` 纯函数并让 `freezeCallClosure` 改用它（`services/execution/closure.ts`，**零行为**，新旧对拍）。
- T6b：`dumpBuilder` 的 agent 边收口到 `extractWorkflowAgentRefs`，删手写 `'agent-single'` 分支（`dumpBuilder.ts:191`，零行为）。
- T6c：`dumpBuilder` 新增 `call-workflow` / `call-workgroup` 两条边，目标解析走 `pickCallTarget` + `VisibleCatalog` 内存索引；解析不到计入既有 `hiddenCount`。
- 测试：`packages/backend/tests/rfc291-closure-call-edges.test.ts`（design §8.5，含源码层文本断言）。
- 依赖：T6a → T6c；T6b 独立。

### T7 — 前端提示

- 文件：`packages/frontend/src/routes/intent.detail.tsx`（不可用挂载项加一行小字）、`packages/frontend/src/i18n/{en-US,zh-CN}.ts`（各 1 条 key）。
- 约束：不新增组件、不改列表结构、不加 wrapper testid；`RFC-290` 同期在改这两个文件，只做追加、按路径精确 `git add`。
- 测试：`packages/frontend/tests/rfc291-mount-unavailable-hint.test.tsx`（design §8.6）。
- 依赖：T5（`displayName === null` 判据已存在，故实际可并行，但文案语义随 T5 定稿）。

## PR 拆分建议

单个 RFC 默认单 PR（`CLAUDE.md §RFC workflow` 第 5 条）。本 RFC 三个面彼此独立且都带测试，按仓内主干开发节奏拆成三个连续提交、同批推送：

1. **提交 ①（面 A+B）**：T1 + T2 + T2b + T3 + T4 —— 用户报告缺陷的正解与回归锚。
2. **提交 ②（面 C）**：T5 + T7 —— 失效挂载可用性。
3. **提交 ③（面 D）**：T6a + T6b + T6c —— 闭包扩边与去重收口。

每个提交前跑 `bun run gate:local`；推完按 exact SHA 查 CI。

## 验收清单

- [ ] AC-1 ~ AC-5（自动挂载）
- [ ] AC-6 ~ AC-8 + AC-8b（copy 语义，含只留最新副本与跨轮承继）
- [ ] AC-9 ~ AC-11（失效挂载）
- [ ] AC-12 ~ AC-15（闭包扩边）
- [ ] AC-16 ~ AC-17（回归防护）
- [ ] `bun run gate:local` 全绿
- [ ] Codex 实现门跑过并处置 findings
- [ ] `design/plan.md` RFC 索引状态改 Done、`STATE.md` 完成表加行

## 登记不做

| #   | 项                               | 理由                                                                                                                                 |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| N1  | 挂载数量上限 / 自动 GC           | 用户拍板不设（P2）；逃生舱是手动取消挂载                                                                                             |
| N2  | 存量会话回填                     | 用户拍板不做（P7）。`intent_provenance` 技术上支持，但会让老会话上下文突然变大且可能覆盖用户已有的手动挂载选择；存量会话仍可手动挂载 |
| N3  | 资源包导入路径自动挂载           | 无会话归属，RFC-271 决策 26 边界                                                                                                     |
| N4  | `copiedFromHandle` 进 apply 回执 | 内部编排细节，进回执要动 shared schema 与前端解析面；可断言面用 manifest 本身                                                        |
| N5  | 闭包深度 / 规模上限              | 与既有 `expandClosure` / `freezeCallClosure` 保持一致，靠去重收敛（design §9 R2）                                                    |
