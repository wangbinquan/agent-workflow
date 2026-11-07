# RFC-467 实施计划

**前置**：RFC-466 落地（`b29152824`，Done 文档 `450e480d2`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中
验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                 | 依据          |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-467-T1 | 预言与 `agentDeps` / `mcpClosure` / `pluginClosure` 原样迁入 `tests/helpers/`；两个 `export *` facade 删除；用例改取 | design §1     |
| RFC-467-T2 | 策略束与 resource-catalog 端口只留外部策略；适配器直接取 resource-catalog 自己的两个函数                             | design §2     |
| RFC-467-T3 | 精确清单、账本与 guard-manifest；新增 RFC-467 用例                                                                   | design §3、§4 |
| RFC-467-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                | design §6     |
| RFC-467-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                      | —             |

## 验收清单

- [x] AC-1 六个文件不在 src、零引用；预言与三个实现在 `tests/helpers/`；策略束与端口只剩四个外部策略字段
- [x] AC-2 架构计数按实测（`R1` 86 → 79），越界类计数、public surface 偏差与未被消费的 public 符号不升
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-07，候选基于 `450e480d2`）

本机全程高负载（采样到的负载 20～79；本机另有常驻负载：一个本地虚拟机约 6 核、三个挂起的测试夹具进程各约 1 核）。验证都在候选导出仓库里跑
（`450e480d2` 的 `git archive` 加候选路径，提交后运行；修正后重新同步，核对与 HEAD 加候选逐字相同）。**集中验证查出本 RFC 的一处问题，已修正
并复验**：预言迁走后，resource-catalog `public/queries` 转出的 `validateAgentDependencies` 失去唯一的模块外读者 `services/agentDeps`
（架构报告实测未被消费的 public 符号 322 → 323）。按 RFC-294 design §3.3 当场收回（proposal G4、design §2a）：退出 `public/queries`，用例
helper `agentDeps` 与 RFC-395 A5 引用端口用例改取定义处，RFC-467 用例加断言它不在 `public/queries`；收回后未被消费的 public 符号回到
322、public surface 1496 → 1495。

- **静态**（最终候选上复跑）：backend `tsc` 0 错；eslint `--max-warnings 0` 无告警（backend 与 `eslint.promises.config.js`，后者只覆盖
  src）；`depcheck` 分层门通过（4426 个模块）；改动的 TS 与 RFC-467 文档已按 prettier 格式化。
- **声明逐个比对**（最终候选，`450e480d2` 对工作树）：迁出的四个文件 20 个顶层声明里 19 个逐字未变、1 处预期差异；改动的 6 个生产文件里
  34 个顶层声明逐字未变、6 处预期差异；resource-catalog `public/queries` 只去掉一行转出（见实现门）。
- **全量 SQLite**（第一版候选，即上面的修正之前；导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：第 1、2、4 片 7107 / 6715 /
  6379 s 跑完，合计 16965 pass / 79 skip / 50 fail，另有 27 条测试间未处理错误（都在超时的文件里，是超时后残留的异步收尾）。第 3 片在负载
  67～79 下撞到 2 小时时限被终止：此前已报约 6000 条 pass / skip 与 18 条 fail；bun 随机化文件顺序，未跑到的是哪些文件无从得知，于是第 3 片
  分到的 729 个文件全部在最终候选上复跑（按 bun 的「路径排序后轮转」分片规则重建，四片日志里 51 个失败文件的归属全部吻合）。68 条 fail 里
  66 条是超时：55 条撞默认 5 秒；5 条撞用例自带的 30 秒（`rfc300` webhook 工作区清理、`rfc321` 真 smart-HTTP、`rfc354` 嵌套帧闭包、
  `rfc363` 目录分页、`rfc395` epoch-1 备份）；`rfc098` 两条与 `rfc354` 循环套循环一条撞 20 秒；`rfc370` 提交态架构源一条撞 150 秒；
  `rfc294-architecture-preflight` 的 capability 归属用例撞 180 秒（跑了 483 秒）；`rfc376-report` 撞 300 秒。其余 2 条：导出仓库只有候选
  提交所致的 `rfc321` 发布账本、组合场景 S-RFC074（20 秒后读到 `canceled`，RFC-466 的全量里也出现过）。RFC-467 用例（第一版）通过。
  - 复跑 868 个文件（最终候选；第 3 片的 729 个文件，加其余分片的失败文件——导出里恒红的 `rfc321` 除外——、G4 波及的 14 个用例与全部 139 个
    架构测试，去重；30 秒时限）：866 个全过（第 3 片的 729 个文件全过；含 RFC-467 用例、`rfc294-architecture-preflight`、`rfc376-report`、RFC-376 结构守卫与 G4
    波及的用例），合计 7907 pass / 2 fail / 49 skip（负载 24～67），余下 RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`，读到
    `running`）与 `rfc363` 目录分页（撞自带的 30 秒）——与 RFC-462～466 复跑后余下的两例相同。对照：同一时刻在 RFC-466 的导出仓库里跑同一
    文件（负载 25～30），`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.99 s 与 5.94 s），`rfc363` 两边都是 3 pass / 1 fail、同一例
    到点（30.38 s 与 30.39 s）。
