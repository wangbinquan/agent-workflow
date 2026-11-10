# RFC-477 实施计划

**前置**：RFC-476 落地。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证，
开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                    | 依据            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| RFC-477-T1 | 节点回滚：task-execution `domain/nodeRunRollbackOutcome.ts`、`infrastructure/nodeRollback.ts`；collaboration 端口与绑定一格；两边调用方 | design §1       |
| RFC-477-T2 | 资源限额：task-execution 审计端口与 `application/resourceLimitEnforcement.ts`；composition 转出；bootstrap 改取                         | design §2       |
| RFC-477-T3 | agent 启动快照：task-execution `domain/agentHostWorkflow.ts`；public 转出校验；integration 改取                                         | design §3       |
| RFC-477-T4 | 触发预检与停用资源策略：resource-catalog `domain/` 两个文件与 public 转出；全部消费方改取                                               | design §4–§5    |
| RFC-477-T5 | public 收口（撤出失去模块外消费方的符号）                                                                                               | design §1.3、§2 |
| RFC-477-T6 | 用例与账本：受影响用例、源码文本守卫、新增 RFC-477 用例、`R1` 账本、commons-manifest、owner 表、减速带（C13）、注释与文档链接           | design §6       |
| RFC-477-T7 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                      | design §9       |

## 验收清单

- [x] AC-1 五个 `services/` 文件不在、零引用；`R1` 里没有它们
- [x] AC-2 行为不变（回滚、限额、启动快照、触发预检、停用资源处置；collaboration 经端口走同一份实现）
- [x] AC-3 架构计数按实测（`R1` 30 → 27），偏差、未被消费的 public 符号与越界类计数不升；触及的减速带收紧到实测
- [x] AC-4 受影响用例与新增用例全部通过（四个包）
- [x] AC-5 exact SHA CI 全绿：`802a4033b` 主 CI run 42826124457 的 70 个 job 与同一 SHA 的其余 5 个 push workflow 全部通过

## 集中验证（2026-11-09～10，候选基于 `55f21c641`）

本机全程高负载（10 核；另有常驻负载：一台虚拟机约 5.7 核、三个常驻 bun 进程约 3 核；采样到的 1 分钟负载 22～62）。验证都在候选导出
仓库里跑（HEAD 的 `git archive` 加候选路径，提交后运行；修复后重新同步，核对与 HEAD 加候选逐字相同）；对照组是与 HEAD 逐字相同的导出仓库。
验证期间 `origin/main` 未前进。集中验证查出本 RFC 的五处问题（第 1、2 处与第 4 处的后半由计数复核报出，其余由用例报出），都已修复并复验：

1. integration 的定时任务校验原样保留了「惰性动态 import」，改指 task-execution `public/queries` 后，计数器把对整份 public 入口的动态
   import 记成用到了它的全部符号：未被消费的 public 符号 322 → 261（61 个本来无人用的 task-execution 查询符号被这一条边「消费」，计数
   失真）。改为具名静态 import（`validateAgentLaunchShape` 是纯函数、所在模块启动时就已加载；接口仍是 async，调用方不变）。
2. 修正 1 之后复采：未被消费的 public 符号 322 → 323。resource-catalog `public/queries` 的 `parseCallClosure` 模块外唯一的读者是触发预检，
   它迁进 resource-catalog 后改取 domain；撤出它之后其结果类型 `FrozenCallClosure`（`public/types`）也成了无人用的 public 符号，一并撤出。
   `rfc454-services-one-hop-facade-sweep` 与 `rfc466-resource-acl-and-workgroups-facade-retirement` 钉住它仍在 public 的两条断言改为「已撤出」
   （同一编解码的其余出口照旧在），`tests/helpers/legacyCallClosure.ts` 改取 domain 的类型。复采：未被消费的 public 符号 322、偏差 91 都不变。
