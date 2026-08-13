# RFC-300 Webhook 终态工作区即时清理 — 实施计划

状态：**Implemented / Publishing（2026-08-14；完整本地门禁已通过；用户要求跳过外部 Codex review 并直接提交）**

## 1. 前置门

- [x] 核对通用 `worktreeAutoGc`：小时级、四终态、年龄/onlyMerged、默认关闭。
- [x] 核对 Webhook attribution：根任务有 `webhook_trigger_id`，context 继承不能代表磁盘所有权。
- [x] 核对空间语义：remote/scratch 拥有空间，inherited 借用父 call-node iso。
- [x] 用户确认终态只含 done/canceled，failed/interrupted 保留。
- [x] 用户确认 scratch 与事件仓 worktree 都直接删除。
- [x] 明确能力影响与不追溯历史策略。
- [x] 用户正式批准 RFC 三件套与 C1-C6，并要求完整实现、提交、push。
- [x] 实现前复核共享工作树，精确避开并发修改。

## 2. 任务分解

### 批 A — Config 与候选判据

| #          | 任务                                                                       | 验证                      |
| ---------- | -------------------------------------------------------------------------- | ------------------------- |
| RFC-300-T1 | shared Config/schema/default 增加 `webhookTaskWorkspaceAutoCleanup=false`  | config backfill/PATCH/CLI |
| RFC-300-T2 | 新增 exact candidate 纯判据，闭合 source × space × status × tombstone 矩阵 | backend 纯函数            |
| RFC-300-T3 | GcTab 公共 Switch、scope allowlist、双语能力影响 hint                      | frontend render/save/a11y |

依赖：用户批准。

### 批 B — 终态原子 claim

| #          | 任务                                                                        | 验证                          |
| ---------- | --------------------------------------------------------------------------- | ----------------------------- |
| RFC-300-T4 | lifecycle 注册 config-neutral policy provider；daemon assembly 注入当前配置 | provider isolation/reset      |
| RFC-300-T5 | migration 增加 claim cause；同一 CAS 写 status + timestamp + cause          | upgrade + CAS win/loss 原子性 |
| RFC-300-T6 | done/canceled 全写点与 failed/interrupted adjacent-miss 锁                  | lifecycle matrix/source guard |

依赖：批 A。

### 批 C — 共用 prune 原语与续做

| #           | 任务                                                                       | 验证                      |
| ----------- | -------------------------------------------------------------------------- | ------------------------- |
| RFC-300-T7  | 从 `runWorktreeGc` 抽单 task claimed prune；保持 remote/multi/scratch 行为 | 既有 GC 全回归            |
| RFC-300-T8  | task driver settle helper：release active owner 后即时 finalize            | start/resume/retry/cancel |
| RFC-300-T9  | no-active terminal effect、boot reconcile、ticker stale-claim retry        | crash/failure/lease/幂等  |
| RFC-300-T10 | 双 finalizer/setting-off-after-claim/trigger-deleted 并发边界              | deterministic races       |

依赖：批 B。

### 批 D — Task 详情诚实降级

| #           | 任务                                                               | 验证                         |
| ----------- | ------------------------------------------------------------------ | ---------------------------- |
| RFC-300-T11 | Task wire 投影 optional `workspaceState`，旧响应默认 available     | shared/backend compatibility |
| RFC-300-T12 | pruned/pruning notice，取消 preserved 假横幅                       | frontend component           |
| RFC-300-T13 | workspace 不可用时隐藏 node retry、停止 sync preview；后端仍为权威 | frontend + API negative      |

依赖：批 C。

### 批 E — 真实链路与收尾

