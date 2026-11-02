# RFC-426 定时备份经系统运维模块的备份端口、执行可用性去单机回落（RFC-294 S2c）

- **状态**：Done（2026-11-02 落档并实施；exact SHA `14fd0c903` 主 CI 70/70、windows-platform 与 maintenance-soak-nightly 全绿）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你可以
  不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。结构调整之外含一项
  功能缺陷修复（单机 PostgreSQL 的定时备份，用户可见，见 §4）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2c「部署 profile」余项第 2 项的余下部分
- **前序**：[RFC-393](../RFC-393-cli-bootstrap-separation/proposal.md) §7 第 2 项（「定时备份来源移出 provider 适配表」）、
  [RFC-425](../RFC-425-execution-authority-without-deployment-literal/proposal.md) §3 非目标第 1、2 条
- **落位**：system-operations（模块合同、`domain/` 的定时备份请求、`composition` 内按 provider 的装配、`infrastructure/` 的两个本地备份
  协调器）；`platform/background`（定时器只做节拍）；`bootstrap/`（会话的定时备份作业、provider 适配表）；`platform/http`（执行可用性）。

## 1. 背景

**定时备份来源在 provider 适配表里，并且在那里按部署分支。** `bootstrap/daemonSessionAdapters.ts` 的 `scheduledBackup` 项：

- SQLite 交出 `{ db, contract }`，由定时器自己调用 `createBackup({ kind: 'scheduled' })`；
- PostgreSQL 在这一项里按托管选择分支：有 `databaseBackup` 时向平台请求 `{ includeWorktrees: false, kind: 'scheduled' }`，否则调用管理员
  手动备份命令 `requestBackup.execute(localContext, { includeWorktrees: true })`。

后一条有功能缺陷。手动备份命令的输入只有 `includeWorktrees`，本地 PostgreSQL 备份协调器也不透传 `kind`，于是**单机 PostgreSQL 的定时备份
按手动备份落盘**：文件名是手动家族的 `agent-workflow-*`，并带全部工作树。这与 `docs/disaster-recovery.md` 的契约不符：

- §1.2：定时备份为 scheduled 种类，轮转只作用于 `scheduled-*` / `auto-*`；
- §6：定时备份不含 worktrees。

后果：

- `backupRetentionCount` / `backupRetentionDays` / `backupMaxTotalBytes` 管不到这些文件；
- `backupProtectedKeepCount` 按家族保留最新 N 份，定时备份会挤掉用户的手动备份；
- 每份定时备份都带全部工作树。

SQLite 与托管两条路径符合契约。`rfc349-backup-scheduler-provider` 只断言定时器把 `{ kind: 'scheduled', appHome }` 交给注入的函数，而注入的函数
把它丢弃了，缺陷因此一直没有暴露。

**执行可用性带单机回落。** `platform/http/executionAvailability.ts` 的 `readExecutionStatus` 在 app 未绑定读取器时回落
`{ mode: 'standalone', state: 'active', reason: null }`，这是 RFC-376 部署分支盘点余下的 2 处之一。生产 app 总在 `mountApiRoutes` 里先绑定读取器
（RFC-392 起执行权必填）；未绑定的只有测试与工具根。

## 2. 目标

- **G1 定时备份只有一个来源**：系统运维模块用部署选定的备份协调端口完成定时备份（托管为平台备份，单机为本地 provider 备份），对会话暴露
  一个定时备份参与者。会话的定时备份作业只调用它。provider 适配表删去 `scheduledBackup`，托管 / 单机分支随之消失。
- **G2 单机 PostgreSQL 定时备份符合契约**（缺陷修复）：产物为 `scheduled-*`、不含工作树、受保留规则轮转。两个本地备份协调器都把请求里的
  `kind` 交给备份实现。
- **G3 定时器只做节拍**：`startBackupScheduler` 只接受一个无参的定时备份函数，删去它自带的 SQLite 客户端分支。
- **G4 执行可用性无部署回落**：未绑定读取器的 app 不做执行门控（与现行为一致）；状态查询要求已绑定。RFC-376 部署分支 2 → 1。
- **G5 其余不变**：SQLite 与托管的定时备份产物、手动备份、各路径备份前是否执行准备步骤、已绑定 app 的门控与状态查询。

## 3. 非目标

- 各备份路径前的准备步骤：本 RFC 不改变哪条路径执行准备。
- 已落盘的 `agent-workflow-*` 旧定时备份的改名或迁移：它们仍按手动家族处理。
- CrewStation 事件收件箱端口上的通道字面量（RFC-376 余下的 1 处）。
- S2c 余项第 1 项（单机默认值集中、选择项改必填）与第 3 项（入口根瘦身）。
- 安全相关改动。

## 4. 用户可见变化

只影响**单机 PostgreSQL 且开启定时备份**（`backupIntervalMs > 0`）的部署：

- 新的定时备份文件名为 `scheduled-<时间戳>.tar.gz`，不再包含工作树；
- 按 `backupRetentionCount` / `backupRetentionDays` / `backupMaxTotalBytes` 轮转，不再占用手动备份家族的保留名额；
- 已有的 `agent-workflow-*` 文件不动。

SQLite、托管部署与所有手动备份没有变化。

## 5. 验收标准

- **AC-1**：provider 适配表没有 `scheduledBackup`；会话的定时备份作业调用 `core.systemOperations.scheduledBackup`；定时器没有 SQLite 客户端
  分支（结构锁锁定，含负例）。
- **AC-2**：
  - 系统运维模块的定时备份向它的备份协调端口请求 `{ includeWorktrees: false, kind: 'scheduled' }`，托管与单机 PostgreSQL 都由用例覆盖；
  - 本地 PostgreSQL 与 SQLite 协调器把 `kind` 交给备份实现；
  - PostgreSQL 备份在 scheduled 种类下产出 `scheduled-*`、不含工作树；
  - SQLite 模块的定时备份产出 `scheduled-*`、不含工作树，且不执行准备步骤（与现行为一致）。
- **AC-3**：
  - 未绑定读取器的 app 不门控、状态查询报未绑定；
  - 绑定后的门控与状态查询不变；
  - RFC-376 `deployment-mode-branch-sites` 2 → 1，基线与计数同步。
- **AC-4**：既有备份 / 定时器 / 执行可用性 / 中立应用图用例与 P0 变异 lane 全部通过。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **定时备份落在系统运维模块，而不是新增 profile 选择项**：托管的备份选择已经作为模块的备份协调端口注入
   （`composePostgresqlSystemOperations` 的 `backup`）。模块是唯一知道「本部署的备份走哪里」的地方，再加一个选择项会让同一个选择出现两次。
2. **按文档契约修复**：三条路径里只有单机 PostgreSQL 带工作树、落成手动家族，而文档写明定时备份为 scheduled 种类、不含 worktrees。
3. **SQLite 定时备份仍在进程内直接做快照**：保持现行为，不改变它是否执行准备步骤；SQLite 的这条实现从定时器移到 SQLite 的恢复适配器里。
4. **执行可用性与备份来源同一个 RFC**：两者同属 S2c 第 2 项余项，改动面都小且互不重叠。
