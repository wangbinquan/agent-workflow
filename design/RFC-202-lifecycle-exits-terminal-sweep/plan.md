# RFC-202 任务分解（plan）

> 单 PR 交付（仓规默认）；commit 前缀 `feat(lifecycle): RFC-202 …`。任务间依赖标注在括号内；每个任务的测试与实现同 commit 落地。

## 任务清单

> 2026-07-16 Codex 设计门评审（6 P1 + 5 P2）已全部折入 design.md 与下列任务规格。

- **RFC-202-T1 空列表评审自动通过（P0）**
  `review.ts` dispatch 空分支改造：铸 run → 写空 `accepted`/`approval_meta`（`auto:'empty-list'`）→ approve-review 转 done → 返回完成变体；可见性走 `node_run_events`（`review-auto-approved`）而非 summary（runScope 会丢弃 summary）。测试：inline/path 双 kind、事件落库、非空回归、wedged 存量行重入解卡、approval_meta 无归属。
- **RFC-202-T2 封存器与终态钩子**（依赖 T1 的 review 侧事件补边）
  新建 `services/terminalSweep.ts`：clarify 按 kind 分支（self→canceled；cross→abandoned 双表，避开 0031 CHECK）+ review node_run；`transitionNodeRunStatusInTx` 同步原语（dbTxSync 拒 thenable）；`scope: 'all'|'clarify-only'`，workgroup 自治切换委托时传 clarify-only（防误伤活任务的 review/completion gate）；shared node_run 转移表补 awaiting_review→canceled（如缺）；`lifecycle.ts` 增 `registerTerminalTaskHook`（to ∈ {done,canceled}，try/catch）；`cli/start.ts` 装配注册；**写路径护栏**：sealRoundQuestions / submitReviewDecision / 问题下发在写事务内校验 owning task 终态 → 409 `task-terminal` 先于落库。测试：cross+self 混合 sweep、clarify-only scope、单事务原子性、钩子失败不阻转移 + 护栏兜底、源级防环锁。
- **RFC-202-T3 awaiting\_\* 可取消**（依赖 T2 封存器）
  `cancelTask` allowedFrom 放宽 + fallback CAS 放宽；`task-not-cancelable` zh/en 文案更正；前端 `tasks.detail.tsx` cancelable 判定放宽。测试：backend 转移 + 前端按钮渲染 + 文案断言。
- **RFC-202-T4 优雅关停 reason 通道**
  `abortAllActiveTasks(reason)` → `controller.abort(reason)`；调度器 4 个检查点按 `signal.reason` 分流到新 `interruptTaskRow`（interrupted + `daemon-restart`）；**runner abort 分支同分流：活动 node_run 写 interrupted 而非 canceled**；`shutdown.ts` 幸存者改盖 `daemon-restart`。测试：任务行 + node_run 双语义 / 用户取消逐字节回归 / autoResume 拾取两类。
- **RFC-202-T5 deleteWorkflow 定时任务守卫**
  `scheduledRowsReferencingWorkflow` helper + `workflow-scheduled-referenced` 409；details 遵守 RFC-099：仅 principal 可见的 `{id,name}` + `hiddenCount` 聚合；词条不带占位符，`workflows.edit.tsx` 调用点就地渲染 details 清单。测试：命中/未命中/坏 JSON payload/他人私有 schedule 不泄名；agent 守卫回归；前端清单渲染。
- **RFC-202-T6 待办口径过滤 + 死轮拒答**
  `listClarifyRoundSummaries` 与 `listReviewSummaries` 待办口径排除 `TERMINAL_TASK_STATUSES` 任务——**过滤在分页/SQL limit 之前生效**；pending-count 用不带 limit 的精确计数；admin clarify pending-count 改道 rounds 口径；clarify/review 详情响应携带任务状态/封存原因，前端按原因分文案（终态 vs 自治撤销），review 决策端点终态 409 + 中文词条（`task-terminal`/`review-not-awaiting`/`clarify-round-terminal`）。测试：list/count 双面消失、僵尸挤窗场景、failed 任务 resume 后重现、封存轮 409 零落库、admin/非 admin 口径一致、review 终态 409、前端双文案。
- **RFC-202-T7 修复弹窗 ok:false 消费**
  `RepairConfirmModal` 分流（不关窗 + banner + 折叠原文）；新词条 `tasks.repair.applyFailedBanner`。测试：ok:false 不关窗、ok:true 回归。
- **RFC-202-T8 resume 失败上浮**
  reviews/clarify/taskQuestions 三路由 await+catch，响应加可选 `resume` 字段（shared schema 扩展）；前端三页 warning banner + 词条 `common.resumeFailedAfterSubmit`。测试：路由层 resume 抛错 → 200+resume.ok:false；`task-not-resumable` 仍静默；前端 banner 渲染。
- **RFC-202-T9 收尾**
  `bun run typecheck && bun run test && bun run format:check` + frontend vitest + `bun run build:binary` smoke；Codex 实现门评审并折入 findings；`design/plan.md` 状态翻 Done、`STATE.md` 记录；push 后按 sha 查 CI。

## 验收清单（对应 proposal §5）

- [ ] A1 空列表评审自动通过（T1）
- [ ] A2 awaiting\_\* 可取消 + 封存 + 文案（T2/T3）
- [ ] A3 关停 → interrupted+daemon-restart，autoResume 全覆盖（T4）
- [ ] A4 修复失败可见 + resume 上浮（T7/T8）
- [ ] A5 deleteWorkflow 守卫（T5）
- [ ] A6 待办清场（含存量行）+ 死轮拒答不落库（T2/T6）
- [ ] A7 全量门槛绿（T9）

## 协调注意（并行 RFC）

- RFC-201 会话占用 `zh-CN.ts`/`en-US.ts`/settings 面：本 RFC 的 i18n 增量集中为 ~8 个新键，提交时按 [feedback_mixed_file_cross_dep_commit] 检查混合 hunk。
- RFC-200 触及 backend prompt/envelope 路径：本 RFC 的 `review.ts` 改动集中在 dispatch/approve 数据层，不碰 prompt 拼接；如遇同文件并发 hunk，按精确 pathspec 提交并先与用户确认冲突。
- `scheduler.ts`/`task.ts` 为高频冲突文件：实现期间每次动手前 `git diff` 检查他人在途改动。
