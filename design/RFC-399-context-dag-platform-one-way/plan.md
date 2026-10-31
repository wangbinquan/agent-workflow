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
