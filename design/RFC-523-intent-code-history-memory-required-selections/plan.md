# RFC-523 实施计划

依赖：RFC-522。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-523-T1 intent apply**：依赖收窄、工件生命周期的两项必填、单机工件内容选择，`applyIntentChangeset` 移到测试助手（design D1）。
- **RFC-523-T2 daemon 与维护 worker**：daemon 显式构造资源会话绑定与工件生命周期；恢复场景与维护命令的选项必填、单机草稿区选择，worker 显式
  给出（design D2、D3）。
- **RFC-523-T3 code-capability 与 memory**：两项必填（design D4）。
- **RFC-523-T4 用例**：测试助手与全部受影响的用例调用（tsc 列出）。
- **RFC-523-T5 门与锁**：RFC-521 门的登记、总数与后继；钉旧形状的锁；新增 RFC-523 用例并登记 guard-manifest（design D5、§4）。
- **RFC-523-T6 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字与原文扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照（含不可达文件）。全量语料交给 CI 的 backend 分片。
- **RFC-523-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 11 处回落不再存在，选项必填、只为回落存在的选项删去，门的实测与登记相等、适配器回落 67 条
- [ ] AC-2 daemon 与维护 worker 得到的对象不变，用例显式给出的选择与此前缺省相同
- [ ] AC-3 bootstrap 不深取模块的 infrastructure；public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-523 意图、代码历史与记忆的适配器回落改为必填注入（RFC-294 S12 第四步）`。走私有 index、按路径清单提交，在共享发布锁
下 fetch / ff / push。推送后按 exact SHA 跟 CI。
