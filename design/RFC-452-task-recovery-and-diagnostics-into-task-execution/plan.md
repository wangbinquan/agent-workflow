# RFC-452 实施计划

**前置**：RFC-451 落地（`79867699c`，文档 `46f7160bb`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                   | 依据      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-452-T1 | 17 个文件迁入 task-execution（`application/recovery`、`application/lifecycleAlerts`、`application`、`infrastructure`） | design §1 |
| RFC-452-T2 | shared 诊断响应 schema；`TaskDiagnostics` 合同（ports / public / composition）；路由、`server.ts` 依赖、HTTP 装配      | design §2 |
| RFC-452-T3 | task-execution 内部与两个装配根改取新位置；composition barrel 增导出                                                   | design §3 |
| RFC-452-T4 | 用例 import、随迁文本锁、账本与清单、P0 受保护文件清单、guard-manifest；新增 RFC-452 用例                              | design §4 |
| RFC-452-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                  | design §6 |
| RFC-452-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan                                                                | —         |

## 验收清单

- [x] AC-1 17 个旧文件删除、零引用；`tasks` 路由不再 import 诊断 / 恢复 7 个模块；平台 → 模块仍为 0
- [x] AC-2 计数按实测更新（`services/` 205 → 187，`R1` 166 → 148，`R2` 35 → 33）
- [x] AC-3 受影响用例与新增用例全部通过（本机负载下的超时逐个复跑或同刻对照，见下）
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-05，候选基于 `46f7160bb`）

本机全程高负载（负载 30～100，主要来自本机的 kind 控制面容器与三个残留的空转 mock MCP 进程）。验证都在候选导出仓库里跑（`46f7160bb` 的
`git archive` 加候选路径，提交后运行）；集中验证中的修复同步进导出仓库后，核对 151 个候选路径与 guard-manifest 与工作树逐字节相同。

- **静态**：`tsc`（backend、shared）0 错；eslint `--max-warnings 0`、promises 配置与 e2e 配置无告警；改动的 TS、e2e 与 workflow 已按
  prettier 格式化；`guard-manifest.json` 刷新受影响守卫的行数。
- **本 RFC 的问题，已修**（第一条 PostgreSQL lane 与 RFC-451 的触发清单守卫查出）：
  - 模块求值环：barrel 导出诊断装配 → 会话树读端经本模块 `public/participants` 取 `selectNodeRunPromptOperations` → `public/participants`
    从 barrel 取 `taskExecutionModule`。72 个文件在加载时报 `Cannot access 'taskExecutionModuleInternal' before initialization`，
    `rfc376` 的 value-SCC 计数同时 1 > 0（tsc / eslint 看不见）。改为直取 `composition/nodeRunPrompts`，`docs/dev-gotchas.md` 记下；
  - 装配起初连同原路由的两段编排与两个运行期「未装配」检查一起放在 composition：`rfc423`（composition 只装配）与 `rfc359-w5-t19b`
    （组合根占位计数 marker=2）报出。编排迁入 `application/taskDiagnostics`，依赖改为必填参数，`rfc349` 的失败关闭锁改查路由的新错误码，
    RFC-452 用例改为类型层断言；
  - `L/eventsArchive.ts` 迁移后无生产消费者：`unreachable-production-files` 28 > 27。删除并改指（design §1）；
  - `windows-platform.yml` 两份触发清单里的 4 个旧路径（RFC-451 的 `ci-workflow-path-filters` 守卫报出），改指新文件。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时；求值环修复后启动）：4484～5084 s 全部跑完，合计
  23392 pass / 127 skip / 51 fail，另有 34 条测试间未处理错误。49 条是超时（22 个文件；47 条撞默认 5 秒、RFC-354 与 RFC-363 各一条撞
  自带的 30 秒），未处理错误都出在这些文件里，是超时用例被拆除后仍在跑的异步尾巴；另两条是导出仓库只有候选提交所致的 `rfc321`，以及
  `rfc359-w5-t19b` 跑在装配重构同步进导出仓库之前（见下）。
  - 22 个文件逐个单独复跑（30 秒时限）：20 个全过；RFC-363 的 5004 项目录分页一例（自带 30 秒）与 RFC-167 dw-confirm 的 `approve`
    一例（自带 5 秒 `settleTask` 等待）仍到点——对照：同一时刻在 RFC-451 的导出仓库里跑同一文件，失败的是同一例（30.8 s 与 30.7 s；
    5.6 s 与 5.5 s），其余用例两边都过。
  - 装配重构与转出删除在全量跑的途中同步进导出仓库，于是在最终内容上另跑一遍 234 个文件（全部架构测试，诊断 / 恢复 / 会话 / 清单 /
    启动验证路由，归档用例，RFC-349 / 452 用例与第一条 PostgreSQL lane 的失败文件）：2216 pass / 6 skip / 1 fail（`rfc321`）——
    `rfc376`、`rfc423`、`rfc359-w5-t19b`、`rfc294` 各守卫与 RFC-452 用例都过。
