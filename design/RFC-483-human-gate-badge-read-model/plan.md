# RFC-483 实施计划

**前置**：RFC-485（Done，`9699ad3fd`，Done 文档 `1fa9be87c`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后
集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-483-T1 | task-execution 的 composition 转出三个片段，`public/queries` 撤出                                                                                                   | design §2 |
| RFC-483-T2 | `TaskExecutionParticipantBindings` 增三个成员与 `HumanGateBadgeTaskScope` 切片；bootstrap 的绑定与用例 helper 补上                                                  | design §2 |
| RFC-483-T3 | application：徽标读模型端口（DTO）与查看者判定、两个徽标用例                                                                                                        | design §2 |
| RFC-483-T4 | 徽标读模型：两个计数函数改收 `(db, taskScope, viewer)`，谓词改从绑定取；路由操作组出读模型、经 application 用例计数                                                 | design §2 |
| RFC-483-T5 | 账本销账、`counts.json` 收紧、guard-manifest 登记                                                                                                                   | design §3 |
| RFC-483-T6 | 新增 RFC-483 用例；调用两个计数函数的用例改传绑定与查看者；`rfc395-a7-owner-queries` 改取 composition；字面量扫描找出的文本断言随改动改写                           | design §4 |
| RFC-483-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §5 |

## 验收清单

- [ ] AC-1 task-execution 的 public 不导出三个片段；collaboration 不从 task-execution 取它们；徽标读模型经绑定取得
- [ ] AC-2 查看者判定在 application，读模型端口只有 DTO 签名；路由操作经 application 的徽标用例计数
- [ ] AC-3 `public-surface-deviations` 65 → 57 并收紧到实测；跨 context 内部文件对、越 DAG 文件对与表归属账本不变
- [ ] AC-4 两条徽标仍各发一条语句、`rfc311` 对拍通过；受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-483 评审与澄清徽标的联合投影归 collaboration 读模型、task-execution 的三个 SQL 条件片段撤出 public（RFC-294 S9 第五步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