3. 集中验证首轮里 RFC-317 的三个两向钉死用例（守卫清单与磁盘逐条相等、语料扫描者 / 下限与账本相等、断言不存在 / 负 fixture 与账本相等）
   共 5 例红：新增用例的文件名含 `preflight`，命中 `GUARD_FILE_NAME_PATTERN`，是一条架构守卫，却没登记进 `architecture/guard-manifest.json`。
   按 census 的判据实测字段后登记（扫语料、下限 501、断言不存在、带负 fixture、`ast`；行数随用例定稿刷新为 537）。
4. 同一轮里 `rfc349-execution-peripheral-provider` 红一例：注入 resource-catalog 的策略束 `services/execution/taskExecutionResourceDependencies.ts`
   被锁不取 resource-catalog，而它的插件禁用错误码原经 `services/execution/resourcePolicy.ts` 转手取得，那份文件迁进 resource-catalog 后本
   RFC 让它改取 resource-catalog `public/types`，撞了这把锁。错误码本就是 resource-catalog 的：改为快照适配器直接取定义处，
   `pluginDisabledErrorCode` 退出策略束与它的依赖接口（`rfc467-injection-oracle-relocation` 的外部策略清单同步），报出的错误码不变。
   复采：未被消费的 public 符号又是 322 → 323——`PLUGIN_DISABLED_ERROR_CODE`（resource-catalog `public/types`）模块外唯一的生产取用方就是
   那个策略束。把声明搬到 `domain/disabledResourcePolicy.ts`（本模块四个产出点改取这里，`public/types` 的问题码联合按类型引用），
   `rfc282-single-implementation-lock` 的 B3「这串字面量只出现在一处」改指新的声明处。
5. 全量 SQLite 里 `rfc128-p5-d-autodispatch` 的源码锁一例红：它按文本定位反问自回滚的调用（`rollbackNodeRunWorktrees(`），核对锁序 A ≻ B
   与「回滚在预检之后、在 B 释放之前」；回滚改经端口后调用写作 `target.rollback(selfRun.rollback, log)`，标记随之改指，判据不变。同一轮
   `rfc467-injection-oracle-relocation` 的策略束锁也红（与第 4 处同因），标题与头注里的「4 个外部策略字段」改为 3 个，并补一条「适配器取
   自己的插件禁用错误码」的断言。

- **静态**（最终候选，工作树里只有本 RFC 的改动）：backend `tsc` 0 错；eslint `--max-warnings 0` 无告警（改动的 TS 文件，加
  `eslint.promises.config.js` 覆盖的 src 文件、改到的 e2e 与 frontend 文件）；`depcheck` 分层门通过（4436 个模块）；改动的 TS 与 RFC-477
  三件套 prettier 检查通过。
