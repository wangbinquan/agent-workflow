# RFC-446 实施计划

**前置**：RFC-445 落地（`16465e382`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                    | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------- | --------- |
| RFC-446-T1 | 三个函数原样迁入 `infrastructure/local/repositoryIntrospection.ts`；路由的已登记目录判定移成本地读工厂  | design §1 |
| RFC-446-T2 | mirrors 装配本地读工厂；端口文档；路由去掉存储参数与判定；`server.ts` 类型与挂载                        | design §2 |
| RFC-446-T3 | 删除 `services/repo.ts`；架构报告归属表；路由错误码棘轮语料；用例改 import；e2e 注释；新增 RFC-446 用例 | design §3 |
| RFC-446-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                   | design §5 |
| RFC-446-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第十二步）                               | —         |

## 验收清单

- [ ] AC-1 `services/repo.ts` 删除，源码不再 import 旧路径；`routes/repos.ts` 不 import `services/`、不收仓库存储；判定只在一处
- [ ] AC-2 计数按实测更新（路由 7 → 6，`services/` 218 → 217，R1 166 / R2 39 不变）
- [ ] AC-3 受影响用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-04，候选基于 `16465e382`）

本机全程高负载（负载 21～77；Docker 虚拟机里常驻的 Kubernetes 控制面占 4～7 核，PostgreSQL 容器也在这台虚拟机里）。验证都在候选
导出仓库里跑（`16465e382` 的 `git archive` 加候选路径，提交后运行），工作树同时可用；导出与工作树的候选路径逐字节相同。

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（改动的后端与 e2e 文件）；改动的 TS 与文档已按 prettier 格式化。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限放到 2 小时）：4482～4982 s 全部跑完，合计 23333 pass /
  127 skip / 52 fail，另有 34 条测试间未处理错误。逐条归因：
  - 无本 RFC 的问题；
  - `rfc321-repository-publication-ratchet` 一条：导出仓库只有候选提交、又不是浅克隆，「账本里的提交可从历史到达」在这里不可能
    成立；在工作树（完整历史）里 10 / 10 通过；
  - 其余 51 条都按各自时限超时，未处理错误都是超时用例被拆除后仍在跑的异步尾巴。19 个文件单独复跑：17 个全过；RFC-167 dw-confirm、RFC-396 MR 候选桥各 1 条仍超时，与 RFC-444、RFC-445 集中验证里记过的两组相同（RFC-445 在基线 `60a8b2c7c` 上对照过同样超时；两组都不经过本 RFC 改动的代码）。
- **导出仓库接 PostgreSQL 真库**：
  - 共 183 个文件：全部 139 个架构测试；提及仓库 refs / files、mirrors、已登记目录判定、路由注册 / 错误码 / API 合同与文档、
    仓库组与镜像缓存 HTTP、测试套件策略的用例；本 RFC 改动的用例；去重后合并；
  - 结果 2378 pass / 180 fail。180 条都是 PostgreSQL 一侧的 5 秒时限（与全量 SQLite 同时跑，负载 67～76），分布在 17 个文件；
  - 给 30 秒时限后这 17 个文件全部通过（408 / 408，PostgreSQL 一侧最长 21.3 秒）；本 RFC 用例、`repos`、`repos-path-allowlist`、
    `rfc370-v4-repository-mirrors`、路由错误码棘轮、API 合同与覆盖、测试套件策略与全部架构测试均通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`）：SQLite 17 个阶段全部符合预期；PostgreSQL 一侧第一次在「当前绿」阶段有两条
  用例按 5 秒时限超时（与全量 SQLite 同时跑），负载降下后单独重跑 17 个阶段全部符合预期；两次源文件哈希前后一致。
- **附带的 clarify 预算**：`scheduler-clarify-dispatch` 在候选上单独跑，缺省时限下 PostgreSQL 一侧 8 条都在钩子里超时（本机
  PostgreSQL 每条用例 11～21 秒）；给 30 秒时限后 16 / 16 通过。
- **计数复核**：import `services/` 的路由 6 个（7 → 6）；`R1-inbound-module-internals` 166 条、`R2-outbound-module-to-legacy`
  39 条（账本未改）；模块里 import `services/` 的文件 143 个；`services/` 217 个文件。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 三个函数与原文件逐字相同；原路由里的判定（取已登记目录、`isKnownRepoPath`、`repo-path-unknown` 的码与消息）原样移进
  `createKnownPathRepositoryReads`；
- 判定顺序不变：路由仍先判缺参、部署不持有本机镜像，再进入 `local`，`local` 先判定再读；
- 生产里 `RepositoryMirrors` 只由 `composeRepositoryMirrors` 一处构造：单机分支的 `local` 由工厂装配，托管分支没有 `local`；装配层
  给 mirrors 与路由的是同一个 `core.repositoryWorkspaceStore`，判定读到的已登记目录与原先相同；
- 各引用方只改 import 与挂载参数。

## PR / 提交

单个提交：`refactor(backend): RFC-446 仓库 refs / files 读取归 source-control（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
