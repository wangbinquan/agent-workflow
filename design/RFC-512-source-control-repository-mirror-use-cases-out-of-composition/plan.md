# RFC-512 实施计划

依赖：RFC-511；与 S12 共用模块 composition 文件（本 RFC 只改 source-control `composition/repositoryMirrors.ts`；装配入口不变）。按 CLAUDE.md 文首
硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-512-T1 用例归 application**：新增 `application/repositoryMirrors.ts`（`readRegisteredRepository`、`createLocalRepositoryMirrors`、
  `createRemoteRepositoryMirrors`），端口文件增 `RepositoryDirectoryReads` 与 `RepositoryMirrorCache`（design D1）。
- **RFC-512-T2 composition 只装配**：`composeRepositoryMirrors` 只做选择并注入基础设施实现（design D2）。
- **RFC-512-T3 账本**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`）（design D3）。
- **RFC-512-T4 用例**：新增 RFC-512 用例（design §4）。
- **RFC-512-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend 分片。
- **RFC-512-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的位置声明；组合文件只剩一处选择；装配入口的名字、入参与返回形状不变
- [ ] AC-2 同样输入下单机与托管两种装配的每个操作结果、错误与 effect 次序和此前一致
- [ ] AC-3 新位置的依赖面是闭集、时钟由装配注入；public surface 不升；`composition-control-flow-source-control` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-512 源码控制的已登记仓库读取与远端登记用例迁出 composition（RFC-294 S10 第十九步）`。走私有 index、按路径清单提交，在共
享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
