# RFC-383 实施计划

**前置**：RFC-382 已提交（`fddf8bf74`）。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-383-T1 | provider 核心新增 `daemonActor()`；任务执行组输出 `hostTasks`（启动内核、守护身份、资源授权、会话取消、读模型、Agent 与工作流目录 `get`）；观测组改用 `daemonActor()` | design §2.6、§2.7 |
| RFC-383-T2 | development-automation 应用层新增写者切换门控函数（唤醒、恢复）；`composeDigitalEmployee` 接收会话的写者切换，删除每请求现建 | design §2.2～§2.4 |
| RFC-383-T3 | 新增 `cli/daemonModules/digitalEmployee.ts`（含迁入的路由持久化）与 `cli/daemonModules/developmentAutomation.ts` | design §2.1、§2.5、§2.8、§2.9、§3 |
| RFC-383-T4 | S 与 P 改用两个模块组：删除各自的数字员工、反应执行、工作区、平台工作项、输入存储、写者切换、宿主环境与开发自动化构造，删除 P 的 `let systemActor`、重复端口对象与 `runtime.employeeWriterCutover`、S 的 `let employeeWriterState`；两个会话的 `development-wake`、`employee-writer-state`、`legacy-mission-recovery` 用同一实现；DLP 去掉 `legacy-mission-recovery` 的 provider 限制；PostgreSQL 会话传入漂移策略 | design §1.3、§2.3～§2.6、§3.3 |
| RFC-383-T5 | V 注入与回退：`AppDeps` 增加两个模块组，V 只在 `??` 回退中调用构造函数；删除 `composeFallbackDevelopmentAutomation`、V 自建的成员与 `effectiveDeps.developmentAutomation` | design §4 |
| RFC-383-T6 | 架构账本与旧锁：`BOOTSTRAP_FILES`、R1、guard-manifest、RFC-310 OS 架构清单、`COMPOSITION_CONSUMERS`、结构守卫 | design §5.2～§5.4 |
| RFC-383-T7 | 测试（design §5.1 第 1～9 项） | design §5.1 |
| RFC-383-T8 | 文档：`docs/dev-gotchas.md` 一条：数字员工与开发自动化只在模块组构造，SQLite 只有一个数字员工实例；写者切换门控两边一致 | — |

**依赖**：T1、T2 → T3 → T4 → T5；T6、T7 贯穿。

## 冲突面

入口根（`cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`server.ts`）、`cli/daemonModules/` 与 `cli/daemonLifecycleProgram.ts`：
与 RFC-384～386 串行。

## 验收清单

- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片）
