# RFC-382 实施计划

**前置**：RFC-381 已提交。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-382-T1 | 修改 `TE/composition/providerRuntime.ts`：SQLite 补出 `routeLaunch.workflow` 与 `workgroupTaskRoom`；两边接收实时运行配置；PostgreSQL 删除重复的生命周期端口 | design §1.2、§2.1、§2.5 |
| RFC-382-T2 | 新增 `adapters.ts` 的任务执行适配器表与 `cli/daemonModules/taskExecution.ts`：会话协调器、`runConfiguration()`、门控续跑前置步骤、引擎异常上报、活跃任务、任务目录来源、资源绑定 | design §2.1～§2.4、§3 |
| RFC-382-T3 | 动态工作流校验上下文改为中立名称，两个 provider 共用；删除 P 的系统身份实现 | design §2.6 |
| RFC-382-T4 | 两个根改用模块组：删除 C1、C2、C6 与两份运行配置；宿主动作环境改用根工作流内核；S 的 PostgreSQL 会话改读会话模块；S 改用 provider 投影器 | design §2.4、§2.5、§2.7 |
| RFC-382-T5 | V 注入与回退：删除 §1.3 的生产重复构造与 `taskExecutionLaunches`；HTTP 侧数字员工改用注入内核 | design §1.3、§4 |
| RFC-382-T6 | 架构账本与旧锁：`BOOTSTRAP_FILES`、R1、guard-manifest、结构守卫、composition 再导出 | design §3、§5 |
| RFC-382-T7 | 测试（design §5 第 1～6 项） | design §5 |
| RFC-382-T8 | 文档：`docs/dev-gotchas.md` 一条：会话协调器与运行配置只在模块组；续跑必须经 `runtimeConfigOpts` 投影；引擎异常经失败上报 | — |

**依赖**：T1 → T2 → T4 → T5；T3 独立；T6、T7 贯穿。

## 冲突面

入口根（`cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`server.ts`）与 `cli/daemonModules/`：与 RFC-381、RFC-383～386 串行。

## 验收清单

- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片）
