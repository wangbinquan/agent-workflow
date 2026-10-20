# RFC-381 实施计划

**前置**：RFC-380 已提交。派发 Codex 实施、本会话审核；单批次交付，先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-381-T1 | `scheduledTasks.ts`：统一定时任务运行时与校验；P 删除内联校验 | design §1.2、§2.3 |
| RFC-381-T2 | `integration.ts`：集成组；MR 终止统一清理函数（不抛）与本 provider 运行注册表；事件中心一份写法 | design §1.1、§2.2、§2.4 |
| RFC-381-T3 | `fusion.ts`：融合组与实时启动来源 | design §1.3、§2.1 |
| RFC-381-T4 | 两个根改用三组；V 注入与回退；删除无人使用 / 不可达实例与失去调用方的 SQLite 专属清理函数 | design §3、§4 |
| RFC-381-T5 | 架构账本与旧锁（`BOOTSTRAP_FILES`、R1、导入账本、guard-manifest） | design §3、§5 |
| RFC-381-T6 | 测试（design §5 第 1～5 项） | design §5 |
| RFC-381-T7 | 文档：`docs/dev-gotchas.md` 一条（MR 终止清理不抛、源终止用本 provider 注册表、融合启动设置实时读取） | — |

依赖：T1 → T2；T3 独立；T4 依赖 T1～T3；T5、T6 贯穿。

## 冲突面

入口根（`cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`server.ts`）与 `cli/daemonModules/`：与 RFC-380、RFC-382、RFC-383 串行。

## 验收清单

- [x] proposal AC-1～AC-4（结构锁、注入实例同一性、四处行为统一的双引擎用例、旧锁与账本）
- [ ] 推送后 exact SHA CI 全绿（含 PostgreSQL 分片）：`682018fd4` 主 CI `39497282103` 的后端全部分片（含 PostgreSQL）与
  ubuntu / windows e2e 绿；红在依赖审计门（外部新公告，非本 RFC）与 macOS e2e 既有的守护进程就绪超时偶发
  （2026-10-19 `f777b875a` 起即有）。待后继全绿 CI 补证
