# RFC-513 实施计划

依赖：RFC-512；与 S12 共用模块 composition 文件（本 RFC 只改 code-capability 与 resource-catalog 各一个组合文件；装配入口不变）。按 CLAUDE.md 文首
硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-513-T1 归 application**：新增 `code-capability/application/unboundHistoryReader.ts`，`resource-catalog/application/resourcePackageMaintenance.ts`
  增 `requireExclusiveRecoverySelection`（design D1）。
- **RFC-513-T2 composition 只装配**：两个装配入口改为取新位置（design D2）。
- **RFC-513-T3 账本**：`counts.json` 两项收紧；guard-manifest 登记（`assertsAbsence: true`）（design D3）。
- **RFC-513-T4 用例**：新增 RFC-513 用例（design §4）。
- **RFC-513-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend 分片。
- **RFC-513-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的位置声明；两个组合文件不再有这 3 个 `throw`；装配入口的名字、入参与返回形状不变
- [ ] AC-2 同样输入下读取器与核对的行为、错误与时机和此前一致
- [ ] AC-3 新位置的依赖面是闭集；public surface 不升；两项计数收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-513 代码能力与资源目录组合层余下的 throw 迁出 composition（RFC-294 S10 第二十步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
