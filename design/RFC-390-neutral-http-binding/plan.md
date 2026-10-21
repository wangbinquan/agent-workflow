# RFC-390 实施计划

**前置**：RFC-389 已提交。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-390-T1 | 任务执行模块组交出 `processConcurrencyScope`；V 内一份热应用助手；删除 V 与 P 的两份热应用 | design §2.1 |
| RFC-390-T2 | V 内一份资源包绑定助手（插件安装器只用 `createResourcePackagePluginInstaller()`）；删除 P 与 V 的两份 | design §2.1 |
| RFC-390-T3 | V 新增 `composeProviderAppComposition`：统一 oidc / 概览 / 访问端口 / 资源目录读法、MCP `probeRunner`、维护遥测；融合路由只收真读字段；删除 `\| null` 死守卫 | design §2.1 |
| RFC-390-T4 | P 改用中立函数，删除 HTTP owner 与 `composePostgresqlAppDeps` | design §2.2 |
| RFC-390-T5 | S 改用中立函数：显式 `appHome`、`databaseTelemetry`，apply 晚读改读中立输出 | design §2.2 |
| RFC-390-T6 | V 的测试路径改为「模块组回退 → 中立函数 → `composeProviderAppDeps`」；删除 `composeSqliteApiRouteMounts` 等与零注入的逐字段覆盖；`databaseMigration` 缺省模块 | design §2.2、§2.3 |
| RFC-390-T7 | 旧锁、账本与结构锁（design §4、§5 第 4 项），`T/rfc257` 改写 | design §2.4、§4 |
| RFC-390-T8 | 行为测试（design §5 第 2、3 项）与文档（`docs/dev-gotchas.md`） | design §5 |

**依赖**：T1、T2 → T3 → T4、T5、T6；T7、T8 贯穿。

## 冲突面

以下文件与 RFC-391、RFC-392 串行：

- `server.ts`
- `cli/start.ts`
- `cli/postgresqlDaemonApplication.ts`
- `cli/daemonModules/{taskExecution,fusion}.ts`
- `architecture/*.json`
- RFC-370 根绑定测试族

## 验收清单

- [ ] proposal AC-1～AC-4
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片与 windows-platform）
