# RFC-507 实施计划

依赖：RFC-506（Done）；与 S12 共用模块 composition 文件（本 RFC 只改 development-automation 的 `composition/graphDevelopment.ts`；装配入口不变）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-507-T1 用例归 application**：设计执行端口的实现迁入 `application/graph-development/designExecution.ts`，证据、验收与两种档案列表迁入
  `application/graph-development/evidenceAcceptance.ts`（design D2）。
- **RFC-507-T2 composition 只装配**：`composeGraphDevelopment` 改为从新位置取实现，晚建的对象以转发函数交入，删去不再用的 import（design D3）。
- **RFC-507-T3 账本**：`counts.json` 一项收紧；guard-manifest 登记（design D4）。
- **RFC-507-T4 用例**：新增 RFC-507 用例（design §4）。
- **RFC-507-T5 集中验证**：backend `tsc`、eslint；RFC-507 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-507-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的新位置声明；`graphDevelopment.ts` 没有控制流、从新位置取实现；装配入口与交出的对象不变
- [ ] AC-2 同样输入下执行端口、证据、验收、请求验证与档案列表的结果、错误与端口调用和此前一致
- [ ] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-development-automation` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-507 开发自动化的图开发执行端口、证据与验收迁出 composition（RFC-294 S10 第十四步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
