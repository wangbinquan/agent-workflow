# RFC-531 实施计划

依赖：RFC-530。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-531-T1 语义选择类型**：runtime-management 的 `RuntimeManagementAssembly`、bootstrap 的 `RuntimeManagementSelection`、task-execution 端口里的
  System Agent 运行族选择类型、resource-catalog 的 `McpDiagnosticsSelection`、source-control `composition/deploymentSelections.ts` 的 4 个选择类型；
  `DeploymentSelections` 的 7 个槽位与 `HostProbeInput.log` 改用它们；托管工厂与 daemon 的 `mcpRuntimeTests` 随改（design D1）。
- **RFC-531-T2 镜像与镜像刷新**：`repositoryRemote` 换成 `repositoryMirrors` 与 `repositoryMirrorRefresh`；两个 profile 给出各自的实现；daemon 的
  HTTP 装配与子仓刷新句柄删去 `null` 分支；`DEPLOYMENT_SELECTION_KEYS` 随改（design D2）。
- **RFC-531-T3 用例与锁**：新增 RFC-531 用例并登记 guard-manifest；钉住旧形状的锁随改（design D3）。
- **RFC-531-T4 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例、直接导入被改文件与被改文件在 `src/` 里的调用方的
  用例与全部 `tests/architecture/`，与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-531-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 6 项的一半与第 1 项余项的镜像、子仓刷新两处达成。

## 验收清单

- [ ] AC-1 合同里没有 `typeof` 定型的槽位；托管工厂与 daemon 装配不按本地工厂签名定型
- [ ] AC-2 `repositoryRemote` 换成必填的镜像与镜像刷新；daemon 不再按 `null` 选；两种 profile 的镜像与刷新与此前相同
- [ ] AC-3 计数不升；锁随改；新增 RFC-531 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-530 转 Done）；实现与验证后再提交
`refactor(backend): RFC-531 部署选择合同的槽位改为语义类型、镜像与子仓刷新由 profile 选择（RFC-294 S12 第十二步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
