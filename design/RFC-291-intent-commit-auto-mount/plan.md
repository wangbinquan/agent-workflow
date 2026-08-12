# RFC-291 任务分解 — 意图会话提交入库后的自动挂载

> 产品视角见 [`proposal.md`](./proposal.md)，技术设计见 [`design.md`](./design.md)，
> 设计门记录见 [`design-gate-2026-08-12.md`](./design-gate-2026-08-12.md)。

## 状态

**设计门已过（v2）**，待用户批准进入实现。

初版经双路设计门判 FAIL（11 条 finding：路 1 两条 + Codex 九条，其中「面 C 覆盖不全」两路独立同发）。
8 条已在 v2 文档中处置，3 条方向题用户拍板后纳入（面 E / 面 F / copy 承诺弱化）。

## 用户拍板记录（2026-08-12）

| #   | 问题                                            | 决策                                                                                                                                   |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | 自动挂载范围                                    | **本次创建的资源全部设为挂载根**（先问「只挂顶层是不是会导致改不了」，核实闭包边不全 + 取消挂载连坐 + 引用变化掉出详情三点后改选全挂） |
| P2  | 是否设根数量上限                                | **不设上限**                                                                                                                           |
| P3  | copy 场景原件处置                               | **挂副本 + 卸原件**                                                                                                                    |
| P4  | 失效挂载硬失败                                  | **纳入本 RFC，跳过并提示**                                                                                                             |
| P5  | 闭包缺 call-workflow / call-workgroup 两条边    | **纳入本 RFC 顺带修**                                                                                                                  |
| P6  | copy 链                                         | **只留最新副本为挂载根**（「你现在需要挂载最新的修改副本啊，不然下次修改的基础都没了」）；派生关系须跨轮次持久                         |
| P7  | 存量会话回填                                    | **不做**                                                                                                                               |
| P8  | 设计门 P1-a：call 边无法映射 handle + 泄漏 ULID | **纳入本 RFC 一并修**（面 E）                                                                                                          |
| P9  | 设计门 P1-b：copy 承诺强度                      | **弱化承诺**——只保证「不再是显式挂载根」，不引入抑制态                                                                                 |
| P10 | 设计门 P1-d：handle ordinal 回收                | **纳入本 RFC 修**（面 F）                                                                                                              |

## 任务

### T1 — 清单纯函数 + 派生字段 + 高水位

- 文件：`packages/backend/src/services/intent/manifest.ts`
- 内容：
  - `IntentManifestEntry` 加可选 `copiedFromResourceId`（**谱系根**，design §4.3/§4.5）。
  - `AutoMountInput` + `applyCommitMounts(manifest, input)`，三步语义（**同源旧副本退根 → 原件退根 →
    创建物挂根**，顺序不可交换，design §3.3）。
  - `inheritCopyProvenance(next, prior)`：按 `(resourceType, resourceId)` 承继谱系字段。
  - `createHandleAllocator(seed, watermark?)`：计数器取 `max(清单推导, watermark[type])`（面 F）。
  - 修正 `manifest.ts:51-52` 与实现相反的注释。
- 测试：`packages/backend/tests/rfc291-auto-mount-manifest.test.ts`（design §10.1，含 O→C1→C2→C3 谱系
  用例与顺序回归锁）。
- 依赖：无。

### T2 — `ResolvedIntentOp.copiedFromHandle`

- 文件：`services/intent/resolveChangeset.ts`
- 内容：类型加可选字段（`:300-313`），`resolved.push`（`:643`）在 `isCopy` 时置 `op.target`。**不动**
  copy 丢弃 `manifestEntry` 的既有逻辑（`:647`）。
- 依赖：无。

### T2b — dump 重建承继派生关系

- 文件：`services/intent/dumpBuilder.ts`
- 内容：`buildIntentDump` 返回前调 `inheritCopyProvenance`，一处覆盖 detail / inventory / 不可用根三条
  构造路径。
