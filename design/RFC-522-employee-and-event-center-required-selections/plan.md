# RFC-522 实施计划

依赖：RFC-521。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-522-T1 数字员工**：三项选项必填，删去回落与 `writerInstallation` 选项（design D1）。
- **RFC-522-T2 事件中心**：两项选项必填，删去 `selectLocalCustomObserverProgramFactory`，兼容入口改调 application（design D2）。
- **RFC-522-T3 用例**：两个测试助手与全部受影响的用例调用（design D3）。
- **RFC-522-T4 门与锁**：RFC-521 门的登记、总数与后继标签（design D4）；新增 RFC-522 用例并登记 guard-manifest（design §4）。
- **RFC-522-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字与原文扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-522-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 5 处回落不再存在，选项必填，门的实测与登记相等、适配器回落 78 条
- [ ] AC-2 daemon 得到的对象不变，用例显式给出的选择与此前缺省相同
- [ ] AC-3 event-center 的 infrastructure 不取组合层；public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-522 数字员工与事件中心的适配器回落改为必填注入（RFC-294 S12 第三步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
