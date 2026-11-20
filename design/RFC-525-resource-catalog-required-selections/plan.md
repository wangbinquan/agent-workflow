# RFC-525 实施计划

依赖：RFC-524。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-525-T1 技能内容**：绑定的两项必填、选择助手只收绑定、技能目录与可用性与版本推进的选项必填（design D1）。
- **RFC-525-T2 资源包**：包 provider、工件属主与维护场景的选项必填；本机实现经组合层交出（design D2）。
- **RFC-525-T3 插件与 MCP 探测**：安装器与探测执行器必填；进程内执行器（design D3）。
- **RFC-525-T4 bootstrap**：资源包命令、维护 worker、单机 MCP 诊断与 daemon 资源目录装配显式给出（design D2、D3）。
- **RFC-525-T5 用例与测试助手**：测试助手；tsc 列出的调用逐处改；钉旧形状与回落原文的锁随改（design D4）。
- **RFC-525-T6 门与账本**：RFC-521 门删 16 条登记、`SUCCESSORS` 删 resource-catalog；计数降的收紧到实测；新增 RFC-525 用例并登记 guard-manifest。
- **RFC-525-T7 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、按被删的名字、选项与回落原文扫出的用例、经改动的测试助手传入被改项的用例
  与全部 `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-525-T8 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 16 处回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 35 条
- [ ] AC-2 daemon、资源包命令、维护 worker 与 MCP 探测得到的对象不变；用例给出的选择与此前缺省相同
- [ ] AC-3 bootstrap 不深取 resource-catalog 的 infrastructure；public surface 不升；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-524 转 Done）；实现与验证后再提交
`refactor(backend): RFC-525 资源目录的适配器回落改为必填注入（RFC-294 S12 第六步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。
推送后按 exact SHA 跟 CI。
