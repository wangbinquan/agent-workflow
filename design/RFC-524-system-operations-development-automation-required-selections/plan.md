# RFC-524 实施计划

依赖：RFC-523。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-524-T1 system-operations**：命令与迁移入口、daemon 的数据库准备、宿主生命周期与运行期查询（design D1、D2）。
- **RFC-524-T2 development-automation**：开发自动化、开发交付、平台工作项与任务输入上传（design D3）；删去没有使用方的旧版流水线证据桥与懒建证
  据库。
- **RFC-524-T3 bootstrap**：daemon 启动、开发重载、会话、应用与 HTTP 装配、两个命令根、`migrate` 与 daemon 的开发自动化装配显式给出（design D1～D3）。
- **RFC-524-T4 用例与测试助手**：两个测试助手；tsc 列出的调用逐处改；钉旧形状的锁随改（design D4、D5）。
- **RFC-524-T5 门与账本**：RFC-521 门删 16 条登记、`SUCCESSORS` 删两个模块；删除的旧版证据桥在两个账本里的条目随删；计数降的收紧到实测；新增
  RFC-524 用例并登记 guard-manifest。
- **RFC-524-T6 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、按被删的名字、选项与路径扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-524-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 16 处回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 51 条
- [ ] AC-2 daemon、CLI 命令与维护入口得到的对象不变；用例给出的选择与此前缺省相同
- [ ] AC-3 bootstrap 不深取两个模块的 infrastructure；public surface 不升；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-524 系统运维与开发自动化的适配器回落改为必填注入（RFC-294 S12 第五步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
