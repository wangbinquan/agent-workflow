# RFC-510 实施计划

依赖：RFC-509；与 S12 共用模块 composition 文件（本 RFC 只改 task-execution `composition/` 下的 7 个文件；装配入口不变）。按 CLAUDE.md 文首硬
规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-510-T1 核对归 application**：7 组核对迁入 task-execution 的 application（4 个既有文件增名字、2 个新文件），3 个运行选择接口挪到
  `application/ports/taskRunSelection.ts`（design D1、D2）。
- **RFC-510-T2 composition 只装配**：7 个组合文件改为从新位置取核对，转出原有的名字（design D3）。
- **RFC-510-T3 账本**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`；design D4）。
- **RFC-510-T4 用例**：新增 RFC-510 用例（design §4）。
- **RFC-510-T5 集中验证**：backend `tsc`、eslint、prettier；按名字、路径与静态 import 闭包取到改动文件的用例与全部 `tests/architecture/`，按 CI 的
  跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend 分片。验证前重建三天以上的导出仓库
  （RFC-509 的教训）。
- **RFC-510-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的位置声明；7 个组合文件不再有这 26 行核对；装配入口与转出的名字不变
- [ ] AC-2 同样输入下每个核对接受与拒绝的输入、错误与时机和此前一致
- [ ] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-task-execution` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-509 转 Done 提交 `0bf3116d2` 的 CI）；实现与验证后再提交
`refactor(backend): RFC-510 任务执行组合层的端口完整性核对迁出 composition（RFC-294 S10 第十七步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
