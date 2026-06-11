# RFC-097 — 任务分解

单 PR（RFC 默认；main 直推）。commit 前缀：`fix(backend): RFC-097 tasks.status 转移表 + CAS + 任务级互斥`。

## 子任务

### RFC-097-T1 — 助手 + 单测

- services/lifecycle.ts 追加 TERMINAL_TASK_STATUSES / setTaskStatus / trySetTaskStatus
  （design §1）；structuralDiff/store.ts 私有终态集改引。
- 新增 `rfc097-task-status-cas.test.ts`。
- 依赖：无。

### RFC-097-T2 — 27 写点迁移

- 按 design §2 表逐点替换（scheduler 6 / task 3 / limits·orphans·shutdown 3 / lifecycleRepair 15）；
  scheduler done/awaiting 写前 aborted 终检（cancel 应赢）；reapOrphanRuns 增 pending→
  interrupted 任务收割（崩溃窗口补偿，design §3）。
- 依赖：T1。

### RFC-097-T3 — 互斥 + S-23 + S-27

- resumeTask/retryNode CAS 前移所有权锁 + isTaskActive 入口拒 + controller 身份比对（design §3）；
  lifecycleRepair preflight 活性检查（§4）；reviews.ts 分类吞（§5）。
- 依赖：T1-T2。

### RFC-097-T4 — 测试落地与守卫

- 翻转 s08 / s14；新增 rfc097-resume-mutex / rfc097-cancel-wins / S-23 / 重启恢复用例
  （design §7）。
- **测试暗雷迁移**：新增共享 `reenterScheduler` helper，替换对抗检视清单的 10 文件 ≈30 处
  直接重入点；loop-exhausted-resume 重置 pending 保 oracle。
- 依赖：T1-T3。

### RFC-097-T5 — 收尾

- CLAUDE.md 任务状态清单勘误（去 exhausted——实现为准）；design/plan.md 置 Done；STATE.md 登记。
- 门禁：**lint** + typecheck + 根 bun test + format:check；推送查 CI。
- 依赖：T1-T4。

## 验收清单

见 proposal.md「验收标准」。
