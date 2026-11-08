# RFC-470 实施计划

**前置**：RFC-469 落地（`e9fb623f8`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                         | 依据          |
| ---------- | -------------------------------------------------------------------------------------------- | ------------- |
| RFC-470-T1 | 端口补 `readWorkflow`、候选补 `frozenClosureJson`、问题带 `code`                             | design §1     |
| RFC-470-T2 | 启动资源适配器与快照校验门迁入 resource-catalog；task-execution 的两个文件删除               | design §2、§3 |
| RFC-470-T3 | 路由经端口读工作流行；`services/task.ts` 的同步预览经注入的校验；装配根改取 resource-catalog | design §3～§5 |
| RFC-470-T4 | 两个薄转出与 `services/taskLaunchGate.ts` 删除；用例改指定义处；`PLUGIN_DISABLED_SITES` 改锚 | design §6     |
| RFC-470-T5 | 精确清单、账本与 guard-manifest；新增 RFC-470 用例                                           | design §7、§8 |
| RFC-470-T6 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                        | design §11    |
| RFC-470-T7 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                              | —             |

## 验收清单

- [x] AC-1 三个文件与 task-execution 的两个适配器文件不在、零引用；实现与端口逐项相同；同步预览与同步门经端口读、经注入的校验判
- [x] AC-2 架构计数按实测（`R1` 66 → 64、跨 context 内部文件对 46 → 43），越界类计数、public surface 偏差与未被消费的 public 符号不升
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI：本 RFC 引入的红已由 `1a73472b7` 修复，余下红格逐格归因、与本 RFC 无关（见 §CI）

## 集中验证（2026-11-07～08，候选基于 `4d63ca40c`）

本机全程高负载（采样到的负载 18～86；本机另有常驻负载：一个本地虚拟机约 4 核、三个挂起的测试夹具进程各约 0.8 核）。验证都在候选导出仓库里跑
（`4d63ca40c` 的 `git archive` 加候选路径，提交后运行；文档改动后重新同步，核对与 HEAD 加候选逐字相同）。集中验证没有查出本 RFC 的问题。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（97 个改动的 TS 文件，加
  `eslint.promises.config.js` 覆盖的 src）；`depcheck` 分层门通过（4422 个模块）；改动的 TS 与 RFC-470 文档已按 prettier 格式化。
- **声明逐个比对**：见实现门。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 3 小时）：四片 7092 / 7000 / 7081 / 6569 s 全部跑完，合计 23525 pass /
  127 skip / 79 fail，另有 47 条测试间未处理错误（都在有超时的文件里，是超时用例残留的异步收尾）。79 条 fail 里 78 条是超时：67 条撞默认
  5 秒；5 条撞用例自带的 30 秒（`rfc300` 真 Webhook 工作区清理、`rfc354` 嵌套帧闭包、`rfc363` 目录分页、`rfc395-v3` 内联行流式暂存、`rfc400`
  协作参与者的别名检测）；2 条撞 20 秒（`clarify-review-combination-scenarios`、`rfc354` loop-in-loop）；`rfc395-v1` 撞 40 秒；
  `rfc370-committed-architecture-source` 撞 150 秒；`rfc294-architecture-preflight` 撞 180 秒；`rfc376-report` 撞 300 秒（跑了 371 秒）。余下 1 条
  是导出仓库只有候选提交所致的 `rfc321` 发布账本。
  - 复跑 252 个文件（全量里失败的 38 个文件——导出里恒红的 `rfc321` 除外——加全部 139 个架构测试与改到的 79 个用例；30 秒时限）：
    250 个全过（含新增的 RFC-470 用例、改到的用例与全部 139 个架构测试），合计 2516 pass / 2 fail（与 PostgreSQL lane 同时跑，负载 38～83），
    余下 RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`，读到 `running`）与 `rfc363` 目录分页（撞自带的 30 秒）。对照：同一时刻在
    RFC-469 的导出仓库里跑同一文件（负载 79～86），`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.69 s 与 5.66 s），`rfc363` 目录分页两边
    都是 3 pass / 1 fail、同一例到点（30.40 s 与 30.48 s）。
