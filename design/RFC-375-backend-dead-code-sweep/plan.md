# RFC-375 实施计划

单批次交付，由 Codex 实施、本会话审核后提交。先完成全部删除、改指与测试编辑，再集中验证一次（CLAUDE.md 文首硬规则）。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-375-T1 | development-automation：删 `composition/required-ports.ts`、`domain/refs.ts`、`effectExecutor` 成员与 `MissionEffectExecutorPort`、`missionReconciler.ts` 的恒 `continue` 分支 | design §2.1 |
| RFC-375-T2 | digital-employee：删 `public/queries.ts`、四个投机端口与只为它们服务的 DTO、`EmployeeContextRef`；四个级联类型移入 `application/ports/caseRuntime.ts`，`ExactResourceRef` 改用 `domain/model.ts` | design §2.2 |
| RFC-375-T3 | collaboration：删 18 个无人使用的 public 符号与 `listRecentTaskFeedback`（含 `services/taskFeedback.ts:5` 再导出）；删 4 个仅测试使用的再导出；删可直接从 owner 取的模块内再导出、事件常量移到 domain、失去公开 consumer 的类型移除再导出；**不动**依赖 composition 助手的 13 个本地函数 | design §2.3 |
| RFC-375-T4 | `services/` 零生产 importer 文件：4 个无 importer、12 个纯门面、8 个死实现 | design §2.4 |
| RFC-375-T5 | `services/scheduler.ts`：删 `failTask` / `cancelTaskRow` / `cancelTaskRowUnlocked` / `taskStopCauseOf` 与随之无用的 import；不动 `isFresherNodeRun` 再导出 | design §2.5 |
| RFC-375-T6 | 其他不可达模块 / platform 文件：无 importer、纯门面、死实现（code-capability 簇、development-automation 配置簇、`legacyMissionDrain`、`resourceRevision`、`skillZipArchive`） | design §2.6 |
| RFC-375-T7 | 13 个没有生产调用方的定时器启动函数及其再导出、handle 类型；清理无用 import | design §2.7 |
| RFC-375-T8 | 测试：整文件删除、个别用例删除 / 编辑、只改 import、改指现行实现 | design §3.1～§3.4 |
| RFC-375-T9 | 手维护守卫与清单、CI 路径过滤 | design §3.5（测试文件与 workflow 部分） |
| RFC-375-T10 | 在最终报告中给出 `rfc294Canonical.ts` 待删行、`ledger-baselines.json` 新基线、`guard-manifest.json` 重算字段；**不直接修改这些文件** | design §3.5（审核方部分） |
| RFC-375-T11 | 删除完成后重算入口可达性，报告仍不可达的文件，与 design §4 对照 | design §1、§4 |
| RFC-375-T12 | RFC-294 `plan.md` §3 S3 小节链接本 RFC——**已由审核方在立项提交中完成，实施方不改 RFC-294 文档**（状态在收口时由审核方更新） | — |

依赖：T1～T7 互不依赖；T8、T9 依赖对应的删除；T10、T11 在 T1～T9 之后。

## 实施约束

- 每删一个文件 / 符号之前，以当时源码复核生产 importer 为 0；`git status --porcelain -- <path>` 非空的文件跳过并报告。
- 不修改：design §4 保留清单、§5 排除清单中的文件；`T/helpers/eachProviderTaskExecution.ts`；`tests/architecture/rfc294Canonical.ts`、
  `census.ts`、`scripts/depcheck.ts`、`scripts/architecture-*.ts`、根目录 `architecture/**`、RFC-294 `status.md`。
- 不新增导出来迁就测试；不修剪仍在使用的门面中的单个导出名。
- 不 `git add` / commit / push；不运行 census。

## 验收清单

- [ ] design §2 清单全部删除（跳过项在报告中说明）
- [ ] design §3 测试改动完成；改指的测试针对现行实现通过
- [ ] 重算的不可达文件只剩 design §4（差异逐条说明）
- [ ] 三包 typecheck、改动文件 eslint / prettier、`bun run depcheck` 通过（他人在制文件的错误单列）
- [ ] 受影响测试全绿（SQLite；PostgreSQL 由 CI 覆盖）
- [ ] 审核方应用 T10 后提交、生成投影、推送；exact SHA CI 绿

## 提交编排（审核方）

1. 应用 T10：删 `rfc294Canonical.ts` 中对应 legacy owner 行，改 `ledger-baselines.json` 与 `guard-manifest.json`。
2. 按路径提交内容；旧账本制度下以内容提交为源跑 census 并提交投影（本 RFC 只会让各账本下降，预期不需要 `allowGrowth`）。
3. 若 RFC-376 已先落地：改为删除其双向例外清单中因本 RFC 而过期的条目，不再生成投影。
4. 推送后按 exact SHA 跟踪 GitHub Actions。