- 依赖：T1。**漏掉这步 AC-8b 只在同轮成立、跨轮静默失效。**

### T3 — 提交大事务接线

- 文件：`services/intent/applyChangeset.ts`
- 内容：大事务内收集 `applied` 中 `action === 'create'` 的资源、`preparedOps` 的 `copiedFromHandle`，
  由**提交前清单**推出谱系根，调 `applyCommitMounts`，结果并入 `:1070` 那条 `set`（与 epoch 递增同语句）。
- 测试：`rfc291-commit-auto-mount.test.ts`（design §10.2，含事务边界故障缝、replay 的 journal/receipt
  断言、跨轮承继）。
- 依赖：T1、T2、T2b。

### T4 — 端到端「提交后可改」回归锚

- 文件：`packages/backend/tests/rfc291-commit-then-update.test.ts`（仅测试）
- 内容：design §10.3 —— **六类各一条** commit→dump→update 正向链路 + AC-17 双守卫负向锁。文件顶注明锁
  的是本次用户报告的缺陷。
- 依赖：T3。

### T5 — 失效挂载跳过（覆盖 materialize）

- 文件：`services/intent/dumpBuilder.ts`（根检查 + **逐资源 materialize** 失败统一转 unavailable；真错
  照抛）、`turnEngine.ts`（传 note）、`intentDoc.ts`（`unavailableMountNote` 入参）。
- 测试：`rfc291-unavailable-mount.test.ts`（design §10.4，含 catalog→materialize 竞态 seam、真错不吞、
  整轮收尾、上游接线断言）。
- 依赖：无。

### T6 — 闭包扩边 + 判据单点化 + 复杂度

- T6a：新建 `services/execution/callRefTarget.ts` 的 `pickCallTarget(ref, visibleCandidates)`——**裁决
  全在 helper 内**（名字相等 / hint 优先 / 最老 ULID）；`freezeCallClosure` 改用它并删本地挑选逻辑
  （零行为，靠对拍保证）。
- T6b：闭包展开的 agent 边收口到 `extractWorkflowAgentRefs`（renderer 保留，见 AC-16 口径）。
- T6c：新增 `call-workflow` / `call-workgroup` 两条闭包边，目标解析走 `pickCallTarget` + `VisibleCatalog`。
- T6d：`queue.shift()` → 游标队列；邻接展开跨 roots 共享 memo（design §6.5）。
- 测试：`rfc291-closure-call-edges.test.ts`（design §10.5，含 freeze/dump 同夹具对拍、64 根复杂度回归）。
- 依赖：T6a → T6c；T6b / T6d 独立。

### T7 — 前端提示

- 文件：`packages/frontend/src/routes/intent.detail.tsx`（不可用挂载项加小字）、
  `packages/frontend/src/i18n/{en-US,zh-CN}.ts`（各 1 条 key）。
- 约束：不新增组件、不改列表结构、不加 wrapper testid；该文件是三方并发热点（RFC-290 / `5e95ac58` /
  本 RFC），**以符号定位而非行号**，只追加、按路径精确 `git add`。
- 测试：`packages/frontend/tests/rfc291-mount-unavailable-hint.test.tsx`。
- 依赖：T5（文案语义随其定稿）。

### T8 — call 边 handle 绑定（面 E，P8）

- 文件：`services/intent/dumpBuilder.ts`（call 节点 `workflowId/workgroupId` → `workflowRef/workgroupRef`，
  解析走 `pickCallTarget`）、`resolveChangeset.ts`（回写：`delete ref; id = resolveRef(ref)`，并用目标行
  真实 name 覆盖 name 字段；ref 进既有引用 ACL 收集）、shared `IntentWorkflowPayloadSchema`（加可选
  ref 字段，call 的 id 字段在 intent 域不接受模型输入）、`intentDoc.ts`（INTENT.md 契约同步改写）。
