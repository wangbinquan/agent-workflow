# RFC-350 —— plan（任务分解）

> 前置：`proposal.md`（D1–D14 / 能力影响清单 / AC-1～AC-16）、`design.md`（落位、判据、流程、端口、测试策略）。
> 用户 2026-09-02 已批准并授权完整实现（明示跳过设计门；实现门仍按 T21 跑）。

---

## 1. 任务分解

### 阶段 A —— 判据与配置（无行为变化，可独立合入）

| id         | 任务                                                                                                                                                                | 依赖 | 产物                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------- |
| RFC-350-T1 | `domain/idleTimeoutPolicy.ts`：`TaskActivityRecord` / `IdleTreeVerdict` / `judgeIdleTree`，零依赖纯函数；头注释写明「为什么评论/成员变更不算活动」与 F-9 的竞态语义 | —    | 新文件 + 单测 T-1～T-7 |
| RFC-350-T2 | 配置：`config.ts` 加 `taskIdleTimeout{enabled,idleHours}`（默认关 / 24h）；`settingsNumericBounds.ts` 加 `taskIdleTimeout.idleHours` 与 `'hours'` 单位              | —    | schema + bounds        |
| RFC-350-T3 | 前端单位支持：`formatUnit.ts` 的 `NumberRangeUnit` 加 `'hours'` + `UNIT_STEPS.hours`；parity 测试跟上                                                               | T2   | 前端 lib + 单测        |

### 阶段 B —— 端口与两个 provider

| id         | 任务                                                                                                                                                                  | 依赖  | 产物          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- |
| RFC-350-T4 | `application/ports/taskIdleTimeoutPersistence.ts`：`TaskIdleTimeoutPersistence` / `TaskIdleTimeoutOperations` / 两个快照类型                                          | T1    | 端口文件      |
| RFC-350-T5 | `infrastructure/sqliteTaskIdleTimeoutPersistence.ts`：`listIdleCandidateRoots` / `loadTreeActivity` / `writeIdleTimeoutReason`；活动口径按 design §2.1 四类数据源合成 | T4    | 适配器 + 单测 |
| RFC-350-T6 | `infrastructure/postgresqlTaskIdleTimeoutPersistence.ts`：同形实现                                                                                                    | T4    | 适配器        |
| RFC-350-T7 | provider 对拍测试：同 fixture 灌两边，输出逐字段相等（AC-15 的一半）                                                                                                  | T5,T6 | 测试          |

### 阶段 C —— 收割编排

| id          | 任务                                                                                                                                                                                            | 依赖     | 产物                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| RFC-350-T8  | `application/taskIdleTimeoutReaper.ts`：扫描 → 判定 → 杀进程 → cancel → 覆盖原因 → 写 `recovery_events`；kill/cancel 均以依赖注入进来，保证可单测                                               | T1,T4    | 编排 + 单测 T-8～T-14 |
| RFC-350-T9  | 恢复审计新 kind：`TaskRecoveryEventKind` 加 `'idle-timeout-reap'`（`taskRecoveryOperations.ts:3-16`）                                                                                           | —        | 后端类型              |
| RFC-350-T10 | `composition/taskIdleTimeout.ts`：两个 provider 的装配出口（cancelTask 由调用方注入，不伪造兜底）                                                                                               | T5,T6,T8 | 装配                  |
| RFC-350-T11 | `DAEMON_CADENCE.taskIdleTimeout = 5 * MINUTE_MS` 登记                                                                                                                                           | —        | cadence               |
| RFC-350-T12 | 接线：SQLite `cli/start.ts:3169` `providerBackgroundWriterFactories` + PostgreSQL `cli/start.ts:1005` `backgroundWriterFactories`，均走 `createPollingDaemonRuntimeHandleFactory`；配置每拍热读 | T10,T11  | bootstrap             |
| RFC-350-T13 | 冻结窗口守卫测试：收割器在迁移冻结时被 stop+drain（参照 `rfc349-sqlite-daemon-pausable-writers.test.ts`）                                                                                       | T12      | 测试（AC-15）         |

### 阶段 D —— interrupted 归档补齐

