# RFC-230 任务分解 — Run 活性证据链

## PR 拆分

| PR | 范围 | 说明 |
| --- | --- | --- |
| PR-1 | T1 – T5 | 根因：活性证据抽象 + 回收器接线 + 测试。可独立上线，上线即消除误收。 |
| PR-2 | T6 – T7 | 第二道防线：finalize 抗竞态（对应 D3）。依赖 PR-1 的审计留痕，但不依赖其代码。 |
| PR-3 | T8 | 存量 fixup 脚本（对应 D4）。可选，视其它环境是否有受害行。 |

PR-1 与 PR-2 **不合并成一个** commit：前者改「谁有资格发起写」，后者改「写失败了怎么收敛」，两件事的回归面不同，分开更利于二分定位。

## 子任务

### RFC-230-T1 — 活性证据抽象（纯函数）

- 新建 `packages/backend/src/services/runLiveness.ts`：`LivenessEvidence` / `LivenessReason` / `classifyRunLiveness` / `resolveRunLiveness`（契约见 design §4.1）。
- `classifyRunLiveness` 对 `NodeKind` 做穷尽 switch（`never` 兜底），新增 kind 未声明证据来源即 typecheck 失败。
- 内层可达性复用 `wrapperInnerDescendants`（`dispatchFrontier.ts:91`）+ 既有 `parentNodeRunId` 子行，**不引入迭代窗口**（design §3）。
- 纯模块：零 DB、零 Bun/Node IO，进程探针以参数注入。
- **依赖**：无。

### RFC-230-T2 — 判活探针收缩

- `orphanReconcile.ts` 的 `runProcessGone` 收缩为纯进程探针，**删除** `pid === null ⇒ gone` 分支（不留过渡开关）。
- 只在 `kind === 'process'` 分支被调用；类别判断全部上移到 T1。
- **依赖**：T1。

### RFC-230-T3 — 回收器接线 + 驱动门

- `reconcileDeadRunningRuns` 改为逐任务批量读入行集 + 冻结定义，走 `resolveRunLiveness`。
- run 级与任务级（`orphanReconcile.ts:101-117`）双双加 `isTaskActive` 驱动门。
- 定义解析失败 ⇒ `none` ⇒ 保守判活 + warn。
- `recordRecoveryEvent` 的 `periodic-reap` 事件体追加 `reason`（kind 不新增）。
- **依赖**：T1、T2。

### RFC-230-T4 — 测试：判活与回收判定

覆盖 design §7 的 1 – 7 与 9：真探针直测、三种 wrapper 长跑不被收、失驱动 wrapper 被正确收、驱动门、pre-spawn 窗口、空窗、嵌套委派、穷尽性守卫。

- 现有 `tests/rfc108-orphan-reconcile.test.ts` 的注入式用例**保留**（它们测的是编排逻辑，仍有效），新增文件专测真判活。
- 文件顶部写明回归意图并链回本 RFC 与事故报错原文。
- **依赖**：T1 – T3。

### RFC-230-T5 — 诊断面板 reason 呈现

- 回收审计事件的 `reason` 在既有诊断 / 恢复事件视图中呈现，让「为什么被回收」可追溯。
- **落地结论：无需前端改动。** `components/tasks/RecoverySection.tsx:126` 已把 `reason` 挂在条目 `title`（tooltip）上，并在 `:123` 明确记录了「`reason` 是原始英文，故意不进主标签」这一设计决定。T3 让 reason 从 `orphan-reconcile: child process gone` 变成 `orphan-reconcile: inner-all-terminal×1` 这类精确说明，既有呈现路径直接受益；**为此新写 UI 反而会推翻那条既有决定**，故不做。
- **依赖**：T3。

### RFC-230-T6 — finalize 抗竞态（D3）

- `markWrapperTerminal` 捕获 CAS 失败后重读状态：`canceled` / `interrupted` ⇒ 抛 `WrapperSupersededSignal`，由三个 wrapper 分派点共用的 `runWrapperNode` 外壳统一转成 scope 结果（canceled → canceled；interrupted → failed，同样可 resume）；其余非法转移原样抛出。
- **不采用**「返回值 + 15 个调用点各判一次」：收尾撞外部终态必须只有一条出口，15 个分支漏改一个就是静默回归。
- 抛信号前先清 fanout `reuseDisabled` 闸门（留着会永久禁掉该 resume 血脉的 done-shard 复用）。
- **依赖**：无（可与 PR-1 并行开发，合并顺序在其后）。

### RFC-230-T7 — 测试：finalize 抗竞态

覆盖 design §7 的 8：外部抢先 `canceled` / `interrupted` ⇒ 任务收在该终态、不出现 `scheduler error`；`done` 后再 finalize `failed` ⇒ 仍抛。

- **依赖**：T6。

### RFC-230-T8 — 存量 fixup 脚本（D4，可选）

- 仿 `scripts/fixup-rfc052-stuck-review.ts`：先精确校验形状（`interrupted` ∧ `error_message='orphan-reconcile'` ∧ `pid IS NULL` ∧ `spawn_binary_path IS NULL`），不符即拒绝触碰 DB。
- 不写进迁移。
- **依赖**：T3（形状定义随之确定）。

## 验收清单

- [ ] AC1 wrapper 长跑不被收（git / loop / fanout 各一条）
- [ ] AC2 失驱动 wrapper 被正确收，审计 reason = `inner-all-terminal`
- [ ] AC3 驱动门：活跃任务的行与任务行均不被改写
- [ ] AC4 pre-spawn 窗口：有驱动判活 / 无驱动判收
- [ ] AC5 空窗保守判活，reason = `no-evidence-yet`
- [ ] AC6 finalize 撞外部终态收敛为该终态，不出现 `scheduler error`
- [ ] AC7 真判活函数四种输入直测（非注入桩）
- [ ] AC8 新增 run 类型未声明证据来源 ⇒ typecheck 失败
- [ ] 嵌套委派（loop 套 git 套 fanout）跨迭代判活正确
- [ ] 真实 S3 卡死检出未被削弱（`stuckTaskDetector` 回归）
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿
- [ ] 推送后按自己的确切 sha 查 CI（共享 main 并发 push 会取消 run，见 `docs/dev-gotchas.md`）
- [ ] Codex 实现门跑过并修完 findings

## 落档后的收尾

- `design/plan.md` RFC 索引登记 RFC-230
- `STATE.md` 顶部「进行中 RFC」指向本目录；完工后改 Done 并进已完成表
- 通用踩坑（若有）沉淀进 `docs/dev-gotchas.md`；未决项进 `docs/audit-backlog.md`
