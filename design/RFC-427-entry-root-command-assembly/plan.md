# RFC-427 实施计划

**前置**：RFC-426 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                   | 依据          |
| ---------- | ------------------------------------------------------------------------------------------------------ | ------------- |
| RFC-427-T1 | `Deployment` 类型、`selectDeployment` 与两种部署描述、统一的不支持错误；删除四个旧入口                 | design §1     |
| RFC-427-T2 | `bootstrap/commandBootstraps.ts`、`managedProcessOutputProbe.ts`、`hostedGitCommands.ts`：逐字迁入装配 | design §2     |
| RFC-427-T3 | `main.ts` 只剩解析、选择与分发                                                                         | design §3     |
| RFC-427-T4 | 结构锁 `rfc427-entry-root`（含负例）、RFC-394 / RFC-349 锁、用例与调用方、guard-manifest               | design §4、§5 |
| RFC-427-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI      | —             |

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）两次均 0 错误；改动的 TS 文件 eslint `--max-warnings 0` 与 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：
  - 各子命令的输出、退出码与加载集合与改动前相同：`main.ts` 原先静态 import 的模块，现在经 `bootstrap/commandBootstraps.ts` 同样静态加载；
  - 两个托管 Git 凭据子命令仍按需加载；
  - 非法部署模式仍在 `main` 的 catch 里打印同一条报文并以 1 退出；
  - 两处拒绝的报文逐字不变；
  - 迁移、校验、备份、还原、诊断、数据库命令的装配与原分支逐字相同（`satisfies` 改由 `main.ts` 调用处的结构检查承担）。
  - PASS。
- **针对性验证集**（6 worker）：295 个文件，285 个通过。范围是全部 135 个架构测试，加上按关键词选出的读入口根 / 部署选择 / CLI 子命令的
  用例与 CLI 进程用例。10 个失败：
  - 8 个是钉住 `main.ts` 装配文本的锁与账本：RFC-317 R1 的组合根登记、RFC-305 / RFC-347、RFC-271 / RFC-346 / RFC-349 / RFC-370 / RFC-223
    的源码断言。改指新位置；RFC-223 那条原断言一直空过，一并改为真实校验顺序。
  - 2 个是 PostgreSQL 一侧的负载超时（`rfc359-w5-composition-root-route-surface`、`rfc395-t19-migration-prep`，与 RFC-426 第一轮相同）。
- **第二轮**（4 worker）：全部架构测试、改动的用例与第一轮的失败，共 151 个，全部通过。
- **按已提交源码生成报告的用例**：在「HEAD 加本候选」的独立导出仓库里通过：
  - `rfc376-report` 16/16、`rfc370-committed-architecture-source` 2/2；
  - 本 RFC 的锁；
  - RFC-394 / 393 / 349 / 376 / 317 / 395 V3 / 400 / 359 W5-T19c 守卫。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- **生产**：`S/main.ts`、`S/bootstrap/{deployment,deploymentProfile}.ts`，新增 `S/bootstrap/{commandBootstraps,managedProcessOutputProbe,hostedGitCommands}.ts`。
- **测试**：
  - design §5 所列用例与 `T/architecture/{rfc394-deployment-profile,rfc349-provider-cutover}.test.ts`；
  - `T/architecture/census.ts`（组合根登记）；
  - `T/{rfc305-architecture-lock,rfc347-identity-access-runtime,rfc271-cli,rfc346-system-operations-cli,rfc349-postgresql-resource-package-bootstrap,rfc370-doctor-diagnostic-family,rfc223-pr5-boot-restore-wiring}.test.ts`。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-3（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-4）
