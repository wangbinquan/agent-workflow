# RFC-445 实施计划

**前置**：RFC-444 落地（`98cd1706f`，文档 `60a8b2c7c`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                             | 依据      |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-445-T1 | multipart 信封迁入 `platform/http/multipartLaunch.ts`；其余上传助手按层迁入 task-execution；删除两个 legacy 文件 | design §1 |
| RFC-445-T2 | 恢复计数迁入 `platform/health/recoveryCounters.ts`；`services/recovery.ts` 只留审计写入与查询                    | design §1 |
| RFC-445-T3 | 引用改到新位置（路由、模块、platform、legacy 类型、`routes/tasks.ts` 的转出）；CI 路径过滤                       | design §2 |
| RFC-445-T4 | 账本（R1 169 → 166）；架构报告归属表；用例改 import；新增 RFC-445 用例                                           | design §3 |
| RFC-445-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                            | design §6 |
| RFC-445-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第十一步）                                        | —         |

## 验收清单

- [x] AC-1 两个原文件删除，源码不再 import 旧路径；`agents`、`health` 路由不 import `services/`；计数只经 platform
- [x] AC-2 计数按实测更新（路由 9 → 7，R1 169 → 166，`services/` 220 → 218）
- [x] AC-3 受影响用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-04，候选基于 `60a8b2c7c`）

本机全程高负载（负载 30～110；Docker 虚拟机里常驻的 Kubernetes 控制面占 4～7 核，PostgreSQL 容器也在这台虚拟机里）。

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 无告警（改动的后端、e2e 与前端文件）；改动的 TS 与文档已按 prettier 格式化。
- **全量 SQLite**（`bun run test:backend`，四分片）：分片 2、4 跑完（5111 s / 5211 s）；分片 1、3 撞上 90 分钟上限，按原种子单独重跑
  跑完（3959 s / 3932 s）。合计 23324 pass / 127 skip / 50 fail，另有 32 条测试间未处理错误。逐条归因：
  - **本 RFC 的问题，已修**：
    - RFC-445 用例两条断言写错：未命名部件的 MIME 由 bun 的 multipart 传输决定（`filename=""` 的部件解析后类型为空），改为断言与
      部件自带的类型一致；`/health` 路由只有 3 个本地 import 目标，「多于 3 个」的非空对照改为「含本 RFC 改到的新位置」；
    - RFC-440～445 用例里的全树 import 扫描在高负载下超过 5 秒缺省时限（RFC-441、RFC-445 各一条），给 60 秒时限；
    - 六个文件单独复跑 46 / 46 通过。
  - **负载超时，与本 RFC 无关**：其余 48 条都按各自时限超时；未处理错误都是超时用例被拆除后仍在跑的异步尾巴（关库、git 基线解析）。
    - 18 个文件单独复跑：16 个全过；RFC-167 dw-confirm 3 条、RFC-396 MR 候选桥 5 条仍超时（RFC-444 的集中验证里同样记过这两组）。
      对照（两组都不经过本 RFC 改动的代码）：MR 候选桥给 30 秒时限后候选 37 / 37 通过，同一时段 `60a8b2c7c` 原样导出按缺省
      时限 35 / 37（同类两条超时）；RFC-167 那组除用例时限外，`settleTask` 自带 5 秒轮询期限
      （`tests/rfc167-dynamic-workflow-engine.test.ts:1017`），给 30 秒时限后候选 28 / 29（剩一条 5 秒内未落定），基线按缺省时限 27 / 29。
    - `rfc376-report`（读已提交源码，本机 495 s 超过 300 s 时限）在导出仓库的已提交候选上通过。
- **导出仓库**（`60a8b2c7c` 的 `git archive` 加候选路径，提交后运行，同时接 PostgreSQL 真库）：
  - 共 242 个文件：全部 139 个架构测试；提及 multipart、上传、恢复计数、`/health`、启动配置、windows-platform 与测试套件策略的用例；
    本 RFC 改动的用例；去重后合并；
  - 结果 2680 pass / 25 fail / 13 skip。25 条失败都是 PostgreSQL 一侧的 5 秒时限（用例或钩子），分布在 10 个文件，单独复跑仍超时；
  - 对照：
    - 同一时段在 `60a8b2c7c` 原样导出上跑同样 10 个文件，其中 5 个同样超时；
    - 对另 5 个逐文件交替跑两轮候选与基线：两边互有胜负（如 RFC-104 内建只读：候选 12 / 1 条、基线 8 / 12 条超时）；
    - PostgreSQL 一侧每条用例 4～7 秒、SQLite 一侧 0.1～0.9 秒，正卡在 5 秒时限上下；
  - 给 30 秒时限后候选的 10 个文件全部通过（128 / 128，PostgreSQL 一侧最长 7.0 秒）；
  - 本 RFC 用例、RFC-440～444 用例、上传与 multipart 启动、恢复审计与计数、资源上限、空闲收割、`/health`、路由禁 cast、
    测试套件策略、R1 / R2 账本与公共内核清单均通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段（当前绿、15 个历史回归变异
  各自变红、当前再绿）全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 7 个（9 → 7）；`R1-inbound-module-internals` 166 条、`R2-outbound-module-to-legacy`
  39 条；模块里 import `services/` 的文件 143 个；`services/` 218 个文件。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的函数与类型与原文件逐字相同：`parseMultipartLaunch` 与两个类型、`collectUploadInputDefs`、`bufferUploadParts`、
  `attachWorkspaceCleanupToMultipartError`、`resolveUploadLimits`、三个计数函数；
- `bufferUploadParts` 的参数与 `routes/agents.ts` 的上传变量改用 public 的 `TaskRouteMultipartFilePart`（字段同名同类型、只读），
  由 `tsc` 核对可赋值；
- 计数状态只在 platform 一处；`recordRecoveryEvent` 仍先累加计数再写审计；
- 各引用方只改 import 路径；`routes/tasks.ts` 删去的转出只有一个用例消费者，已改从 application 取。

## CI（AC-4）

`16465e382`：exact SHA 主 CI run 41958285754：

- attempt 1 只有 backend 分片 43/44 红一条：`scheduler-clarify-dispatch`「interrupted clarify rerun」的 PostgreSQL 一侧 5491ms
  越过 bun 默认 5s，测试间未处理错误是超时后被拆除的同一用例的尾巴；
- 归因 runner 时序，不归本 RFC：前一提交（`60a8b2c7c`，run 41897046254）同一分片上该例 1498ms 通过；同一运行里同文件其余各例
  0.9～1.7s、该例 SQLite 一侧 396ms；该例经过的 `runTask` / 反问 / 调度路径不含本 RFC 改动的代码；同一文件此前已有三例按同一理由
  给过 20s 显式预算（`679e70a9a`、RFC-423、RFC-430），本例由 RFC-446 补上；
- 只重跑失败作业，attempt 2 全绿；重跑只作佐证，不作通过依据。windows-platform（run 41958286074）、integration-opencode、
  visual-regression-nightly 首轮全绿。

## PR / 提交

单个提交：`refactor(backend): RFC-445 启动 multipart 信封与恢复计数归 platform，上传兼容层退役（RFC-294 W4 B/D）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
