# RFC-511 实施计划

依赖：RFC-510；与 S12 共用模块 composition 文件（本 RFC 只改 source-control `composition/` 下的 7 个文件；装配入口不变）。按 CLAUDE.md 文首硬
规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-511-T1 核对归 application**：5 组工作区端口核对迁入新的 `application/workspacePorts.ts`，候选效果工厂的核对迁入新的
  `application/repositoryCandidateEffects.ts`，冲突合并效果的核对并入 `application/conflictMerge.ts`（design D1）。
- **RFC-511-T2 composition 只装配**：7 个组合文件改为调用新位置的核对，转出原有的名字（design D2）。
- **RFC-511-T3 账本与锁**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`）；`rfc294-architecture-preflight` 的允许清单随声明
  位置更新（design D3）。
- **RFC-511-T4 用例**：新增 RFC-511 用例（design §4）。
- **RFC-511-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字与错误串扫出的用例与全部 `tests/architecture/`，按 CI 的跑法
  与 HEAD 同时 A/B；红的按时限放宽复核；`rfc294-architecture-preflight` 的放宽副本；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend
  分片。
- **RFC-511-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的位置声明；7 个组合文件不再有这 28 行核对；装配入口、选择函数与转出的名字不变
- [ ] AC-2 同样输入下每个核对接受与拒绝的输入、错误与时机和此前一致
- [ ] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-source-control` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-510 转 Done 提交 `036df2e8c` 的 CI）；实现与验证后再提交
`refactor(backend): RFC-511 源码控制组合层的端口完整性核对迁出 composition（RFC-294 S10 第十八步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
