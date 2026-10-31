# RFC-399 实施计划

**前置**：无（RFC-395 已 Done）。由 Codex 实施、本会话审核。全部实现与用例完成后集中验证一次；两部分分两次派发，只是为了让
单次实施的范围可控，派发之间不做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-399-T1 | 常量与纯函数换 owner：A4 capture 标记、A2 仓库匹配器、A6 workgroup 宿主节点 ID、A5 Agent 执行契约端口规整（含 shared 常量） | design §2.1 A2/A4/A5/A6 |
| RFC-399-T2 | A9 内置工具目录迁入 DE | design §2.1 A9 |
| RFC-399-T3 | A1 任务角色判据端口与 `TaskMembershipOperationsPort`；COL 工厂与 `taskCollab.ts` 显式接收 policy | design §2.1 A1 |
| RFC-399-T4 | A3 集成触发器快照工厂端口；A10 记忆快照端口 | design §2.1 A3/A10 |
| RFC-399-T5 | A8 五处 TE→COL：续跑前置（含 rollback executor 迁入 COL）、修复端口、澄清指令路由、人工门开门工厂、评审人端口 | design §2.1 A8 |
| RFC-399-T6 | A7 托管 MCP 诊断执行端口与 bootstrap 闭包 | design §2.1 A7 |
| RFC-399-T7 | B3 原生上传迁 TE、B4 磁盘维护迁 SO、B5 `repoRelForcedPaths` 迁 platform | design §2.2 B3/B4/B5 |
| RFC-399-T8 | B1 维护作业处理器归 owner、bootstrap 装配表、platform 中立分派；`maintenanceSystemOperations.ts` 迁 SO | design §2.2 B1 |
| RFC-399-T9 | B2 维护 Worker 效果拆分 | design §2.2 B2 |
| RFC-399-T10 | B6 仓库本地路径查询端口，删除再导出桶 | design §2.2 B6 |
| RFC-399-T11 | DAG 文档与 `rfc294Target.ts` 同步；结构门基线、`counts.json`、例外与 SPI 绑定清单；源码路径字符串；新增 `rfc399-context-dag-platform` 结构锁 | design §2.3、§3 |
| RFC-399-T12 | `docs/dev-gotchas.md` 一条：跨 context 依赖改走 consumer 自有端口时的形状与「不得经 services facade 消门」 | design §2.0 |
| RFC-399-T13 | 集中验证（design §3 验证范围），修复本 RFC 引入的问题后复验相关范围 | design §3 |

**派发**：第一次 T1～T6（Part A），第二次 T7～T10（Part B）；T11、T12 在第二次派发中收尾；T13 由本会话执行。

**依赖**：T1、T2 无依赖；T3～T6 互不依赖；T8 → T9（Worker 运行时接口同改）；T11 在全部实现之后；T13 最后。

## 冲突面

- `bootstrap/crossContextClosure.ts`、`bootstrap/daemonModules/*.ts`、`bootstrap/daemonHttpComposition.ts`、`bootstrap/crewstation.ts`、
  `bootstrap/maintenanceWorker*.ts`；
- `T/architecture/rfc376-structural-guards.test.ts`、`T/architecture/rfc294-review-offered-edge-dag.test.ts`、`T/architecture/rfc294Gates.ts`、
  `T/architecture/rfc294Target.ts`、`architecture/counts.json`；
- RFC-294 `design.md` §3.1。

并发会话 RFC-398 的改动面（`main.ts`、`bootstrap/daemonStart.ts`、`bootstrap/epochMigration*`、`platform/persistence/*`、
`modules/system-operations/**/epochSwitch*`）与本 RFC 不重叠；实施前与提交前按路径核对工作树。

## 验收清单

- [ ] proposal AC-1～AC-4
- [ ] 推送后 exact SHA 的 CI 全绿（AC-5）

## 实施记录（2026-10-31）

**派发**：Part A（T1～T6）、Part B（T7～T11）与一轮账本修复在同一个 Codex 线程内完成（`01a190ea-7282-7f70-aba5-5f8727c3e22f`）；
T12 由本会话写；派发之间本会话审读改动，不做功能验证。改动约 420 个路径：生产约 125 个（含 3 个 shared 文件），其余为测试、
helper、账本与 RFC-294 design §3.1。

**结构门（`d7c5d5462` → 候选）**：

| 门 | 前 | 后 |
| --- | ---: | ---: |
| context 值级 SCC | 2 | 0 |
| 越出 DAG 的值级 context 对 | 9 | 0 |
| `platform` → `modules` 文件对 | 19 | 0 |
| drizzle / schema 再导出桶 | 1 | 0 |
| 跨 context 内部文件对 | 88 | 73 |
| 越出 DAG 的 offered 文件对 | 61 | 54 |
| `export *` 桶 | 23 | 21 |
| legacy 薄 facade / 横向文件 / services 业务实现 | 45 / 391 / 220（上限） | 44 / 390 / 219 |
| 不可达生产文件 | 27 | 27 |
| RFC-317 R1 / R2 精确账本 | 231 / 41 | 229 / 41 |