- **导出仓库接 PostgreSQL 真库**（第一版候选）：一条 lane 353 个文件（全部架构测试；改动的用例；注入解析与依赖闭包、MCP / 插件闭包、技能
  启动校验、任务执行资源快照、启动与执行宿主等取改动件或其消费方的用例）：308 个文件全过，合计 3556 pass / 124 fail / 4 skip（与全量
  SQLite 同时跑）。RFC-467 用例（第一版）通过。45 个文件失败：42 个只有超时；另 3 个是 MCP 测试台 `rfc238-mcp-runtime-test-service`（用例
  自带的 2 秒轮询等待到点，另有 5 秒超时）、真实进程多轮夹具 `rfc238-mcp-runtime-test-real-e2e`（第二轮时会话已结束）与 `rfc359-w14`
  旧任务真实执行（用例自带的 25 秒回调计时到点，该例跑了 39 秒）。
  - 复跑 55 个文件（最终候选；45 个失败文件加 lane 里 G4 波及的 10 个文件；30 秒时限，与 SQLite 复跑同时跑）：46 个全过（含 RFC-467 用例与 G4 波及的 lane 文件），合计 805 pass / 11 fail，余下 9 个文件 11 例，都是用例自带的计时到点：`rfc400`
    静态检查一例撞 30 秒（跑了 36.8 s）、`rfc300` 与 `rfc354` 各一例撞 30 秒、`rfc310` 两例撞 180 秒、`rfc359-w9` 一例撞 10 秒、
    `rfc359-w14` 一例的 25 秒回调计时到点、MCP 测试台两例的 2 秒轮询等待到点、真实进程多轮夹具一例在第二轮时会话已结束，以及与 SQLite
    同一例的 RFC-167 `approve`（与 SQLite 复跑同时跑，负载一度到 67）。对照：同一时刻在 RFC-466 的导出仓库里逐个跑这 9 个文件（负载
    25～39），7 个两边都全过（`rfc400`、`rfc300`、`rfc354`、`rfc359-w14`、`rfc310` 与 MCP 测试台的两个文件），`rfc167` 两边都是
    28 pass / 1 fail、同一例到点（5.62 s 与 5.56 s），`rfc359-w9` 两边都是 25 pass / 1 fail、同一例撞 10 秒（10.44 s 与 10.37 s）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，第一版候选，两引擎分开跑）：SQLite 17 个阶段全部符合预期
  （0 failures）；PostgreSQL 等负载降到 20.0 / 38.5 才放行，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件的哈希
  一致、导出仓库工作树干净。G4 改到的文件都不在 P0 的受保护文件之内。
- **RFC-321 发布账本**：工作树里 10 / 10（最终候选；导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，加 RFC-467
  用例）：12 个文件全过，合计 96 pass / 0 fail（负载 18～23；`rfc376-report` 16 / 16，67.0 s）
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c466 → c467 最终候选）：`R1-inbound-module-internals`
  86 → 79、`R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`export-star-barrels` 5 → 3、`legacy-thin-facades` 5 → 3、
  `legacy-service-implementations` 69 → 66、`legacy-horizontal-files` 194 → 189、不可达生产文件 24 → 18（迁出与删除的六个文件）、
  `services/` 的 TS 文件 73 → 68、后端生产文件 3190 → 3184；public surface 1496 → 1495（收回 `validateAgentDependencies`）、偏差 94
  不变，未被消费的 public 符号 322 → 322，capability 归属清单 18 条逐条相等；跨 context import 记录 7886 → 7855、模块符号归属
  32269 → 32243、facade 记录 74 → 69、写入口清单 2351 不变；跨 context 内部文件对 47、off-DAG offered 文件对 55、
  `module-layer-violations` 1、off-DAG 值边 0、平台 → 模块 0 不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（TypeScript AST 取顶层声明，`450e480d2` 对工作树）：迁出的四个文件 20 个顶层声明里 19 个逐字未变，唯一差异是预言
  `resolveInjection` 的两处 `.map(...)` 改为直接取策略束原先转出的那两个行映射器（`mcpFromPersistenceRow` / `pluginFromPersistenceRow`，
  同一个函数）；改动的 6 个生产文件里 34 个顶层声明逐字未变，6 处差异都是预期的：resource-catalog 端口去掉三个字段、适配器两处改为直接取
  自己的 `assertNotBuiltin` / `isSkillInjectableThisBoot`（调用参数不变）、策略束去掉六个字段、两段 task-execution 文档注释改写、
  `PLUGIN_DISABLED_SITES` 的任务执行产出点改指 resource-catalog 适配器（预言已离开生产树）。resource-catalog `public/queries` 只去掉 `validateAgentDependencies` 一行转出（G4）。
- 行为：适配器调用的是同一个函数（策略束原先就是把这两个 resource-catalog 函数转进来），没有用例注入替身（全仓核过）；预言与三个实现只被
  用例调用（生产不可达，迁移前 src 里的 importer 只有预言自己）；两个技能转出只是 `export *`。
- 账本：`R1` 86 → 79（实测与账本逐条相等，`R2` 0）；public surface 偏差 94、capability 归属清单 18 条逐条相等；RFC-395 表归属债务夹具去掉
  预言的三条；guard-manifest 刷新 RFC-376 结构守卫的行数。

## CI（AC-4）

- `40bc62047`：exact SHA 主 CI run 42421165407 首轮全绿（70 个 job），windows-platform run 42421165437 与 integration-opencode run 42421165408 通过。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 5 个 Done 文档文件）的导出仓库上重跑上述文档用例：12 个文件全过，合计 96 pass / 0 fail（负载 12～22），读文档的两个用例在最终文本上复跑通过。

## PR / 提交

单个提交：`refactor(backend): RFC-467 注入预言一族迁入用例树、资源快照策略束只留外部策略（RFC-294 W9-D 第十四步）`。走私有 index、按路径
清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
