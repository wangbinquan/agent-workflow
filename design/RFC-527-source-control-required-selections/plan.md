# RFC-527 实施计划

依赖：RFC-526。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-527-T1 选择助手**：五个 `select*` 的选择必填、只做核对；task-execution 的消费方随之必填，只服务用例的两个入口移进测试助手；工作区改动
  发布只为“没给工厂”存在的 `bindPoliciesToWorkspace` 删去（design D1）。
- **RFC-527-T2 排除档案**：单机选择自己构造本机档案工厂（design D2）。
- **RFC-527-T3 员工案例、冲突合并与候选交付**：effect 必填；本机候选工厂带夹具会话；部署选择的两项改为必填、单机给本机实现，daemon 删去四处
  `null` → `undefined`（design D3）。
- **RFC-527-T4 镜像与手动刷新**：拆成本机与托管两个组合入口，bootstrap 按部署选择显式选；登记方式改为显式 `kind`（design D4）。
- **RFC-527-T5 准备与维护**：两组 effect 与维护文件系统必填，维护 worker 单机时显式给本机实现（design D5）。
- **RFC-527-T6 提交绑定**：删去预览索引的回落，没有作用域时预览要求给出索引（design D6）。
- **RFC-527-T6b 两项托管能力**：输入文件留存与任务恢复的消费方改取可空值、显式判 `null`，daemon 删去另两处 `null` → `undefined`（design D9）。
- **RFC-527-T7 用例与测试助手**：测试助手；tsc 列出的调用逐处改；钉旧形状与回落原文的锁随改（design D7）。
- **RFC-527-T8 门与账本**：RFC-521 门删 19 条适配器登记、三处按 `option` 登记，`SUCCESSORS` 清空；计数降的收紧到实测；新增 RFC-527 用例并登记
  guard-manifest（design D8）。
- **RFC-527-T9 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、按删去的名字、选项与回落原文扫出的用例、按被改文件的路径筛出读取其源码
  的用例、经改动的测试助手传入被改项的用例与全部 `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语
  料交给 CI 的 backend 分片。
- **RFC-527-T10 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 1 项关闭。

## 验收清单

- [ ] AC-1 回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 0 条、`SUCCESSORS` 为空；bootstrap 不再把部署选择的 `null` 转回 `undefined`
- [ ] AC-2 daemon、维护 worker 与单机部署得到的对象不变；单机候选推送照旧带夹具会话；用例给出的选择与此前缺省相同
- [ ] AC-3 bootstrap 不深取 source-control 的 infrastructure；public surface 不升；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-526 转 Done）；实现与验证后再提交
`refactor(backend): RFC-527 源代码管理的适配器回落改为必填注入（RFC-294 S12 第八步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff /
push。推送后按 exact SHA 跟 CI。