- **全量 SQLite**（集中验证首版候选，即上面 5 处修复之前；导出仓库里 `bun run test:backend`，四分片，分片时限 3 小时）：四片 8430 / 8087 / 8085 /
  7374 s 全部跑完，合计 23599 pass / 127 skip / 87 fail，另有 45 条测试间未处理错误（都在有失败的文件里，是超时用例残留的异步收尾）。
  87 条 fail 里 71 条是超时：63 条撞默认 5 秒、4 条 30 秒、2 条 40 秒，60 / 300 秒各 1 条；余下 16 条：第 3、4、5 处问题报出的 8 条，导出
  仓库只有候选提交所致的 `rfc321` 发布账本 1 条，`rfc220-oauth2-callback-route` 5 条（授权码交换失败）、`rfc374-postgresql-column-upgrade`
  钩子 5 秒到点与 `rfc370-execution-effect` 原生目标 10 秒期限各 1 条。
  - 复跑（最终候选，30 秒时限，三路并行）308 个文件：全量里有失败的 43 个文件、全部架构测试与改到的用例、修复所及的 import 闭包（105 个）
    与 `legacyCallClosure` 的 8 个使用方。304 个全过，合计 3044 pass / 4 fail / 5 skip：`rfc220`、`rfc374`、`rfc370` 与 RFC-317 的三个两向
    钉死都通过；余下 RFC-167 dw-confirm 的 `approve`（用例自带 5 秒 `settleTask`）、导出里恒红的 `rfc321`（工作树 10 / 10）、`rfc363`
    目录分页一例撞 30 秒，与 RFC-477 用例一例（第 4 处修复后半把错误码搬进 domain，定义处清单的期望没跟上；补上并把后来撤出的三个符号
    写进撤出断言，接库重跑 RFC-477 用例与 RFC-317 的三个两向钉死：72 / 72，两个引擎）。对照：同一时刻在与 HEAD 逐字相同的导出仓库
    里跑 `rfc167`、`rfc363` 与全量里另三个非超时的文件（`rfc220`、`rfc374`、`rfc370`；两边各两路，30 秒时限）：两边逐文件相同——RFC-167
    28 / 1 与 28 / 1、同一例 `approve`（32.7 s 与 32.5 s），`rfc363` 3 / 1 与 3 / 1、同一例分页（32.7 s 与 32.7 s），`rfc220` 7 / 0、`rfc374`
    12 / 0、`rfc370` 13 / 0 两边都全过。
  - 修复所及范围（最终候选）：经用例 helper 的 import 闭包取到五处修复改动的文件、按路径读它们或自身被改的用例共 387 个，每个都有最终候选上
    的 SQLite 结果：140 个在上面的复跑里；取到第 4 处后半与第 5 处改动文件、复跑没覆盖的 138 个补跑（30 秒时限，两路）：1337 pass / 0 fail；
    54 个在 PostgreSQL lane 里两引擎跑过（44 个在同步之后；10 个在同步之前，不取第 4 处后半与第 5 处改动的文件），SQLite 一半全过；其余 55 个
    只走 SQLite、经用例 helper 取到注入的策略束（第 4 处前半），补跑（30 秒时限，两路）：218 pass / 0 fail。
- **其他包**（最终候选）：shared 209 个文件 2344 pass；system-mocks 30 秒时限 21 个文件 111 / 111；frontend（`test:frontend:gate`）
  871 个文件 7361 pass。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，候选导出，这份导出不同时跑别的用例）：SQLite 17 个阶段全部符合预期（0 failures），前后
  127 个受保护源文件的哈希一致、工作树干净（集中验证首版候选；之后的 5 处修复不碰评审与反问的回滚逻辑）。PostgreSQL 一半等到上面的
  PostgreSQL 复跑与对照都跑完、连续三次采样 1 分钟负载 < 28 且 5 分钟 < 34 才放行（开跑时 48.8 / 35.6 / 36.9），在最终候选上跑（之后只改了
  `nodeRollback.ts` 的一行注释、RFC-477 用例与文档，见实现门）：17 个阶段全部符合预期（0 failures），461 s，前后 127 个受保护源文件的哈希
  一致、工作树干净。
