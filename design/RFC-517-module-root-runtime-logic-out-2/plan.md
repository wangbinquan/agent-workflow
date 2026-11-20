# RFC-517 实施计划

依赖：RFC-516。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-517-T1 归位**：新增 digital-employee 的 `application/platformInventoryParticipant.ts` 与
  `application/employeeDefinitionView.ts`，system-operations 的
  `infrastructure/local/fileDatabaseProviderBoot.ts`、`application/postgresqlSchemaPlanAdmission.ts` 与
  `application/stageRestoreArtifactRelease.ts`，task-execution 的 `infrastructure/taskExecutionModule.ts`（design D1）。
- **RFC-517-T2 模块根只装配**：三个模块根 `composition.ts` 改为取新位置并照旧导出；`childTaskLifecycleParticipant.ts` 的类型 import 改指新位
  置（design D2）。
- **RFC-517-T3 门与账本**：RFC-515 门的例外清单删 3 条；`rfc328-architecture-guards` 与 `rfc305-architecture-lock` 改钉新位
  置；guard-manifest 登记新用例（design D3）。
- **RFC-517-T4 用例**：新增 RFC-517 用例（design §4）。
- **RFC-517-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部
  `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-517-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的位置声明；三个模块根不再有循环、`try` 与 `throw`；门的例外清单删去它们后仍绿（只剩 RFC-370 的 27 个）
- [ ] AC-2 清单参与者、员工视图、启动准备、schema 计划核对、暂存还原后的释放、任务执行模块与关停控制器的行为、错误与次序和此前一致
- [ ] AC-3 新文件的依赖面是闭集并服从层次；public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-517 模块根装配文件的运行期逻辑迁出（二）（RFC-294 S10 第二十四步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