| id          | 任务                                                                                                       | 依赖 | 产物          |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ---- | ------------- |
| RFC-350-T14 | `services/taskArchive.ts:95` 的 `TERMINAL` 改引 shared `TERMINAL_TASK_STATUSES`；PostgreSQL 侧同款常量对齐 | —    | 一行改动 ×2   |
| RFC-350-T15 | 回归测试 T-15～T-17（T-15 **必须先红**：证明今天 `interrupted` 树确实不出库）                              | T14  | 测试（AC-11） |

### 阶段 E —— 用户可见面

| id          | 任务                                                                                                                                    | 依赖            | 产物                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------- |
| RFC-350-T16 | 失败文案：`task-failure.ts` 的 `EXACT_TOKENS` 加 `'task-idle-timeout'`；zh-CN / en-US 补 `tasks.failure.summary.idleTimeout` + `__hint` | T8              | 前端 + i18n                  |
| RFC-350-T17 | 恢复区：`RecoverySection.tsx:44` 的 `RECOVERY_EVENT_KINDS` 加 `'idle-timeout-reap'` + 双语文案                                          | T9              | 前端 + i18n                  |
| RFC-350-T18 | 设置页卡片：开关 + 阈值 + worktree 提示，全部复用 `Switch` / `Field` / `BoundedNumberInput` 等既有原语                                  | T2,T3           | 前端 + i18n + 单测 T-23/T-24 |
| RFC-350-T19 | 端到端：T-18～T-22（收割 → 原因 → 审计 → 出库 / 只终结不出库 / 软删除豁免）                                                             | T12,T14,T16,T17 | 集成测试                     |

### 阶段 F —— 收口

| id          | 任务                                                                                                                                  | 依赖 | 产物                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------- |
| RFC-350-T20 | 文档：`design/plan.md` RFC 索引状态改 Done；`STATE.md` 已完成表加行；如踩到通用坑补 `docs/dev-gotchas.md`                             | 全部 | 文档                |
| RFC-350-T21 | Codex 实现门（只审功能，明写「安全类一律不扫描不提」——`CLAUDE.md` 2026-08-26 硬规则），findings 分「纯实现我改」/「涉及方向你定」两堆 | 全部 | 门记录写回本文件 §3 |

---

## 2. PR 拆分建议

默认**单 PR**（RFC workflow 第 5 条），commit 前缀 `feat(task-execution): RFC-350 任务不活跃超时收割`。

若实现期发现体量过大，按下面切两笔，且**必须保持顺序**（阶段 D 先落，它是独立的既有缺陷修复，
先红后绿最干净）：

- PR-A：阶段 D（T14/T15）—— `interrupted` 归档补齐，独立可验证，`fix(task-archive): RFC-350 ...`
- PR-B：阶段 A/B/C/E/F —— 收割主体

---

## 3. 门记录

- 设计门：**用户明示跳过**（2026-09-02，同 RFC-325 / RFC-330 的先例）。
- 实现门：待跑（T21）。

---

## 4. 验收清单（逐条对应 proposal §6）

- [ ] AC-1 默认关时行为与今天一致，一次 IO 都不发
- [ ] AC-2 全树静默超阈值 + 有非终态成员 → 非终态成员全部 `canceled`，`finished_at` 为收割时刻
- [ ] AC-3 树内任一成员有新动作 → 整树不收
- [ ] AC-4 新建 pending 任务不被立刻收割
- [ ] AC-5 收割前对非终态 run 的活进程执行 `killStaleRunProcessTree`，outcome 入审计
- [ ] AC-6 杀不掉时仍然终结并记异常
- [ ] AC-7 `error_summary='task-idle-timeout'` + 详情页中文文案
- [ ] AC-8 每次收割写 `recovery_events`；空巡检不写
- [ ] AC-9 收割后可被既有归档按 `retentionDays` 出库
- [ ] AC-10 只开收割不开归档 → 只终结不出库
- [ ] AC-11 全 `interrupted` 树能被归档出库
- [ ] AC-12 `idleHours` 1–8760 双端同源校验
- [ ] AC-13 设置页卡片 + worktree 提示
- [ ] AC-14 软删除任务豁免
- [ ] AC-15 两 provider 行为一致 + 注册为可暂停写手
- [ ] AC-16 配置热生效
