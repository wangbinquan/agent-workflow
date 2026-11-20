# RFC-521 实施计划

依赖：RFC-520。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-521-T1 门**：新增 `tests/architecture/rfc521-composition-adapter-fallbacks.test.ts`（design D1、D2 与 §3 的登记表，§4 的用例）。
- **RFC-521-T2 账本**：guard-manifest 登记新用例（design D4）。
- **RFC-521-T3 集中验证**：backend `tsc`、eslint、prettier；新用例与全部 `tests/architecture/`，按 CI 的跑法；红的按时限放宽复核。不改生产代
  码，架构报告只核对没有变化。全量语料交给 CI 的 backend 分片。
- **RFC-521-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 门覆盖全部模块的组合层，实测与登记表逐条相等，适配器回落 72 条、各模块指定后继
- [ ] AC-2 每种回落写法都有会红的负对照，不构造的回落与组合层以外的文件不判
- [ ] AC-3 生产代码不变；public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`test(architecture): RFC-521 组合层适配器回落的全模块门与清单（RFC-294 S12 第二步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
