# RFC-202 任务分解（plan）

> 单 PR 交付（仓规默认）；commit 前缀 `feat(lifecycle): RFC-202 …`。任务间依赖标注在括号内；每个任务的测试与实现同 commit 落地。

## 任务清单

- **RFC-202-T1 空列表评审自动通过（P0）**
  `review.ts` dispatch 空分支改造：铸 run → 写空 `accepted`/`approval_meta` → approve-review 转 done → 返回完成变体；summary 带 auto-approved 标记。测试：inline/path 双 kind、非空回归、wedged 存量行重入解卡、approval_meta 无归属。
- **RFC-202-T2 封存器与终态钩子**（依赖 T1 的 review 侧事件补边）
  新建 `services/terminalSweep.ts`（泛化 `dismissOpenClarifyParksForAutonomous`，clarify 三层 + review node_run）；workgroup 封存器改为委托调用方；shared node_run 转移表补 awaiting_review→canceled（如缺）；`lifecycle.ts` 增 `registerTerminalTaskHook`（to ∈ {done,canceled} 触发，try/catch）；`cli/start.ts` 装配注册。测试：封存三层、workgroup 回归、钩子失败不阻转移、源级防环锁。
- **RFC-202-T3 awaiting\_\* 可取消**（依赖 T2 封存器）
  `cancelTask` allowedFrom 放宽 + fallback CAS 放宽；`task-not-cancelable` zh/en 文案更正；前端 `tasks.detail.tsx` cancelable 判定放宽。测试：backend 转移 + 前端按钮渲染 + 文案断言。
- **RFC-202-T4 优雅关停 reason 通道**
  `abortAllActiveTasks(reason)` → `controller.abort(reason)`；调度器 4 个检查点按 `signal.reason` 分流到新 `interruptTaskRow`（interrupted + `daemon-restart`）；`shutdown.ts` 幸存者改盖 `daemon-restart`。测试：shutdown 分流 / 用户取消逐字节回归 / autoResume 拾取两类。
- **RFC-202-T5 deleteWorkflow 定时任务守卫**
  `scheduledRowsReferencingWorkflow` helper + `workflow-scheduled-referenced` 409（details 带 ids/names）；zh/en errors 词条。测试：命中/未命中/坏 JSON payload；agent 守卫回归。
- **RFC-202-T6 待办口径过滤 + 死轮拒答**
  `listClarifyRoundSummaries` 与 `listReviewSummaries` 的待办口径排除 `TERMINAL_TASK_STATUSES` 任务；admin clarify pending-count 改道 rounds 口径；`clarify-round-terminal` zh/en 词条；`clarify.detail.tsx` 封存轮状态说明条（替换「草稿已保存」页脚）。测试：list/count 双面消失、failed 任务 resume 后重现、封存轮 409 零落库、admin/非 admin 口径一致、前端说明条。
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
