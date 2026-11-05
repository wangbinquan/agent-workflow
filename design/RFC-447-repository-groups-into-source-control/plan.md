# RFC-447 实施计划

**前置**：RFC-446 落地（`a85eeebb6`，文档 `5bb075d31`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                              | 依据      |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-447-T1 | 用例迁入 `application/repositoryGroups.ts`，URL 导入改为注入；合同与结果类型进 `application/ports`；删两个死转手  | design §1 |
| RFC-447-T2 | `composeRepositoryGroups` 与 `localRepositoryUrlImport`；`public/types` 与 `public/queries` 转出；装配根接线      | design §2 |
| RFC-447-T3 | 路由只收 `RepositoryGroups`；`server.ts` 类型与挂载；展平函数的四个消费者改取新位置；删除 `services/repoGroup.ts` | design §2 |
| RFC-447-T4 | 架构报告归属表；用例与辅助改 import / 改锚；e2e 与代码注释；新增 RFC-447 用例                                     | design §3 |
| RFC-447-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                             | design §5 |
| RFC-447-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第十三步）                                         | —         |

## 验收清单

- [ ] AC-1 `services/repoGroup.ts` 删除，源码不再 import 旧路径；路由不 import `services/`、对 source-control 只经 `public/types`
- [ ] AC-2 计数按实测更新（路由 6 → 5，`services/` 217 → 216，模块里 import `services/` 的文件 143 → 142，R1 / R2 不变）
- [ ] AC-3 受影响用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-04，候选基于 `5bb075d31`）

本机全程高负载（负载 21～42）。验证都在候选导出仓库里跑（`5bb075d31` 的 `git archive` 加候选路径，提交后运行），工作树同时可用；
每次修复后把候选路径重新同步进导出仓库并核对逐字节相同。

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（改动的后端与 e2e 文件）；改动的 TS 与文档已按 prettier 格式化；
  `guard-manifest.json` 只刷新 RFC-390 守卫的行数（243 → 244）。
- **本 RFC 的问题，已修**：
  - RFC-447 用例的仓库组夹具缺根节点（`path: ''`），五条行为用例被 `repo-group-root-missing` 先拦下；补上根节点后单独复跑 11 / 11 通过；
  - `rfc294-architecture-preflight` 的 public 面白名单报出两条新偏差：`public/queries` 转出的 `resolveRepoGroupLayout` 以整个
    `RepositoryWorkspaceStore` 为参数，把其中的 `Partial` 补丁类型与 `object` 字段带上了 public 面。参数收窄为只读快照的
    `RepositoryGroupSnapshotReader` 后，全部架构测试、预检与 RFC-447 用例复跑 1370 pass / 4 skip / 0 fail（141 个文件）。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4544～5513 s 全部跑完，合计 23339 pass / 127 skip /
  57 fail，另有 34 条测试间未处理错误。除上面两项外：
  - `rfc321-repository-publication-ratchet` 一条是导出仓库只有候选提交所致（RFC-446 已在工作树对照过 10 / 10）；
  - 其余都按各自时限超时，未处理错误都是超时用例被拆除后仍在跑的异步尾巴。19 个文件单独复跑：17 个全过；RFC-167 dw-confirm 3 条、
    RFC-396 MR 候选桥 7 条仍超时（与 RFC-444～446 集中验证里记过的两组相同），给 30 秒时限后 29 / 29、37 / 37 通过。
- **导出仓库接 PostgreSQL 真库**：
  - 共 232 个文件：全部 139 个架构测试；提及仓库组 / mirrors / 展平、仓库组夹具、路由注册 / 错误码 / API 合同、测试套件策略的用例；
    RFC-440～447 用例；去重后合并；
  - 结果 3091 pass / 156 fail / 11 skip。除 RFC-447 用例的五条（同上，已修）外都是 PostgreSQL 一侧的 5 秒时限（13 个文件），另有
    `single-nonroot-member-workspace` 跑满导出脚本的 25 分钟闹钟（已跑完的用例全部通过）；
  - 给 30 秒时限（闹钟放到 1 小时）后这 14 个文件全部通过（616 / 616，PostgreSQL 一侧最长 20.1 秒）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL，在修复后的候选上）：每个引擎 17 个阶段全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 5 个（6 → 5）；`R1-inbound-module-internals` 166 条、`R2-outbound-module-to-legacy` 39 条
  （账本未改）；模块里 import `services/` 的文件 142 个；`services/` 216 个文件。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的用例与原文件逐字相同，只有预定的四处改动：import、`RepoGroupDeps` 的导入函数、`materializeNodes` 的 URL 分支、
  展平函数的参数类型；两个死转手不随迁；
- URL 现场登记：托管仍走远端登记（原先 `register` 优先）；单机仍走镜像缓存，等待上限同口径（真值才带）、每次新建 / 替换读一次；
  不给导入函数时码、消息与 `details` 不变；
- 路由七个端点的参数、权限、响应码与 PAT 删除具名确认不变；
- 装配根里 groups 与 mirrors 共用同一份 mirrors、同一个存储实例；
- `services/task.ts` 与模块内三个消费者调用的是同一个展平函数。

## PR / 提交

单个提交：`refactor(backend): RFC-447 仓库组用例归 source-control（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
