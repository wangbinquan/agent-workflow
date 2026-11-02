# RFC-426 实施计划

**前置**：RFC-425 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                          | 依据          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-426-T1 | 定时备份请求常量、模块与恢复适配器的 `scheduledBackup`、PostgreSQL / SQLite 两处实现、两个本地协调器透传 `kind`               | design §1     |
| RFC-426-T2 | 会话的定时备份作业改取模块参与者；适配表删 `scheduledBackup`；定时器只接受无参函数、删 SQLite 分支                            | design §2     |
| RFC-426-T3 | 执行可用性：未绑定不门控、状态查询要求绑定                                                                                    | design §3     |
| RFC-426-T4 | 结构锁 `rfc426-scheduled-backup-source`（含负例）、RFC-376 基线与计数、RFC-391 字段清单、用例与夹具、guard-manifest、灾备文档 | design §4、§5 |
| RFC-426-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                             | —             |

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）在实现完成后与两轮修正后均 0 错误。第一次静态检查列出两处待改：定时器的 promise 链类型、
  RFC-359 W8 恢复一致性用例的 PostgreSQL 适配器夹具缺 `scheduledBackup`。改动的 TS 文件 eslint `--max-warnings 0` 与 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：
  - SQLite 定时备份与改动前同一份快照：同一个库、同一个契约、同一个 app home，不含工作树，不执行准备步骤；
  - 托管定时备份与改动前同一次请求；
  - 单机 PostgreSQL 改为 `{ includeWorktrees: false, kind: 'scheduled' }`，仍经本地协调器（准备步骤照旧执行）；
  - 已绑定 app 的门控与状态查询不变；生产只在 `mountApiRoutes` 里先绑定读取器、再挂守护进程路由，状态路由不会遇到未绑定的 app。
  - PASS。
- **针对性验证集**（6 worker）：391 个文件，384 个通过。范围是全部 135 个架构测试，加上按关键词选出的、读写定时备份 / 备份协调端口 / 执行
  可用性 / provider 适配表的用例与读源码文本 / 账本的守卫。各改动文件都会经 bootstrap 牵到全量，反向导入闭包等于整套，所以不用它。7 个失败：
  - 三个是 RFC-359 账本守卫，由新用例引起：
    - 新文件手搓了一个 PostgreSQL 运行时（W5 高水位账本）；
    - 提到 `PostgresqlSchemaPlan`，让 schema Plan 对的 PostgreSQL 侧引用数 33 → 34（W5-T19d 倒挂加深）；
    - 成为备份协调端口对的新「验证者」（W8 能力对账本）。

    处置：PostgreSQL 一侧的用例放回 `rfc349-postgresql-system-operations-composition` 与 `rfc349-postgresql-admin-backup`，复用两文件已有的
    运行时夹具；新文件只留 SQLite 两例。三本账本都不用改，复跑通过。

  - 三个是 PostgreSQL 一侧的负载超时（`rfc359-w5-composition-root-route-surface`、`auth-routes`、`rfc395-t19-migration-prep`）。
  - 一个是 `rfc368-implementation-gate` 的「崩溃重放命中已终止案例」[postgresql]：`port.canceled` 为空。用例用固定的 `Bun.sleep(50)` 等
    崩溃的派发持久化执行身份，负载下等不到，重放便没有可取消的执行。同文件上一例已为同一原因改成等真实的 launch 边界（注释写明「A fixed
    50ms can observe planned with executionRef still null on CI」）。本例按同法修正：既有的时序缺陷，与本 RFC 无关，按「flaky 不能靠重跑」
    就地修；修正后并发三次各 15/15。

- **第二轮**（4 worker）：全部 135 个架构测试、改动的用例与第一轮的非账本失败，共 150 个，全部通过。
- **按已提交源码生成报告的用例**：在「HEAD 加本候选」的独立导出仓库里通过：
  - `rfc376-report` 16/16、`rfc370-committed-architecture-source` 2/2；
  - 本 RFC 的锁、RFC-376 结构门、RFC-391 中立应用图；
  - RFC-317 负例 / 语料下限 / 架构账本 / 模块边界；
  - RFC-359 的三本账本守卫。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-5）

- **`14fd0c903`**：主 CI `41432823539` 70 个 job 全部 success，windows-platform `41432823547` 与按路径触发的
  maintenance-soak-nightly `41432823580` success。AC-5 成立，RFC-426 Done；同一运行作为 RFC-425 的后继证据。

## 冲突面

- **生产**：
  - system-operations：`SO/{domain/backup,composition}.ts`、`SO/infrastructure/{postgresqlAdminBackupCoordinator,legacyPlatformRecoveryAdapter}.ts`；
  - `S/bootstrap/{daemonSession,daemonSessionAdapters}.ts`；
  - `S/platform/background/providerBackupScheduler.ts`、`S/platform/http/executionAvailability.ts`。
- **守卫与账本**：见 design §4。
- **文档**：`docs/disaster-recovery.md`。
- **附带**：`rfc368-implementation-gate` 一例的时序修正（见上）。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，`14fd0c903`，见上）
