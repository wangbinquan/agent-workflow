# RFC-526 实施计划

依赖：RFC-525。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-526-T1 启动恢复与数字员工执行**：执行恢复工厂与程序工具源必填，删去数字员工执行的 `appHome`（design D1）。
- **RFC-526-T2 操作配置**：daemon 交给驱动参与者；提交排除模式与可执行文件冻结只取给的配置，删去按 `configPath` 造本机实现的两支（design D2）。
- **RFC-526-T3 启动配置**：按 `kind` 显式装配两支（design D3）。
- **RFC-526-T4 节点提示、端口工件与删除效果**：内容必填、组合层转出本机内容实现、单机部署显式构造；删去内部的 `select*`，调用方的选择必填
  （design D4）。
- **RFC-526-T5 provider 运行期与归档**：排除档案与归档必填、旧版一支的提示与工件必填；维护 worker 显式给归档内容（design D5）。
- **RFC-526-T6 工作区存在性**：生命周期持久化的存在性必填；维护 worker、任务取消与人审停靠显式给出（design D6）。
- **RFC-526-T7 用例与测试助手**：测试助手；tsc 列出的调用逐处改；钉旧形状与回落原文的锁随改（design D7）。
- **RFC-526-T8 门与账本**：RFC-521 门删 16 条登记、`SUCCESSORS` 删 task-execution；计数降的收紧到实测；新增 RFC-526 用例并登记 guard-manifest。
- **RFC-526-T9 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、按被删的名字、选项与回落原文扫出的用例、按被改文件的路径筛出读取其源码
  的用例、经改动的测试助手传入被改项的用例与全部 `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语
  料交给 CI 的 backend 分片。
- **RFC-526-T10 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 16 处回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 19 条
- [ ] AC-2 daemon、维护 worker 与单机部署得到的对象不变；改取部署选择的路径不查询存在性；用例给出的选择与此前缺省相同
- [ ] AC-3 bootstrap 不深取 task-execution 的 infrastructure；public surface 不升；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-525 转 Done）；实现与验证后再提交
`refactor(backend): RFC-526 任务执行的适配器回落改为必填注入（RFC-294 S12 第七步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。
推送后按 exact SHA 跟 CI。