- **导出仓库接 PostgreSQL 真库**（30 秒时限，`RUN_GIT_NETWORK=1`、`RUN_CHAOS=1`；不限引擎，`describeEachProvider` 的用例两引擎都跑）：清单
  967 个文件（经用例 helper 的 import 闭包取到候选改动的生产文件或按路径读它们的 842 个用例、其余 123 个架构测试，与 2 个按路径读改动文件的
  源码锁用例），其中 import 闭包能到 PostgreSQL 引擎选择（`tests/helpers/eachProvider.ts` 与三个 PostgreSQL harness）或直接读 URL 环境变量
  的 586 个文件都跑；其余 381 个文件不碰 PostgreSQL，由 SQLite 覆盖。lane 四路，在含第 1～4 处修复前半的候选上开跑，跑到 192 个文件时同步到
  最终候选：586 个文件里 567 个全过，合计 9076 pass / 52 fail / 4 skip。51 例失败里 41 例撞时限（30 秒 11 例、15 秒 10 例、180 秒 10 例、
  20 秒 4 例，用例自带的 4 / 8 / 10 / 16 / 24 / 60 秒各 1 例），3 例钩子到点；余下 7 例：`rfc128-p5-d` 两例是同步前跑的旧源码锁标记（第 5 处），
  RFC-167 `approve` 一例（与 SQLite 同一例），RFC-238 三例是 helper 等会话状态的期限（`condition timed out`），`rfc311` 一例是同文件 8 例
  180 秒到点后跨引擎对比缺数据（「只完成了 0 / 8 条路径的跨引擎对比」）。
  - 对照（最终候选，两边各两路、各用两个库、同一顺序，负载 29～62）：除 `rfc128-p5-d` 外有失败的 18 个文件同一时刻在与 HEAD 逐字相同的
    导出仓库里跑：4 个文件两边都全过（`rfc128-p2-per-question-endpoint`、`routes-clarify`、`rfc359-w26-workgroup-empty-scan`，RFC-238
    52 / 52），10 个文件两边失败的用例逐一相同（时限、钩子到点、RFC-167 `approve`），两边合计 302 pass / 37 fail 与 306 / 34，耗时相近
    （`rfc311` 1206.5 s 与 1277.8 s、`scheduler.test` 870.8 s 与 872.1 s、`rfc359-w6-t26` 620.0 s 与 630.7 s）。差别全在 4 个文件撞时限的是
    哪几例：`rfc311` 本 RFC 一侧多一例 180 秒到点；`scheduler-wrapper-scope-dependencies` 本 RFC 一侧多到点 3 例、对照一侧另有 1 例只在它
    那边到点；`scheduler-clarify-dispatch` 本 RFC 一侧多到点 2 例；`scheduler-clarify-inline` 对照一侧多一例。同一时刻再跑一对这 4 个文件
    （两边各一路、各用一个库）：`scheduler-clarify-dispatch` 两边都是同一例 20 秒到点（15 / 1 与 15 / 1，上一轮本 RFC 一侧到点的两例都过）；
    `scheduler-wrapper-scope-dependencies` 与 `scheduler-clarify-inline` 到点的用例又在两边之间换了位置。这三个文件的 PostgreSQL 用例两边
    每次都跑 15～38 秒（报告的耗时含钩子，时限只计用例体），贴着各自 15 / 20 / 30 秒的时限；lane 与两轮对照共五次运行里，本 RFC 一侧到点的
    每一例要么在对照一侧也到点过，要么在本 RFC 一侧也通过过；另有一例断言（`upstreamStarted` 为 false，前一例到点后的连带）两边文本相同。
    `rfc311` 两边都是 25 / 25（PostgreSQL 一半的 8 例两边每例耗时相差不到 2 秒，最长 129 s；上一轮两边各有 6～7 例 180 秒到点或钩子到点）。
  - 同步前跑、经 import 闭包取到第 4 处后半与第 5 处改动文件的 50 个文件在最终候选上重跑：除对照里的 RFC-167 外 49 个全过，1042 pass /
    0 fail（含 `rfc128-p5-d` 两引擎）。经 import 闭包取到修复改动的文件、却因修复新增了被取用而不在 lane 清单里的 2 个文件
    （`rfc359-w10-grant-read-conformance`、`rfc359-w20-agent-dependency-traversal-conformance`）另跑：25 / 25。
