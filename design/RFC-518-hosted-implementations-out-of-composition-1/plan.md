# RFC-518 实施计划

依赖：RFC-517。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-518-T1 原样迁移**：23 个文件迁入各模块的 `infrastructure/crewstation/`，按新位置重算相对 import（design D1）；由脚本按 HEAD 原文生
  成。
- **RFC-518-T2 消费方**：模块根转出 bootstrap 用到的名字；bootstrap 的 20 条 import 改经模块根；模块内 import 改指新位置（design D2）。
- **RFC-518-T3 锁与计数**：RFC-515 门的例外清单删 23 条；`rfc376-structural-guards` 与 `rfc294-review-offered-edge-dag` 改钉新路
  径、forbidden-import 清单清空；`counts.json` 收紧；18 个 import 旧路径的用例与两个读原文的用例改指新路径；guard-manifest 登记新用例
  （design D3）。
- **RFC-518-T4 用例**：新增 RFC-518 用例（design §4）。
- **RFC-518-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按旧路径与名字扫出的用例与全部 `tests/architecture/`，按
  CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-518-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 23 个文件只在新位置；组合层只剩 4 个托管文件；门的例外清单只剩它们且仍绿；forbidden-import 实测 0
- [ ] AC-2 迁移的代码逐字不变，导出与消费方拿到的对象不变
- [ ] AC-3 新位置不取组合层（两处 required-ports 类型除外）；bootstrap 不深引用 infrastructure；账本只改名不增；计数收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-518 托管实现迁出组合层（一）（RFC-294 S10 第二十五步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
