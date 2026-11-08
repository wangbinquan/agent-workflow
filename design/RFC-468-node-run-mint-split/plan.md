# RFC-468 实施计划

**前置**：RFC-467 落地（`40bc62047`，Done 文档 `4e4b93b95`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中
验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                             | 依据          |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------- |
| RFC-468-T1 | 冻结运行时迁入 runtime-management，窄端口归 runtime-management，绑定改取                         | design §1     |
| RFC-468-T2 | 铸行入口迁入 task-execution infrastructure，经 `public/operations` 转出；`services/task.ts` 改取 | design §2     |
| RFC-468-T3 | 澄清血缘判定归 `domain/clarifyRules`，副本与零调用方导出删除，`services/nodeRunMint.ts` 删除     | design §3     |
| RFC-468-T4 | 精确清单、账本、commons 内核与 guard-manifest；新增 RFC-468 用例，受影响用例改指                 | design §4、§5 |
| RFC-468-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                            | design §7     |
| RFC-468-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                  | —             |

## 验收清单

- [x] AC-1 `services/nodeRunMint.ts` 不在、零引用；冻结运行时在 runtime-management 且只取自己的窄端口；铸行入口经 task-execution
      `public/operations`；澄清血缘判定在 `domain/clarifyRules`；`schedulerMintCause` 只有一份
- [x] AC-2 架构计数按实测（`R1` 79 → 71、跨 context 内部文件对 47 → 46），越界类计数、public surface 偏差与未被消费的 public 符号不升
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-07，候选基于 `4e4b93b95`）

本机全程高负载（采样到的负载 20～77；本机另有常驻负载：一个本地虚拟机约 6 核、三个挂起的测试夹具进程各约 1 核）。验证都在候选导出仓库里跑
（`4e4b93b95` 的 `git archive` 加候选路径，提交后运行；文档改动后重新同步，核对与 HEAD 加候选逐字相同）。集中验证没有查出本 RFC 的问题。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`，RFC-468 用例的两条编译期锁随之生效）；eslint `--max-warnings 0` 无告警（39 个改动的
  TS 文件，加 `eslint.promises.config.js` 覆盖的 src）；`depcheck` 分层门通过（4428 个模块）；改动的 TS 与 RFC-468 文档已按 prettier 格式化。
- **声明逐个比对**：见实现门。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片；吸取 RFC-467 的教训把分片时限放到 3 小时）：四片 6901 / 6616 / 7186 / 7148 s
  全部跑完，合计 23510 pass / 127 skip / 75 fail，另有 48 条测试间未处理错误（都是超时用例残留的异步收尾）。75 条 fail 里 72 条是超时：
  65 条撞默认 5 秒；4 条撞用例自带的 30 秒（`rfc321` 真 smart-HTTP、`rfc354` 嵌套帧闭包、`rfc363` 目录分页、`rfc395` v3 内联行流式暂存）；
  组合场景 S-RFC074 撞 20 秒；`lifecycle-property` 撞 15 秒；`rfc376-report` 撞 300 秒（跑了 675 秒）。其余 3 条：导出仓库只有候选提交所致的
  `rfc321` 发布账本、`rfc363` 任务工作区进程恢复一例（子进程没在时限内到达检查点）、`rfc310` 数字员工 system mock 端到端一例（种子请求撞
  `ECONNRESET`）。改到的 26 个用例里 25 个通过（含新增的 RFC-468 用例），余下的 `rfc328-architecture-guards` 只有一例与本 RFC 无关的 5 秒
  超时（RFC-402/403 边界判据，8.8 s）。
  - 复跑 36 个失败文件（导出里恒红的 `rfc321` 除外；30 秒时限）：33 个全过（含改到的 `rfc328-architecture-guards`），合计 310 pass / 3 fail（与 PostgreSQL lane 同时跑，负载 39～72），余下 RFC-167
    dw-confirm 的 `approve`（自带 5 秒 `settleTask`，读到 `running`）、`rfc363` 目录分页（撞自带的 30 秒）与 `rfc363` 任务工作区进程恢复一例
    （子进程没在时限内到达 `prepared-before-upload` 检查点，30.6 s）。对照：同一时刻在 RFC-467 的导出仓库里跑同一文件（负载 62～77），
    `rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.63 s 与 5.60 s），`rfc363` 目录分页两边都是 3 pass / 1 fail、同一例到点（30.47 s 与
    30.41 s），`rfc363` 进程恢复两边都 8 / 8 通过。
