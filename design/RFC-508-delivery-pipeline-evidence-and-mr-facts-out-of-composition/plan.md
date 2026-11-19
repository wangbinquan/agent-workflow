# RFC-508 实施计划

依赖：RFC-507（Done）；与 S12 共用模块 composition 文件（本 RFC 只改 development-automation 的 `composition/pipelineEvidence.ts` 与
`composition/developmentDelivery.ts`；装配入口不变）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与
格式的静态自查。

## 任务

- **RFC-508-T1 端口**：`application/ports/reconcilerPorts.ts` 增 `SelectedPipelineEvidenceRunnerPort`（design D2）。
- **RFC-508-T2 实现归 application**：流水线证据端口的选定实现迁入 `application/selectedPipelineEvidence.ts`，MR 事实的读取与采集迁入
  `application/developmentMrFacts.ts`（design D3）。
- **RFC-508-T3 composition 只装配**：四个装配入口改为从新位置取实现，采集的时钟由装配传入，删去不再用的 import（design D4）。
- **RFC-508-T4 账本**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`；design D5）。
- **RFC-508-T5 用例**：新增 RFC-508 用例（design §4）。
- **RFC-508-T6 集中验证**：backend `tsc`、eslint；RFC-508 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-508-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的位置声明；两个组合文件没有控制流、从新位置取实现；四个装配入口与交出的对象不变
- [ ] AC-2 同样输入下流水线证据端口、MR 事实读取与采集的结果、错误与端口调用和此前一致
- [ ] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-development-automation` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-507 转 Done 提交 `155d8c0fc` 的 CI 当时仍排队，
结果补记于实现提交）；实现与验证后再提交
`refactor(backend): RFC-508 开发自动化的流水线证据端口与 MR 事实采集迁出 composition（RFC-294 S10 第十五步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
