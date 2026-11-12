# RFC-488 实施计划

**前置**：RFC-487（Done，`76fcd805a`，Done 文档 `15f7a86d4`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。
全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                  | 依据      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-488-T1 | resource-catalog：新增端口 `LocalMcpDiagnosticExecution`（`application/ports`，经 `required-ports` 转出）；本机执行体收 `execution`、删 `runFn` 与一族 import，运行时相关的工作调端口，启动校验移出   | design §2 |
| RFC-488-T2 | task-execution：本机实现 `infrastructure/local/mcpDiagnosticRunner.ts`（驱动知识、启动上下文与包裹、假运行、启动校验）与 `composition/localMcpDiagnosticRunner.ts`                                    | design §2 |
| RFC-488-T3 | bootstrap：观测模块建本机实现并交给诊断装配，给了夹具时选本机装配；测试接缝的类型改取 task-execution 的夹具类型；CrewStation 的诊断装配删去按夹具的分支                                               | design §2 |
| RFC-488-T4 | 登记：RFC-294 design §3.1 的虚线与 `rfc294Target.ts` 的 `REQUIRED_CONTEXT_EDGES`                                                                                                                      | design §2 |
| RFC-488-T5 | 新增 RFC-488 用例并登记 guard-manifest；RFC-487 用例 ① 的例外清单改为空；既有用例按新装配改指；`counts.json` 收紧                                                                                     | design §4 |
| RFC-488-T6 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、按 CI 跑法的批次、架构报告对账、全仓旧路径扫描）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §5 |

## 验收清单

- [ ] AC-1 resource-catalog 的生产文件不 import 运行时驱动一族；RFC-487 用例的例外清单为空；本机执行体不含驱动、启动上下文、假运行与
      启动校验的逻辑
- [ ] AC-2 本机 MCP 诊断在同样输入下与此前一致（启动上下文、包裹、假运行、观测与续会话、启动校验、四种运行时错误）
- [ ] AC-3 越 DAG 的值边与 offered 文件对不升；public surface 不增；consumer 自有端口只增 1；减速带不升、触及的收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

（实施后补。）

## 实现门（本会话自审，只审功能）

（实施后补。）

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同时记 RFC-487 Done 文档提交的 CI）；实现与验证后再提交
`refactor(backend): RFC-488 resource-catalog 本机 MCP 诊断的运行时工作改经自有端口（RFC-294 §4.7 运行时驱动一族第二步）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。按 CI 的跑法（两种 provider 同进程、默认 5 秒）跑一遍受影响
用例（RFC-487 教训）；删除或搬迁文件后按 `git ls-files` 扫全仓的旧路径。