- **导出仓库接 PostgreSQL 真库**：一条 lane 447 个文件（全部 139 个架构测试；改到的用例；经用例 helper 的 import 闭包取到改动的生产文件或按
  路径读它们的 261 个用例——工作流读写与校验、任务启动与工作流同步、定时任务、启动资源适配器的消费方等）：389 个文件全过，合计 5184 pass /
  162 fail / 4 skip（与全量 SQLite 及其复跑同时跑，负载 38～86）。58 个文件失败：55 个只有超时；另 3 个是导出仓库所致的 `rfc321`、
  `retry-cascade-kind-matrix` 的 PostgreSQL 一侧（首例撞 5 秒后连接池接连报 `Idle timeout reached after 30s` 与服务器端的
  `idle-in-transaction timeout`，其后各例连锁失败）与 `rfc359-w14` legacy mission 真执行的 PostgreSQL 一侧（agent 那一例撞用例自带的 25 秒
  终态回调等待，跑了 43.8 秒；同文件的 script 一例 39.5 秒通过）。
  - 复跑 263 个文件（lane 失败的 57 个——导出里恒红的 `rfc321` 除外——加与 SQLite 复跑清单重合的 224 个，其中 18 个两边都有；
    30 秒时限）：260 个全过（含 lane 里连锁失败的 `retry-cascade-kind-matrix`、自带等待到点的 `rfc359-w14`、新增的 RFC-470 用例与改到的
    用例），合计 3223 pass / 5 fail / 4 skip（负载 18～31），余下 3 个文件 5 例，都撞用例自带的计时：`lifecycle-property` 的 PostgreSQL 一侧
    3 例撞 15 秒、`rfc359-w9` 一例撞 10 秒，以及与 SQLite 同一例的 RFC-167 `approve`。对照：同一时刻在 RFC-469 的导出仓库里逐个跑这 3 个
    文件（负载 22～48），`lifecycle-property` 两边都是 3 pass / 3 fail、同样 3 例到点，`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.53 s
    与 5.51 s），`rfc359-w9` 两边都是 25 pass / 1 fail、同一例到点（10.24 s 与 10.20 s）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期
  （0 failures）；PostgreSQL 等负载降到 22.0 / 38.3 才放行，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件的哈希
  一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，加 RFC-470
  用例）：12 个文件全过（100 pass / 0 fail）
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c469 → c470）：`R1-inbound-module-internals` 66 → 64、
  `R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`legacy-thin-facades` 2 → 0、`legacy-service-implementations` 63 → 62、
  `legacy-horizontal-files` 185 → 182、`export-star-barrels` 3 → 1、`services/` 的 TS 文件 64 → 61、facade 记录 65 → 62、后端生产文件 3182 → 3180
  （删五个、新增三个）；跨 context 内部文件对 46 → 43、跨 context import 记录 7824 → 7819、模块符号归属 32225 → 32230；public surface 1497、
  偏差 94、未被消费的 public 符号 322 不变，capability 归属清单逐条相等（字段级消费方记录随之变两处：resource-catalog
  `TaskExecutionWorkflowSnapshot` 少了已删的 `taskLaunchGate`；knowledge-evolution `FusionEngineTaskOperations` 的 `workflowId` 字段多记
  `providerRuntime` 一条——报告按字段名在消费方文件里做文本匹配，`providerRuntime` 新增的 `readWorkflow` 转接参数名是 `workflowId`）；写入口
  清单 2351、不可达生产文件 18、off-DAG offered 文件对 55、`module-layer-violations` 1、off-DAG 值边 0、平台 → 模块 0 不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（TypeScript AST 取顶层声明，`4d63ca40c` 对工作树）：迁入 resource-catalog 的 `composeAgentLaunchResourceOperations` 与
  `assertWorkflowSnapshotLaunchable` 与原文件逐字相同；`createAgentLaunchResourceOperations` 只多出 `readWorkflow` 那一行；resource-catalog 写的
  端口同形类型对 HEAD 的端口只多出本 RFC 补的三处（`code`、`frozenClosureJson`、`readWorkflow`）。改动的 7 个生产文件里 112 个顶层声明逐字未变，
  13 处差异都是本 RFC 的改动（路由依赖与两处读行改经 `readWorkflow`、同步预览注入校验、`PLUGIN_DISABLED_SITES` 的锚点、端口的三处补充）。
