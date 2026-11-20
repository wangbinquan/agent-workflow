# RFC-516 实施计划

依赖：RFC-515。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-516-T1 归 application**：新增 `event-center/application/unavailableObserverProgram.ts` 与 `identity-access/application/runtimePresenceConnections.ts`；
  `source-control` 的两个 application 文件各增一个名字（design D1）。
- **RFC-516-T2 模块根只装配**：三个模块根 `composition.ts` 改为取新位置（design D2）。
- **RFC-516-T3 门与账本**：RFC-515 门的例外清单删 3 条；guard-manifest 登记新用例（design D3）。
- **RFC-516-T4 用例**：新增 RFC-516 用例（design §4）。
- **RFC-516-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部 `tests/architecture/`，按 CI 的跑法与
  HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-516-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的位置声明；三个模块根不再有循环、`try` 与 `throw`；门的例外清单删去它们后仍绿
- [ ] AC-2 缺省观察者、登记表、收敛与核对的行为、错误与次序和此前一致
- [ ] AC-3 新位置的依赖面是闭集；public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-516 模块根装配文件的运行期逻辑迁出（一）（RFC-294 S10 第二十三步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff /
push。推送后按 exact SHA 跟 CI。
