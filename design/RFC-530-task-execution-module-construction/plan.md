# RFC-530 实施计划

依赖：RFC-529。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-530-T1 绑定时构造**：`composeProcessTaskExecutionBinding({ db, daemonGeneration })` 构造执行模块；bootstrap 的 SQLite 一支交入
  `DAEMON_GENERATION`；`composition.ts` 删去单例与 `createTaskExecutionTestModule`（design D1）。
- **RFC-530-T2 只服务用例的入口**：驱动生命周期里读单例的 5 个导出函数与 `createTaskExecutionTestModule` 移进测试助手，`clearTaskDriverLifecycleForTesting`
  只清心跳；删去被覆盖的 `tasks` 与 `composeTaskCancellation`；源终止参与者的登记表必填（design D2）。
- **RFC-530-T3 用例与锁**：测试助手持有测试用的执行模块；直接取单例的用例与靠源终止回落的用例随改；rfc385 / rfc388 / rfc359-w8 / rfc517 的锁随改；
  新增 RFC-530 用例并登记 guard-manifest（design D3）。
- **RFC-530-T4 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例、直接导入被改文件与被改文件在 `src/` 里的调用方的
  用例、经测试助手取执行模块的用例与全部 `tests/architecture/`，与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-530-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 3 项达成。

## 验收清单

- [ ] AC-1 不在 import 期构造执行模块；组合层不导出单例；SQLite 绑定在绑定时构造、每个会话一份
- [ ] AC-2 同一会话里认领、驱动、停止与后台共用同一份；源终止照旧用会话的登记表
- [ ] AC-3 只服务用例的入口不在生产代码里；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-529 转 Done）；实现与验证后再提交
`refactor(backend): RFC-530 任务执行模块不在 import 期构造（RFC-294 S12 第十一步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。
推送后按 exact SHA 跟 CI。
