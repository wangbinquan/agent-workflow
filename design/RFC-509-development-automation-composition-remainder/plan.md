# RFC-509 实施计划

依赖：RFC-508；与 S12 共用模块 composition 文件（本 RFC 只改 development-automation `composition/` 下的 6 个文件；装配入口不变）。按 CLAUDE.md
文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-509-T1 实现归 application**：图交付生命周期与作业模板迁入 `application/graph-development/`，案例详情投影与执行终态唤醒各成新文件，活动
  周期与选定内容核对并入既有的 `application/activityOperations.ts` 与 `application/evidenceStaging.ts`（design D3）。
- **RFC-509-T2 composition 只装配**：6 个组合文件改为从新位置取实现，转出原有的名字，登记对象、id 与时钟由装配传入，删去不再用的 import
  （design D4）。
- **RFC-509-T3 账本与清单**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`）；RFC-310 的 OS 架构清单改三增一删（design D5）。
- **RFC-509-T4 用例**：新增 RFC-509 用例（design §4）。
- **RFC-509-T5 集中验证**：backend `tsc`、eslint、prettier；按静态 import 闭包取到改动文件的用例、全部 `tests/architecture/` 与按名字、路径和
  错误串扫出的用例，按 CI 的跑法与 HEAD 同时 A/B；撞时限或等待到点的红用放宽时限的副本两边复核；报告类用例的放宽副本；架构报告对照；全仓
  旧位置扫描。全量语料交给 CI 的 backend 分片（RFC-508 的教训：本机高负载下全量 SQLite 要数小时）。
- **RFC-509-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的位置声明；6 个组合文件只留装配入口、转出与装配期选择；装配入口与转出的名字不变
- [ ] AC-2 同样输入下各实现的结果、错误与端口调用和此前一致
- [ ] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-development-automation` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-508 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-509 开发自动化组合层的非 RFC-370 余项迁出 composition（RFC-294 S10 第十六步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