其余门不变。`architecture/counts.json` 的 9 个上限按实测压低。

**新增 required SPI**（DAG 虚线，按实际类型名）：RC→COL `CollaborationTaskRolePolicy`；COL→TE `TaskMembershipOperationsPort`、
`GateWorkspaceRollbackExecutor`、`TaskClarifyContinuationPort`、`CollaborationRepairPorts`、`TaskClarifyRepairPort`、`TaskReviewRepairPort`、
`TaskClarifyDirectiveRouteOperations`、`TaskReviewersPort`、`HumanGateOpenParticipantFactory`、`HumanGateOpenParticipantScope`、
`HumanGateOpenParticipantInTx`；RC→INTEG `IntegrationTriggerSnapshotFactory`；TE→RC `McpDiagnosticExecution`、
`McpDiagnosticExecutionFactory`；MEM→TE `TaskMemorySnapshotPort`；SC→TE `RepositoryPreparationLookup`。

**偏差**：见 proposal §6 第 13 条。

**经 `services/` 绕行的越界依赖**（不计入门，W9-D 存量）：用新增的 `throughServices` 口径按传递关系量得 18 对 context
（例如 COL→RC 经 `services/resourceAcl`、TE→COL 经 `services/*` facade），是上界估计；本 RFC 只保证不新增此类依赖。

**集中验证**（T13，2026-10-31，本机，候选为未提交工作树）：

- 静态：backend / shared / frontend typecheck、各包 lint（含 `lint:promises`）、depcheck、prettier 通过；shared 测试通过。
- 实现门（Codex 只读，只审功能）：PASS，0 项发现。
- 后端全量（6 分片，`--isolate --randomize`，SQLite + PostgreSQL 两条泳道，`RUN_GIT_NETWORK=1 RUN_CHAOS=1`）：约 3.2 万条用例。
  跑的时候本机负载 24～34（大头是并存的 kind 集群），第 2 分片跑满 6000 秒被 alarm 终止，8 个文件没跑到，已补跑。
  查出两类失败：
  - **本 RFC 引入，已修**（11 个测试文件，都是按搬迁前路径写的源码锚点、精确账本或测试夹具，位于 `tests/architecture/` 之外；
    Codex 只跑了 architecture 目录，没覆盖到）：
    `rfc328-architecture-guards`（删去 4 条已消除的 TE→COL bridge）；
    `rfc294-architecture-preflight` W0-R（删去 15 条已消除的跨 context 内部文件对；`TaskClarifyDirectiveRouteOperations` 的同一条 Actor 债
    换到新声明位置；维护作业处理器与 `MaintenanceSystemOperations` 类型改经 composition 交出，公共面不新增偏差，见 proposal §6 第 13 条）；
    `rfc346-system-operations-contracts`（SO 本地备份清理移出 application，见同条）；RFC-310 `os-architecture-manifest.json`；
    `rfc254-platform-surface-guard`（例外随 `matchRepoProvider` 换文件）；`rfc244`、`rfc098`、`rfc287-t13` 的源码锚点跟到搬迁后的作业体与回滚执行器；
    `rfc284-t20`、`rfc380` 登记 `memorySnapshots`；`rfc359-w55` 夹具绑定 `createHumanGateOpenParticipantScope` 并断言它被传入；
    `tests/helpers/productionTaskLaunch.ts` 在夹具以 `as never` 省略 `humanGateOpen` 时取生产工厂（tsc 看不到这类漏传）；
    修复时把处理器出口移出 public，`rfc261`、`rfc271` 的 import 随之改到新位置。另补一条回归用例：SO `backupPrune` 没有数据库备份实现时，
    经注入的本地清理删除 `<appHome>/backups` 里的旧备份。
  - **PostgreSQL 泳道超时**（31 个文件，5 秒或 15 秒上限，以及超时后的连带错误，如连接已关闭、`beforeEach` 之后才有库）：
    对应的 SQLite 泳道同批用例通过。负载降下来后 4 并发重跑，失败从 31 个文件降到 6 个，且每次失败的子集不同；这 6 个文件单进程串行重跑
    全部通过（130 条），判定为负载所致，不属本 RFC。
- 修复后复验：上述 11 个文件、补跑的 8 个文件与维护作业相关用例全部通过；`tests/architecture/` 整目录（带 PostgreSQL）1209 通过、4 跳过、0 失败；
  backend typecheck 通过；结构门计数与修复前候选一致（见上表）。以推送后 exact SHA 的 CI 为准（AC-5）。
