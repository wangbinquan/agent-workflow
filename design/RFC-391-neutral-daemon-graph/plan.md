# RFC-391 实施计划

**前置**：RFC-390 已提交且主 CI 转绿。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-391-T1 | `bootstrap/daemonApplication.ts`：`composeDaemonApplication(input, phase)`（12 组、会话级操作、HTTP、WS、33 步启动步骤、「核心组之后」钩子、unstarted 相位与测试接缝） | design §2.1 |
| RFC-391-T2 | `bootstrap/daemonSession.ts`：适配表 + `composeDaemonSession(input)`（开库、迁移模块、维护服务、作业、已提交事件、关闭参与者、唯一一次程序、运行时会话） | design §2.2、§2.3 |
| RFC-391-T3 | `startCommand` 改为注入会话组合函数；`main.ts` 传入；`cli/dev.ts` 去掉 `startCommand` 默认值；删除两个会话函数与查表 | design §2.4、§2.5 |
| RFC-391-T4 | 删除 `cli/postgresqlDaemonApplication.ts`；`T/helpers/providerHttpApplication.ts` 的 PostgreSQL lane 改调应用图 | design §2.5 |
| RFC-391-T5 | 守卫、账本与 CI 路径过滤（design §4）；删除 RFC-389 的入口常量特判；新增结构锁并登记 guard-manifest | design §4、§5 |
| RFC-391-T6 | 钉子测试改写（design §4 测试改指）；新增行为用例（design §5 第 2 项） | design §5 |
| RFC-391-T7 | 文档：`docs/dev-gotchas.md`、`docs/audit-backlog.md` | design §5 |

**依赖**：T1 → T2 → T3、T4；T5、T6、T7 贯穿。

## 冲突面

几乎整个守护进程装配层，与 RFC-392、S2c 串行：

- `cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`cli/dev.ts`、`main.ts`、`server.ts`、`cli/daemonModules/*`；
- `architecture/*.json`、`T/architecture/*`；
- RFC-370 根绑定测试族、`T/helpers/providerHttpApplication.ts`。

## 验收清单

- [ ] proposal AC-1～AC-4
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片、windows-platform、维护浸泡）