- **定稿后的复验**：实现门补的源码锁、`nodeRollback.ts` 一行注释、design §8 改写与 guard-manifest 行数刷新之后，两份导出仓库重新同步、
  逐字核对：backend `tsc` 0 错，改动的两个 TS 文件 eslint / prettier 通过；接库（两引擎，30 秒时限）跑 RFC-477 用例（17 / 17）、读
  guard-manifest 的 4 个守卫（RFC-317 三个两向钉死与 `rfc374-node-run-order-guard`）与读 `nodeRollback.ts` 的 9 个用例：4 个守卫 62 / 62，9 个用例里 8 个全过（276 pass）；
  `scheduler-audit-s02-multirepo-retry-rollback-noop` 的 PostgreSQL 重试一例撞 30 秒（lane 里同一例 27.5 s 通过），同一时刻与 HEAD 对照
  各跑一次（各用一个库）两边都 3 / 3，该例 45.0 s 与 45.6 s（含钩子）；文档用例
  （RFC 索引状态漂移、RFC-294 设计对齐与两个 review 守卫、docs-implementation-parity、test-suite-policy、stale-assertion 等 11 个文件，含
  RFC-477 用例）接库 91 / 91。
- **结构锁的覆盖范围**（RFC-294 C12）：RFC-477 用例里五个文件不在与零 import 覆盖 backend 的 src / 用例 / 脚本（`preProcessFile` 取全部
  模块引用），零路径字面量覆盖四个包的 src / tests / scripts、e2e 与仓根脚本（注释不算），workflow 按完整路径扫，Markdown 相对链接覆盖
  `design/` 与 `docs/`，`R1` 里没有它们按全仓 census；方向锁只覆盖指定文件——collaboration 的 `review.ts`、`clarify/autoDispatch.ts`、
  `taskExecutionParticipantBindings.ts` 与 `application/ports/nodeRunWorkspaceRollback.ts`（不取 task-execution 内部、不引 `nodeRollback`），
  bootstrap 的 `crossContextClosure.ts`（交 task-execution 的工厂），task-execution 的 `application/resourceLimitEnforcement.ts` 与
  `application/ports/taskResourceLimitAudit.ts`（不取 system-operations）；作用域装载锁只覆盖 task-execution `infrastructure/nodeRollback.ts`
  的 `createNodeRunWorkspaceRollback`；定义处分层锁覆盖八个新文件的导出清单，四个 domain 文件另锁不取
  `node:`、`@/db` 与 `drizzle-orm`；public 收口锁覆盖 task-execution 的 `public/queries` 与 `public/types`、system-operations 的
  `public/operations`、resource-catalog 的 `public/queries` 与 `public/types`。上下文值环、off-DAG 值对与 `backend-value-scc` 是既有的
  全仓闸门。