- **导出仓库接 PostgreSQL 真库**：
  - 第一条 lane 341 个文件（全部架构测试；迁移的家族及其消费方；`tasks` 的告警 / 诊断 / 修复 / 会话 / 清单 / 启动验证 HTTP；装配根与
    HTTP 装配；提及这些文件的用例；RFC-440～452 用例）：3158 pass，81 个文件失败——72 个是上面的求值环，3 个是上面的结构守卫，`rfc321`，
    其余 5 个在 PostgreSQL 一侧超时；
  - 修复后复跑 234 个文件（第一条 lane 的 232 个加两个归档用例，即上面 SQLite 那份清单）：除 `rfc321` 外 39 个文件在 PostgreSQL 一侧超时（测试应用在 PostgreSQL 上启动超过
    默认 5 秒；超时拆除后连接池关闭，正在启动的应用随即报 `Connection closed`），没有别的失败；
  - 给 30 秒时限后 38 个文件全过（含 RFC-311 性能防护与诊断 / 修复 / 会话 / 清单 / 启动验证路由，合计 583 pass）；RFC-359 W6-T26
    PostgreSQL 计划审计的 600 秒准备钩子到点（612 s），其余 5 例都过——对照：同一时刻在 RFC-451 的导出仓库里跑同一文件，两边的准备钩子
    同时到点（616.4 s 与 616.6 s），其余 5 例两边都过（RFC-451 集中验证时也是这样）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL，另一份同内容的导出仓库）：每个引擎 17 个阶段全部符合预期，
  127 个受保护源文件的哈希前后一致。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **计数复核**：`services/` 205 → 187 个文件；`R1-inbound-module-internals` 166 → 148、`R2-outbound-module-to-legacy` 35 → 33（账本与
  实测相等）；模块里 import `services/` 的文件 139 → 134；import `services/` 的路由仍 1（`tasks` 余 workspace-insight 7 处）；
  平台 → 模块文件对 0。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的 17 个文件与原文件逐字相同（脚本逐文件核对，只差 import 段与 `deadRunReconcile` 一处指向旧路径的注释）；
- 路由 7 个端点与原实现等价：`requireOperator` 权限门、`c.req.param` 的读取与 `c.json` 的形状留在路由；告警读、恢复审计（审计最近
  50 条与熔断态并发读）、清除熔断、会话树 / 运行时清单 / 启动验证三个读端的参数与原调用相同；诊断与原处理函数逐行相同——实时扫描的
  `onAlert` / `onResolved` 经接收者广播到任务列表频道（载荷与 `applyRepair` 的 `onAlert` 共用同一个函数），扫描后补上未关闭行
  （`resolvedAt: null`，实时行在前）；
- HTTP 装配给诊断合同的恢复操作、读模型、提示词操作、归档读端与运行时清单内容，与原来路由拿到的是同一批对象；原来缺这两类依赖时的
  运行期错误码随必填参数一起消失（装配点总会给），路由缺 `diagnostics` 时抛 `task-diagnostics-not-composed`；
- 装配根经 barrel 取的不变量扫描、卡死检测与优雅关停是同一组函数；`daemonSession` 原来在关停时动态 import `L/shutdown`，现在从它本就
  静态 import 的同一 barrel 取，关停流程不变；
- 集中验证查出的四处问题（见上）已修并复验。

## CI（AC-4）

`4f0ede4c5`：exact SHA 主 CI run 42136284144 首轮全绿（70 个 job）；windows-platform run 42136284181、integration-opencode run 42136284197、
git-protocols-e2e run 42136284147 随本提交触发并全绿；同 SHA 的 maintenance-soak 夜间 run 42136284202（触发清单改指的
`systemEventsArchive.ts`）与 visual-regression 夜间 run 42136284234（前端 `RecoverySection.tsx` 的注释）全绿。

## PR / 提交

单个提交：`refactor(backend): RFC-452 任务恢复与诊断家族归 task-execution（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