- **导出仓库接 PostgreSQL 真库**：一条 lane 463 个文件（全部 139 个架构测试；改到的 26 个用例；直接或经用例 helper 取改动件的用例——铸行、
  冻结运行时与运行时绑定、澄清血缘与 rerun cause、`public/operations` 与 `services/task.ts` 的消费方等）：390 个文件全过，合计 5545 pass /
  372 fail / 4 skip（与全量 SQLite 同时跑，负载 41～77）。RFC-468 用例通过。73 个文件失败：72 个只有超时；另 1 个是
  `retry-cascade-kind-matrix` 的 PostgreSQL 一侧——首例撞 5 秒后连接池接连报 `Idle timeout reached after 30s` 与服务器端的
  `idle-in-transaction timeout`，其后各例连锁失败（同文件 SQLite 一侧 21 例全过）。
  - 复跑：73 个失败文件（30 秒时限，lane 跑完之后单独跑）：69 个全过（含 `retry-cascade-kind-matrix`），合计 1287 pass / 8 fail（负载 23～36），
    余下 4 个文件 8 例，都撞用例自带的计时：`lifecycle-property` 的 PostgreSQL 一侧 3 例撞 15 秒、`rfc395-a3-oracle-evidence` 的 PostgreSQL
    一侧 3 例撞 10 秒、`rfc359-w9` 一例撞 10 秒，以及与 SQLite 同一例的 RFC-167 `approve`。对照：同一时刻在 RFC-467 的导出仓库里逐个跑这 4 个
    文件（负载 28～37），`lifecycle-property` 两边都是 3 pass / 3 fail、同样 3 例到点，`rfc167` 两边都是 28 pass / 1 fail、同一例到点，`rfc359-w9`
    两边都是 25 pass / 1 fail、同一例到点（10.21 s 与 10.23 s），`rfc395-a3-oracle-evidence` 本 RFC 11 pass / 2 fail、RFC-467 10 pass / 3 fail
    （同一组用例撞 10 秒）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期
  （0 failures）；PostgreSQL 等负载降到 26.7 / 34.8 才放行，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件的哈希
  一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，加 RFC-468
  用例）：12 个文件全过，合计 98 pass / 0 fail（负载 25～63；`rfc376-report` 16 / 16，69.3 s）
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c467 → c468）：`R1-inbound-module-internals` 79 → 71、
  `R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；跨 context 内部文件对 47 → 46（runtime-management → task-execution 那一对）；
  `legacy-service-implementations` 66 → 65、`legacy-horizontal-files` 189 → 188、`services/` 的 TS 文件 68 → 67、facade 记录 69 → 68、后端生产
  文件 3184 → 3186（删一加三）；public surface 1495 → 1496（`public/operations` 转出 `mintNodeRun`）、偏差 94 不变，未被消费的 public 符号
  322 → 322，capability 归属清单逐条相等；跨 context import 记录 7855 → 7840、模块符号归属 32243 → 32237、写入口清单 2351 不变；不可达生产
  文件 18、off-DAG offered 文件对 55、`module-layer-violations` 1、off-DAG 值边 0、平台 → 模块 0 不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（TypeScript AST 取顶层声明，`4e4b93b95` 对工作树）：迁出的 9 个顶层声明里 6 个逐字未变，3 处差异都是预期的——冻结运行时两个
  入口的 `persistence` 参数类型由 task-execution 端口改为 runtime-management 的窄端口，`mintNodeRun` 的参数类型由 `MintNodeRunArgs` 改为端口的
  `NodeRunMintInput`；改动的 8 个生产文件里 50 个顶层声明逐字未变，2 处差异都是预期的——任务运行时绑定工厂入参的 `persistence` 类型，
  `NodeRunMintInput` 只多了字段说明注释；`clarifyRules.ts` 新增的是迁入的 `continuesClarifyLineage`。
- 行为：冻结算法与铸行入口的函数体逐字不变；窄端口与 task-execution 端口的字段逐一相同，组合层交接由编译器按结构检查（RFC-468 用例另有编译期
  锁）；`continuesClarifyLineage`、`schedulerMintCause` 留下的都是生产在用的那一份；删除的导出全仓零调用方（census AST 核过，含动态 import）。
- 账本：`R1` 79 → 71（实测与账本逐条相等，`R2` 0）；public surface 偏差 94、capability 归属清单逐条相等；跨 context 内部文件对的两份精确清单
  各去掉一对；guard-manifest 刷新三个守卫文件的行数。

## CI（AC-4）

- `7499f4b1b`：exact SHA 主 CI run 42441460537 首轮全绿（70 个 job，含上一提交偶发红的 macOS e2e 第 3 片），windows-platform run 42441460457 与 git-protocols-e2e run 42441460459 通过。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 5 个 Done 文档文件）的导出仓库上重跑上述文档用例：12 个文件全过，合计 98 pass / 0 fail（负载 16～21），读文档的两个用例在最终文本上复跑通过。

## PR / 提交

单个提交：`refactor(backend): RFC-468 拆分 nodeRunMint：冻结运行时归 runtime-management、铸行入口归 task-execution（RFC-294 W9-D 第十五步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
