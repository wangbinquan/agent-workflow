# RFC-469 实施计划

**前置**：RFC-468 落地（`7499f4b1b`，Done 文档 `50e6cb0f9`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中
验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                               | 依据          |
| ---------- | ---------------------------------------------------------------------------------- | ------------- |
| RFC-469-T1 | 删除 `services/taskAuthorization.ts`：去掉空导入，用例改取定义处                   | design §1     |
| RFC-469-T2 | 删除 `services/sessionEventSink.ts`：runtime-management public 补转出，消费方改取  | design §2     |
| RFC-469-T3 | 删除 `services/execution/taskExecutionCallClosure.ts`：函数并入 `services/task.ts` | design §3     |
| RFC-469-T4 | 精确清单、账本与 guard-manifest；新增 RFC-469 用例，受影响用例改指                 | design §4、§5 |
| RFC-469-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI              | design §7     |
| RFC-469-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                    | —             |

## 验收清单

- [x] AC-1 三个文件不在、零引用；会话 sink 类型的消费方取 runtime-management public；`freezeTaskExecutionCallClosure` 并入 `services/task.ts`
- [x] AC-2 架构计数按实测（`R1` 71 → 66），越界类计数、public surface 偏差与未被消费的 public 符号不升
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-07，候选基于 `50e6cb0f9`）

本机全程高负载（采样到的负载 16～91；本机另有常驻负载：一个本地虚拟机约 6 核、三个挂起的测试夹具进程各约 1 核）。验证都在候选导出仓库里跑
（`50e6cb0f9` 的 `git archive` 加候选路径，提交后运行；修复与文档改动后重新同步，核对与 HEAD 加候选逐字相同）。集中验证查出本 RFC 的四处
问题，都已修复并复验：

1. memory 的两个蒸馏文件第一版直取 runtime-management `public/participants`：off-DAG offered 文件对 55 → 57（架构报告与全量里的
   `rfc294-review-offered-edge-dag`、`rfc376-structural-guards` 同时报出）。改为经 memory 自己的蒸馏端口取（design §2），复测回到 55。
2. 删去 `services/task.ts` 的空导入后，task-execution `infrastructure/legacySqliteTaskAuthorization.ts` 生产不可达：不可达生产文件 18 → 19
   （同样两处报出）。原样迁入 `tests/helpers/`（design §1），复测回到 18。
3. `rfc345-resource-catalog-contracts` T4a 的「`services/task.ts` 不直接调 `freezeCallClosure(`」撞上并入的函数体：按原意改写（design §3）。
4. RFC-469 用例的负对照：census `importEdges` 不给 `import {} from` 出边，零引用判据改用 TypeScript `preProcessFile`（design §5）。

- **静态**（修复后的候选）：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（17 个改动的 TS 文件，加
  `eslint.promises.config.js` 覆盖的 src）；`depcheck` 分层门通过（4425 个模块）；改动的 TS 与 RFC-469 文档已按 prettier 格式化。
- **声明逐个比对**：见实现门。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 3 小时；跑的是修复前的候选）：四片 6403 / 5439 / 6206 / 6049 s 全部跑完，
  合计 23521 pass / 127 skip / 70 fail，另有 37 条测试间未处理错误（都是超时用例残留的异步收尾）。70 条 fail 里 63 条是超时：57 条撞默认
  5 秒；3 条撞用例自带的 30 秒（`rfc300` 真 Webhook 工作区清理、`rfc354` 嵌套帧闭包、`rfc363` 目录分页）；`lifecycle-property` 撞 15 秒；
  `rfc370-committed-architecture-source` 撞 150 秒；`rfc376-report` 撞 300 秒（跑了 608 秒）。其余 7 条：上面的问题 1、2（`rfc376-structural-guards`
  3 条、`rfc294-review-offered-edge-dag` 1 条），问题 3、问题 4 各 1 条，以及导出仓库只有候选提交所致的 `rfc321` 发布账本。
  - 修复后复跑 211 个文件（全量里失败的 31 个文件——导出里恒红的 `rfc321` 除外——加全部 139 个架构测试、改到的用例，以及直接取改动件或
    runtime-management `public/participants` 的用例；30 秒时限）：209 个全过（含新增的 RFC-469 用例、改到的用例与全部 139 个架构测试），
    合计 2038 pass / 2 fail（与 PostgreSQL 复跑同时跑，负载 33～74），
    余下 RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`，读到 `running`）与 `rfc363` 目录分页（撞自带的 30 秒）。对照：同一时刻在
    RFC-468 的导出仓库里跑同一文件（负载 31～33），`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.81 s 与 5.82 s），`rfc363` 目录分页两边
    都是 3 pass / 1 fail、同一例到点（30.40 s 与 30.38 s）。