| #           | 任务                                                           | 验证                        |
| ----------- | -------------------------------------------------------------- | --------------------------- |
| RFC-300-T14 | 真实 Webhook remote/scratch done + canceled 服务/E2E           | task row retained, dir gone |
| RFC-300-T15 | failed/interrupted/inherited/manual 对照                       | dir retained                |
| RFC-300-T16 | 更新 `docs/webhook-triggers.md` 与设置说明                     | doc/source lock             |
| RFC-300-T17 | 本地实现核对、`bun run gate:local`；外部 review 经用户明确跳过 | 全门禁                      |

依赖：批 D。

## 3. 必测用例

### 正常

- remote webhook done/canceled：claim 与终态同写，driver settle 后 linked worktree 消失。
- scratch webhook done/canceled：整座 scratch repo 消失。
- 任务、node runs、事件、会话、DB outputs、archive 仍可读取。
- 任务详情显示已清理，不显示 preserved/retry/sync。

### 反向与相邻遗漏

- failed/interrupted 均保留并继续 Resume。
- ordinary manual/scheduled、internal/local 均不认领。
- `trigger_context_json` 合法但 `webhook_trigger_id=NULL` 不认领。
- `webhook_trigger_id!=NULL` 但 `space_kind=inherited` 仍不认领。
- 已 pruned/claimed 行不重写 claim。
- 开关打开时历史 done/canceled 行不因 config PUT 或 ticker 被新增 claim。

### 并发/失败/恢复

- done vs cancel、terminal vs retry/sync、两 finalizer 竞争。
- cancel fallback 先落 canceled 而 active driver 尚未 settle：目录必须仍在；finally 后才删。
- Git remove 失败：终态不回滚、claim 不清、lease 后续做。
- crash after claim / after delete before finalize；boot 补完。
- crash after iso-GC claim before finally：NULL-cause 不得被 Webhook recovery 接管。
- setting off after claim、trigger row deleted、workspace 人工缺失。

### Config/UI

- 默认 false、保存 true/false、旧 config backfill、CLI round-trip。
- gc scope 白名单含键且其它 scope 不含。
- zh/en 完整；Switch role/label/hint 可访问。
- workspaceState 缺失兼容旧 backend。

## 4. 提交建议

本仓直接在共享 `main` 小步提交，不建分支；每个生产改动同时携带测试：

1. `feat(config): RFC-300 增加 webhook 工作区清理开关`
2. `feat(tasks): RFC-300 原子认领 webhook 终态清理`
3. `feat(gc): RFC-300 即时完成并续做 webhook workspace prune`
4. `feat(frontend): RFC-300 展示 workspace 已清理状态`
5. `test(e2e): RFC-300 锁定 remote 与 scratch 终态清理`
6. `docs(webhook): RFC-300 记录终态工作区策略`

精确暂存本人路径；不 broad-stage、不 reset/stash 并发 WIP。若本 Codex session 对 commit 有实质贡献，
追加实际模型/provider 的 `Co-Authored-By`，push 前用 `git show -s --format=%B HEAD` 核验。

## 5. 验收映射

| Proposal AC                         | 任务           |
| ----------------------------------- | -------------- |
| config/default/settings             | T1-T3          |
| exact source/space/status candidate | T2, T5-T6, T15 |
| atomic claim/no retroactive         | T4-T6, T10     |
| active-owner release ordering       | T8-T10, T14    |
| remote/scratch physical deletion    | T7-T10, T14    |
| failure/crash retry                 | T7-T10         |
| task history retained/UI honest     | T11-T14        |
| generic GC regression               | T7, T15        |
| docs/full gate                      | T16-T17        |

## 6. 完成定义

- Proposal §6 全部勾选；C1-C6 有用户批准记录；
- 正常、异常、并发、回滚、真实 remote/scratch E2E 都有 oracle；
- 相关定向测试与 `bun run gate:local` 全绿；
- 本地实现核对无阻塞 finding；用户明确要求跳过会外发私有 diff 的 Codex review；
- `STATE.md` 与 `design/plan.md` 更新为 Done；
- 若用户另行授权上库，再分别报告本地 commit、push、exact-SHA CI 与 live service 状态。