- **计数复核**（`scripts/architecture-report.ts --gates` 在导出仓库的提交上采数，HEAD `55f21c641` → 最终候选）：`R1-inbound-module-internals`
  30 → 27、`R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`legacy-horizontal-files` 173 → 168、`legacy-service-implementations`
  54 → 49（五个 `services/` 文件），其余 20 项闸门计数逐项不变（含 `context-value-sccs` 0、`context-value-pairs-off-dag` 0、
  `off-dag-offered-file-context-pairs` 55、`cross-context-internal-file-pairs` 43、`backend-value-scc` 0）；后端生产文件 3191 → 3194（新增八个、
  删五个）；跨 context import 记录 7733 → 7718、模块符号归属 32260 → 32271、facade 54 → 49、变更入口清单 2346 → 2347（停用策略的四条随文件
  换到 resource-catalog domain，task-execution 的回滚执行多一条）；public surface 1497 → 1495（新增 7 个：task-execution `public/queries` 的
  `validateAgentLaunchShape`，resource-catalog `public/queries` 的 `assertTriggerPreflight`、`triggerPreflightIssue`、`triggerSourceFromContext`，
  `public/types` 的 `DISABLED_RESOURCE_POLICY`、`notModeledDisabledKinds`、`DisableableResourceKind`；撤出 9 个：task-execution 的
  `taskRollbackPlan`、`callRowHumanWait`、`readTaskResourceUsage`、`parseCallHumanWait`、`TaskResourceLimitFacts`，system-operations 的
  `ResourceLimitAudit`，resource-catalog 的 `parseCallClosure`、`FrozenCallClosure`、`PLUGIN_DISABLED_ERROR_CODE`）；偏差 91 与未被消费的
  public 符号 322 都逐条相同；模块级可变状态清单 79 条、task-owned effect 10 条（回滚的 effect 按观察者工厂
  `nodeRollbackPersistence.ts` 记，位置不变）、authority 与 gateway 清单、required port 66 条逐条不变。收口时按 RFC-294 C13 把触及的两项
  减速带收紧到实测：`legacy-horizontal-files` max 173 → 168、`legacy-service-implementations` max 54 → 49。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的函数体与原文件逐段比对：`agentHostWorkflow.ts` 与 `triggerPreflight.ts` 自第一个导出起逐字相同；限额策略只有持久化类型的审计
  一半换成 task-execution 自有端口（结构相同、bootstrap 交的仍是 system-operations 的实现）；节点回滚的两份新文件合起来与原文件相同，差异
  只有声明顺序（结果类型进 domain）、日志参数收窄为 `Pick<Logger, 'warn'>`（函数体只调 `warn`）与新增的作用域工厂。停用资源策略只少了
  错误码的转出。
- collaboration 两处调用：评审复跑的 `needsRollback ? load(taskRow.id) : null` 与原 `loadRollbackTarget(db, taskRow.id)` 同一个 `db`、同一个
  目标（带 `db`，回滚照旧写 effect）；规划 `scope.plan(run)` 即 `planNodeRunRollbackTargets(target, run)`；反问自回滚仍在同一把 question 写
  信号量里，`load` 在 `try` 外、`rollback` 在 `try` 内，失败只记 warn，与原来逐一对应。
- integration 定时任务校验：静态 import 后仍在 async 方法里调用，校验抛出的 `ValidationError` 同样以拒绝交回；少一次微任务，无可观察差异。
- 快照适配器的插件禁用错误码取定义处，与原先经策略束注入的是同一个常量（`'plugin-disabled'`）。
- public 收口：撤出的九个符号在 backend、shared、frontend、system-mocks、e2e 与脚本里都已无生产取用方（`tsc` 与计数复核为证），用例改取
  定义处。
- 失败模式与用例对账，查出一处并修复：design §8 原写「回滚作用域把目标的 `db` 丢掉 → RFC-477 用例的 effect 断言报出」，用例里其实没有
  effect 断言，而 `RollbackTarget.db` 是可选字段、`tsc` 不报。effect 只在任务执行上下文里记：反问自动派发的自回滚经任务续跑的收敛
  （gate continuation 的 pre-drive）进来时在上下文里，由答题路由触发时不在，评审只用作用域的 `plan`。补一条源码锁（作用域经
  `loadRollbackTarget(db, taskId)` 装载，规划与回滚都对着它；负对照：不带 `db` 的 `loadRollbackTargetFrom` 存在、作用域不用它），与两个引擎上
  「这个装载给出的目标带 `db`」的既有断言合起来锁住这条链；§8 改写为实际情形，`nodeRollback.ts` 作用域工厂的注释同步，guard-manifest
  里该用例的行数刷新。复验见集中验证的「定稿后的复验」。

## CI（AC-5）

- `802a4033b` 主 CI run 42826124457：70 个 job 全部通过（「CI required」绿），其中 `Backend tests (real PostgreSQL)` 的 RFC-359 P0
  变异 lane 两个数据库都通过。
- 同一 SHA 的其余 push workflow（路径过滤命中本提交）全部通过：windows-platform run 42826124636、maintenance-soak-nightly
  run 42826124435、integration-opencode run 42826124521、git-protocols-e2e run 42826124688、visual-regression-nightly
  run 42826124469。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 5 个 Done 文档文件）的导出仓库上接库重跑文档用例：11 个文件 91 / 91。

## PR / 提交

单个提交：`refactor(backend): RFC-477 节点回滚、资源限额、agent 启动快照与触发预检按 owner 归位（RFC-294 W9-D 第二十四步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
