# RFC-515 实施计划

依赖：RFC-514；与 S12 共用模块 composition 文件（本 RFC 只改 resource-catalog 的一个组合文件与一个基础设施文件）。按 CLAUDE.md 文首硬规则：先完成
全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-515-T1 全模块门**：新增 `architecture/rfc515-composition-assembly-only`（design D1），登记 guard-manifest。
- **RFC-515-T2 归位**：`loadSkillOperationState` 迁入 resource-catalog `infrastructure/skillOperationStateQuery.ts`，组合文件引用它（design D2）。
- **RFC-515-T3 旧锁并入**：`rfc414` 与 `rfc423` 删去与新门重复的形状检查，只留归属检查；guard-manifest 行数随改（design D3）。
- **RFC-515-T4 分支上限**：design D4 写明（与 `counts.json` 一致，不改数）。
- **RFC-515-T5 集中验证**：backend `tsc`、eslint、prettier；新门、两条旧锁、`tests/architecture/` 全部与经装配入口对拍 D2 的用例，按 CI 的跑法与 HEAD
  同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-515-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 新门覆盖全部模块的组合层、例外清单与实测逐文件相等、带负对照
- [ ] AC-2 `loadSkillOperationState` 行为不变；组合文件不再取 `queryHelpers`
- [ ] AC-3 两条旧锁只留归属检查、仍通过；public surface 与计数不升；分支上限与 `counts.json` 一致
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交把 RFC-511～514 转 Done，记下它们的 CI）；实现与验证后再提交
`refactor(backend): RFC-515 组合层只装配的全模块门（RFC-294 S10 第二十二步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送
后按 exact SHA 跟 CI。
