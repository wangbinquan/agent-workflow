# RFC-532 实施计划

依赖：RFC-531。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-532-T1 安装选择**：system-operations `composition/daemonDatabaseInstallation.ts`（`DaemonDatabaseInstallation`、本机与按端口的两个组合函数，
  本机 epoch 路径原样搬入）；`composition/daemonDatabase.ts` 导出准备输入与结果的类型（design D1 / D2）。
- **RFC-532-T2 合同、profile 与 daemon**：合同的槽位必填；单机交本机安装（交入 `runAutoUpgradeChild`），托管交按端口的安装；`daemonStart.ts`
  调 `admit` / `prepare`，删去两处 `null` 判断与对应导入（design D2 / D3）。
- **RFC-532-T3 用例与锁**：新增 RFC-532 用例并登记 guard-manifest；选择分组与钉住旧形状的锁随改（design D4）。
- **RFC-532-T4 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例（按路径主干与被移走的名字）、直接导入被改文件与
  其在 `src/` 里调用方的用例与全部 `tests/architecture/`，红的与 HEAD 同时 A/B；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-532-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 1 项在 daemon 侧的余项收完。

## 验收清单

- [ ] AC-1 `databaseInstallation` 必填、类型是 `DaemonDatabaseInstallation`；两个 profile 各给一份
- [ ] AC-2 daemon 不按 `null` 分支、不取本机 epoch 路径；两种 profile 的启动行为与此前相同
- [ ] AC-3 计数不升；锁随改；新增 RFC-532 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-531 转 Done）；实现与验证后再提交
`refactor(backend): RFC-532 数据库安装由部署选择给出（RFC-294 S12 第十三步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff /
push。推送后按 exact SHA 跟 CI。