- 行为：`readWorkflow` 就是被替换的 `getWorkflow`（同一个库句柄，不判可见性，两个错误码的区分不变）；同步预览的校验是同一份
  `validateWorkflowDef(definition, await loadWorkflowValidationContext(db, candidate))`（`buildWorkflowValidationContext` 是它的别名），候选照旧带冻结
  调用闭包；快照校验门函数体不变；装配根注入的是同一份启动资源（`composeAgentLaunchResourceOperations({ db })`）。
- 用例：78 个用例与 helper 文件（70 个用例、8 个 helper）只改 import 语法（否定锁的字面量不动）；伪造端口或路由依赖的 5 个用例补
  `readWorkflow`（其中「不读工作流行」的那一例用抛错的桩把原意锁住）；读源码的锁改读新位置，断言不动。
- 账本：`R1` 66 → 64（实测与账本逐条相等，`R2` 0）；public surface 偏差 94、capability 归属清单逐条相等；RFC-345 兼容登记表清零；跨 context
  文件对清单、export-star 基线与 RFC-454 / RFC-466 / RFC-359 W58 / RFC-165 / RFC-271 的锁随之改；guard-manifest 刷新三个守卫文件的行数。

## CI（AC-4）

- `acb919d09`（本 RFC 的提交）：主 CI run 42473199829 有四格红。①Lint 腿的 shared 用例（windows-platform run 42473199780 的 Shared
  package suite 同因红）：`packages/shared/tests/wrapper-kind-single-source.test.ts` 按路径读已删的 `services/workflow.validator.ts`
  （ENOENT）——本 RFC 的缺陷（用例改指脚本与集中验证都只覆盖了 backend），由 `1a73472b7` 改读 validator 定义处修复（shared 全量 2344 pass /
  0 fail，Lint 腿因此跳过的 system mock 用例本地 111 pass / 0 fail）。②Markdown link check：6 条错误都在 `design/RFC-371-run-observability`
  的两个文档里，指向另一仓库 Actions run 的外链被 GitHub 回 504 / 502。③Backend tests shard 16/44：`rfc311-perf-guards` 的 PostgreSQL 一侧
  「task-operations catalog — 过滤视图（G1 快路径）」在连接上等到 `Idle timeout reached after 30s`（89 s），同文件其余 PostgreSQL 路径正常；
  前两个提交（`4d63ca40c` / `e9fb623f8`）同一分片同一用例通过（P95 35.45 ms / 11.30 ms），本地同一时刻在 RFC-470 与 RFC-469 两份导出仓库里
  接 PostgreSQL 跑这个文件，两边都是 24 pass / 1 fail、同一例红在 AC-11 塌方探测（P95 9178.66 ms 与 9074.12 ms，SQLite 46.70 ms 与
  45.75 ms）——慢计划先于本 RFC、CI 上间歇出现，本 RFC 不触及任务目录的读路径，归属不明，未改。④「CI required」汇总格随之红。其余 66 个
  job、git-protocols-e2e run 42473199795 与 integration-opencode run 42473199805 通过。
- `1a73472b7`（修复提交，后继证据：父提交即 `acb919d09`，候选内容原样保留）：主 CI run 42476792248 的 67 个 job 通过（含 Lint 腿与全部
  backend 分片，shard 16/44 这次通过），余下两格是 GitHub release 下载失败——actionlint 拿到非 gzip 内容、lychee 的 curl 退出 22，两项检查
  都没执行（这次提交不改 workflow、脚本与 design 文档；`acb919d09` 上 actionlint 通过、lychee 只红在 RFC-371 的外链），「CI required」随之红；
  未重跑。windows-platform 的 push 触发路径不含这次改动，手动派发 run 42479766547：通过（含 Shared package suite）。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 5 个 Done 文档文件）的导出仓库上重跑上述文档用例：12 个文件全过（100 pass / 0 fail），读文档的两个用例在最终文本上复跑通过。

## PR / 提交

单个提交：`refactor(backend): RFC-470 退役最后两个薄转出与 taskLaunchGate：任务启动资源适配器归 resource-catalog（RFC-294 W9-D 第十七步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