- 测试：并入 `rfc291-closure-call-edges.test.ts` 的面 E 行为用例（dump 无 id / 有 ref；原样回传后落库
  `workflowId` 与 dump 所示目标同一行；同名两行不回落）。
- 依赖：T6a（共用 `pickCallTarget`）。
- ⚠️ prompt 是模型唯一读到的规格：本任务**必须**有驱动真实 `applyIntentChangeset` 的行为测试，不能只
  断言 doc 文本（`docs/dev-gotchas.md` 教训：两条 P1 曾都出在 doc 里）。

### T9 — handle 高水位（面 F，P10）

- 文件：DB migration（`intent_sessions.handle_watermark_json TEXT NOT NULL DEFAULT '{}'`）、
  `manifest.ts`（allocator 取 max）、`dumpBuilder.ts` / `applyChangeset.ts`（写回单调高水位）。
- 测试：`packages/backend/tests/rfc291-handle-watermark.test.ts`（design §10.6：cap 淘汰后不复用 ordinal；
  旧行默认值退化不报错）。
- 依赖：T1。

## PR 拆分建议

单 RFC 默认单 PR（`CLAUDE.md §RFC workflow` 第 5 条）。本 RFC 六个面彼此独立且各带测试，按主干开发节奏
拆成四个连续提交、同批推送：

1. **提交 ①（面 A+B+F）**：T1 + T2 + T2b + T3 + T4 + T9 —— 用户报告缺陷的正解、回归锚，外加与清单同模块
   的 handle 高水位（同改 `manifest.ts`，合并可避免连续两次改同一文件）。
2. **提交 ②（面 C）**：T5 + T7 —— 失效挂载可用性。
3. **提交 ③（面 D）**：T6a-T6d —— 闭包扩边、判据单点化、复杂度。
4. **提交 ④（面 E）**：T8 —— call 边 handle 绑定（依赖 ③ 的 `pickCallTarget`）。

每个提交前跑 `bun run gate:local`；推完按 exact SHA 查 CI。若动到 `KNOWN_VIOLATIONS`，连跑
`packages/backend/tests/depcheck-gate.test.ts` 元测试（并发 session 2026-08-12 教训）。

## 验收清单

- [ ] AC-1 ~ AC-5（自动挂载，含 ordinal 不复用口径）
- [ ] AC-6 ~ AC-8 + AC-8b（copy 语义：卸原件、谱系根、只留最新副本、跨轮承继）
- [ ] AC-9 / AC-9b ~ AC-11（失效挂载：materialize 覆盖、真错不吞、整轮收尾、上游接线）
- [ ] AC-12 ~ AC-15（闭包扩边，含 freeze/dump 对拍与「不泄漏名字」边界）
- [ ] AC-16 ~ AC-17（回归防护，断言口径已收窄 / 双守卫各断一次）
- [ ] AC-18 ~ AC-19（call 边绑定：无 id、有 ref、回写不丢缓存、三处目标恒等）
- [ ] AC-20 ~ AC-21（handle 高水位：不复用 ordinal、旧行退化）
- [ ] `bun run gate:local` 全绿
- [ ] 既有 `rfc234-intent-routes.test.ts`「create with mounts」复跑确认（它断言首轮 `detail:true`，是
      受影响面，见 design §10.8）
- [ ] Codex 实现门跑过并处置 findings
- [ ] `design/plan.md` RFC 索引状态改 Done、`STATE.md` 完成表加行

## 实施记录

### 提交 ①（面 A+B+F）— 2026-08-12

落地：T1 + T2 + T2b + T3 + T4 + T9。

- `manifest.ts`：`IntentManifestEntry.copiedFromResourceId`（**谱系根**）、`applyCommitMounts`
  （三步、顺序不可交换）、`inheritCopyProvenance`、`lineageRootOf`、
  `createHandleAllocator(seed, watermark?)` + `handleWatermarkOf` / `mergeHandleWatermarks` /
  `parseHandleWatermark`；并把 `:51-52` 那句与实现相反的注释改写为「为什么单靠清单做不到」。
