# RFC-428 实施计划

**前置**：RFC-427 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                              | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------- | --------- |
| RFC-428-T1 | 选择项类型与键表删四项                                                                            | design §1 |
| RFC-428-T2 | 启动锁只装本地锁、删预打开恢复选择分支、本地任务根改用模块默认、托管执行选择删被遮蔽属性          | design §2 |
| RFC-428-T3 | 结构锁 `rfc428-retired-deployment-selections`（含负例）、guard-manifest                           | design §3 |
| RFC-428-T4 | 用例：启动锁协议改测应用层、启动根与启动序列、端口制品 / 节点提示、部署 profile 与测试 helper     | design §4 |
| RFC-428-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI | —         |

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）0 错误；改动的 TS 文件 eslint `--max-warnings 0` 与 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：删去的四处读取在两种部署下要么恒为缺省（启动锁、预打开恢复、节点提示），要么被 `taskRunSelection` 遮蔽
  （托管的端口制品），运行时取值与改动前相同。PASS。
- **针对性验证集**（6 worker）：437 个文件，434 个通过。范围是全部架构测试，加上按关键词选出的、读写部署选择 / 启动锁 / 预打开恢复 / 节点提示 /
  端口制品 / 任务根选择的用例与 HTTP 测试入口的使用方。3 个失败：
  - `rfc394-deployment-profile` 的键表数量断言 72 → 68，已改；
  - 另两个是 PostgreSQL 一侧的负载超时（`admin-only-gate`、`rfc359-w5-composition-root-route-surface`）。
- **第二轮**（4 worker）：全部架构测试、改动的用例与第一轮的失败，共 145 个，144 个通过；余下的 `admin-only-gate` 一例 PostgreSQL 钩子超时。
- **第三轮**（单进程，本候选与基线 HEAD `c96f2c907` 的导出对照）：`admin-only-gate` 两侧 44/44（27 s / 26 s），负载超时不归本 RFC。
- **按已提交源码生成报告的用例**：在「HEAD 加本候选」的独立导出仓库里通过：
  - `rfc376-report` 16/16、`rfc370-committed-architecture-source` 2/2；
  - 本 RFC 的锁、RFC-394 架构锁、RFC-317 负例 / 语料下限 / 架构账本、RFC-376 结构门。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- **生产**：
  - `S/bootstrap/{deploymentProfile,deploymentSelections,daemonStart,daemonApplication}.ts`；
  - `S/modules/system-operations/composition.ts`；
  - `S/modules/task-execution/composition/crewstationExecution.ts`。
- **测试**：design §4 所列。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-3（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-4）