- **导出仓库接 PostgreSQL 真库**（修复前的候选）：一条 lane 416 个文件（全部 139 个架构测试；改到的用例；直接或经用例 helper 取改动件的用例——
  任务授权与徽标计数、系统代理运行与会话捕获、记忆蒸馏的会话 sink 与工作存储、任务启动与调用闭包冻结、`services/task.ts` 的消费方等）：
  344 个文件全过，合计 4965 pass / 295 fail / 4 skip（与全量 SQLite 同时跑，负载 30～63）。72 个文件失败：66 个只有超时；另 6 个里 4 个是上面的
  问题 1～4，余下 `retry-cascade-kind-matrix` 的 PostgreSQL 一侧（首例撞 5 秒后连接池接连报 `Idle timeout reached after 30s` 与服务器端的
  `idle-in-transaction timeout`，其后各例连锁失败）与 `rfc238-mcp-runtime-test-service` 的 PostgreSQL 一侧（用例自带的条件等待到点与 5 秒
  超时之后的连锁断言）。
  - 修复后复跑 227 个文件（lane 失败的 72 个，加与 SQLite 复跑清单重合的 178 个；30 秒时限，与 SQLite 复跑同时跑）：
    224 个全过（含 lane 里连锁失败的 `retry-cascade-kind-matrix` 与 `rfc238-mcp-runtime-test-service`、新增的 RFC-469 用例与改到的用例），
    合计 2883 pass / 5 fail（负载 30～74），余下 3 个文件 5 例，都撞用例自带的计时：`lifecycle-property` 的 PostgreSQL 一侧 3 例撞 15 秒、
    `rfc359-w9` 一例撞 10 秒，以及与 SQLite 同一例的 RFC-167 `approve`。对照：同一时刻在 RFC-468 的导出仓库里逐个跑这 3 个文件（负载
    30～91），`lifecycle-property` 两边都是 3 pass / 3 fail、同样 3 例到点，`rfc167` 两边都是 28 pass / 1 fail、同一例到点，`rfc359-w9` 两边
    都是 25 pass / 1 fail、同一例到点（10.54 s 与 10.46 s）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑；修复前的候选——之后的改动只有 memory 的类型 import、
  迁出生产树的不可达文件、用例与文档，都不是 17 个阶段改写的文件或判定用例）：SQLite 17 个阶段全部符合预期（0 failures）；PostgreSQL 等负载降到
  24.3 / 37.6 才放行，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件的哈希一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里（修复后的候选）10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，加 RFC-469
  用例）：12 个文件全过（97 pass / 0 fail）
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c468 → c469 修复后）：`R1-inbound-module-internals` 71 → 66、
  `R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`legacy-service-implementations` 65 → 63、`legacy-horizontal-files` 188 → 185、
  `legacy-thin-facades` 3 → 2、`services/` 的 TS 文件 67 → 64、facade 记录 68 → 65、后端生产文件 3186 → 3182（删三个转出、迁出一个不可达文件）；
  public surface 1496 → 1497（runtime-management `public/participants` 转出 `SessionCaptureTerminalState`）、偏差 94 不变，未被消费的 public 符号
  322 → 322，capability 归属清单逐条相等；跨 context import 记录 7840 → 7824、模块符号归属 32237 → 32225、写入口清单 2351 不变；跨 context
  内部文件对 46、不可达生产文件 18、off-DAG offered 文件对 55、`module-layer-violations` 1、off-DAG 值边 0、平台 → 模块 0 不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（TypeScript AST 取顶层声明，`50e6cb0f9` 对工作树）：并入 `services/task.ts` 的 `freezeTaskExecutionCallClosure` 与迁入
  `tests/helpers/` 的旧 SQLite 任务授权（6 个声明）与原文件逐字相同；改动的 7 个生产文件里 86 个顶层声明逐字未变，0 处差异（改动只在 import、
  runtime-management `public/participants` 的一行类型转出与 memory 蒸馏端口的类型转出）。
- 行为：删除的空导入不取任何名字、被导入的文件没有副作用；会话 sink 类型是同一份定义（`agentSessionEvents`），只是改经 public 入口或同模块
  端口取；并入的函数同名、同参、同函数体，唯一的调用点不变；迁入用例树的授权函数生产零调用方。
- 用例：改到的用例只改 import 或读的位置；唯一改写的断言是 RFC-345 T4a 的否定锁，按原意改成「除并入的那一份函数体外不直接调
  `freezeCallClosure(`」（多出第二份同样红）；RFC-469 用例的零引用判据用 `preProcessFile`，负对照覆盖空 `import {}`、动态 import 与注释。
- 账本：`R1` 71 → 66（实测与账本逐条相等，`R2` 0）；public surface 偏差 94、capability 归属清单逐条相等；RFC-349 provider 切换债务销账两条、
  RFC-359 W5 provider 命名文件债务销账一条；guard-manifest 刷新改到的守卫文件行数。

## CI（AC-4）

- `e9fb623f8`：exact SHA 主 CI run 42457010625 首轮全绿（70 个 job），windows-platform run 42457010690、integration-opencode run 42457010702 与 git-protocols-e2e run 42457010626 通过。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 5 个 Done 文档文件）的导出仓库上重跑上述文档用例：12 个文件全过（97 pass / 0 fail）。

## PR / 提交

单个提交：`refactor(backend): RFC-469 退役三个薄转出：taskAuthorization、sessionEventSink、taskExecutionCallClosure（RFC-294 W9-D 第十六步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