- `resolveChangeset.ts`：`ResolvedIntentOp.copiedFromHandle`（`isCopy` 时置 `op.target`）。
- `dumpBuilder.ts`：`handleWatermark` 入参 + `handleWatermark` 出参；返回前统一 `inheritCopyProvenance`。
- `applyChangeset.ts`：大事务内由**提交前清单**推谱系根、收集 copy 源 handle，`applyCommitMounts`
  结果与 `commitSeq`/`contextRevision`/`currentDraftId` **同一条 `set`** 落库。
- `turnEngine.ts` / `session.ts`（初始挂载 / 挂载批准 / `addIntentMount`）：三处写回单调高水位。
- migration `0149_rfc291_intent_handle_watermark.sql` + `meta/_journal.json` 登记（149 条）。

测试：`rfc291-auto-mount-manifest`（20）/ `rfc291-commit-auto-mount`（7）/
`rfc291-commit-then-update`（8，六类各一条 + 双守卫负向锁）/ `rfc291-handle-watermark`（3）
= **38 用例全绿**；既有 intent 套件 170/170 绿。

实施中发现并处置：

- `upgrade-rolling.test.ts` 硬编码 migration 总数（148→149）——加迁移必然碰的锁，已更新并补注。
- handle 高水位的**对照用例**最初写错了复现路径：删中间 ordinal 不会让计数器回退（更大的还在清单里
  撑着），**必须删当前最大的那个**。修正后对照组确实复现了「新资源拿到历史 handle」，反向证明了
  设计门 P1-d 属实。
- 端到端锚的夹具坑两处：plugin 的临时目录路径被凭据扫描器判为 credential-shaped（改用可预测路径 +
  waiver slot）、workgroup 的 leader 必须是 agent 成员。均为夹具问题，非实现问题。

门禁：主工作树首跑有 3 个失败（`scheduler-clarify-dispatch` ×2、`rfc213-pending-restore` ×1），
单独复跑 18/18 全绿，且 `main` 同期 CI 全绿——判定为**本地 4-shard 并发时序 flaky**，非本批引入
（按 `CLAUDE.md` 不以「重跑就过了」作为通过依据，改用下述隔离复跑取证）。按 `docs/dev-gotchas.md`
定式改在 **pin 到 `a4854d1d` 的 detached worktree**（只 cp 本批改动）复跑：backend 4/4 shard 全绿，
quality 仅 prettier 报本批 5 个文件（已格式化），format/depcheck/typecheck/frontend 全绿。

## 登记不做

| #   | 项                                   | 理由                                                                                                                                                |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | 挂载数量上限 / 自动 GC               | 用户拍板不设（P2）；逃生舱是手动取消挂载                                                                                                            |
| N2  | 存量会话回填                         | 用户拍板不做（P7）。`intent_provenance` 技术上支持，但会撑大老会话且可能覆盖用户已有的手动挂载选择                                                  |
| N3  | 资源包导入路径自动挂载               | 无会话归属，RFC-271 决策 26 边界                                                                                                                    |
| N4  | `copiedFromHandle` 进 apply 回执     | 内部编排细节，进回执要动 shared schema 与前端解析面；可断言面用清单本身                                                                             |
| N5  | 闭包深度 / 数量上限                  | 与 `freezeCallClosure` 保持一致，靠去重收敛；复杂度问题改用游标队列 + memo 解决（T6d），不靠截断                                                    |
| N6  | 全量 `(type,id) → handle` 映射持久化 | 只持久化高水位即可消灭「ordinal 错指」这一危害；全映射需无界增长结构，收益不匹配。「条目淘汰后重现可能换 handle」登记为已知限制（design §8.3 / R4） |
| N7  | copy 原件的「不可达」抑制态          | 用户拍板弱化承诺（P9）：为兑现不可达而把被引用件降级为 reference-only 会损害「改父资源要看得到子资源」的正常场景                                    |
