# RFC-472 实施计划

**前置**：RFC-471 落地（`a9207cbc0`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                         | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------ | --------- |
| RFC-472-T1 | intent：`IntentOwnerAdmissionPort`；dispatcher 与会话路由的依赖改名换型                                      | design §1 |
| RFC-472-T2 | identity-access：`composeDurableWorkOwnerAdmission`；Bearer 语法迁 domain、经 `public/types` 提供            | design §2 |
| RFC-472-T3 | bootstrap 接线、`providerCore` 直取、`routes/auth.ts` 改取 public；`src/auth/session.ts` 删除                | design §3 |
| RFC-472-T4 | 用例改路径与依赖、B4 锁与三份路径清单；新增 RFC-472 用例；架构报告 owner 表、`R1` 账本与 guard-manifest      | design §5 |
| RFC-472-T5 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI | design §7 |
| RFC-472-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                              | —         |

## 验收清单

- [x] AC-1 本文件不在、零引用；intent 不取 identity-access 的值；属主重新准入的实现与 intent 端口逐项相同；REST 只有一个 Bearer 读点
- [x] AC-2 架构计数按实测（`R1` 57 → 53），越界类计数、public surface 偏差与未被消费的 public 符号不升
- [x] AC-3 受影响用例与新增用例全部通过（四个包）
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-08，候选基于 `9e3ba73a9`）

本机全程高负载（采样到的负载 20～60；本机另有常驻负载：一个本地虚拟机与三个挂起的测试夹具进程）。验证都在候选导出仓库里跑（HEAD 的
`git archive` 加候选路径，提交后运行；修复与文档改动后重新同步，核对与 HEAD 加候选逐字相同）。集中验证查出本 RFC 的三处问题，均已修复并复验：

1. 全量 SQLite：`tests/architecture/rfc380-daemon-module-bundles` 报 `bootstrap/daemonModules/intent.ts: identity-access import outside provider core`——
   RFC-380 规定 `bootstrap/daemonModules/` 里只有 provider core 可以 import identity-access，而 intent 束直取了 `composeDurableWorkOwnerAdmission`。
   改为应用根（`daemonApplication.ts`）组装、注入 intent 束（应用根本来就这样把 `createEventAutomationDelegatedContextBinding` 注入 integration 束），
   `rfc305-architecture-lock` 的消费方清单、`rfc347-identity-access-runtime` 的路径清单与 RFC-472 用例的接线锁随之改。
2. 全量 SQLite：`rfc305-architecture-lock` 的 identity-access `public/types.ts` 导出名清单没登记新的 `parseLocalBearerHeader`，补上。
3. PostgreSQL lane：RFC-472 用例的负对照把裸文件名 `probe.ts` 交给 `relative(REPO_ROOT, …)`，结果随进程 cwd 变——从 `packages/backend` 跑
   （PostgreSQL lane 的 cwd）得到 `packages/backend/probe.ts`，从仓根跑（CI、全量与 SQLite 复跑的 cwd）才是 `probe.ts`。改为传绝对路径；修复后
   在导出仓库里从两种 cwd 各跑一次，两引擎都是 12 pass。

- **静态**（三处修复后的候选）：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 TS 文件，加
  `eslint.promises.config.js` 覆盖的 src 文件；system-mocks 的 `seed.ts` 另跑该包的 eslint）；`depcheck` 分层门通过（4424 个模块）；改动的 TS 与
  RFC-472 三件套已按 prettier 格式化。
- **声明逐个比对**：见实现门。
- **全量 SQLite**（修复前的候选，基于 `a9207cbc0`；导出仓库里 `bun run test:backend`，四分片，分片时限 3 小时）：四片 6501 / 6297 / 7041 / 6966 s
  全部跑完，合计 23561 pass / 127 skip / 71 fail，另有 40 条测试间未处理错误（都在有失败的文件里，是超时用例残留的异步收尾）。71 条 fail 里
  66 条是超时：60 条撞默认 5 秒、4 条撞 30 秒、1 条撞 150 秒、`rfc376-report` 撞 300 秒；余下 5 条：上面前两处、导出仓库只有候选提交所致的
  `rfc321` 发布账本、`clarify-review-combination-scenarios` 撞用例自带的 20 秒流程时限，以及 `scheduler-envelope-followup-integration` 一例读到
  0 条 argv（同文件前一例超时后数据库已关，残留的引擎收尾报 `Cannot use a closed database`）。
  - 复跑 339 个文件（全量里失败的 33 个文件、全部 139 个架构测试、改到的 28 个用例与修复让 import 闭包多出的 154 个用例；前两处修复后的候选；
    30 秒时限）：336 个全过（含新增的 RFC-472 用例、改到的用例、全部 139 个架构测试与修复让闭包多出的 154 个用例），合计 2859 pass /
    3 fail / 4 skip（与 PostgreSQL lane 同时跑，负载 40～60），余下 3 个文件各一例：导出里恒红的 `rfc321` 发布账本（工作树结果见下）、RFC-167
    dw-confirm 的 `approve`（自带 5 秒 `settleTask`）与 `rfc363` 目录分页（撞 30 秒）。对照：同一时刻在 RFC-471 的导出仓库（树与 `9e3ba73a9`
    逐字相同）里跑同一文件（负载 49～60），`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.81 s 与 5.97 s），`rfc363` 两边都是 3 pass / 1 fail、
    同一例到点（30.74 s 与 30.78 s）。
- **导出仓库接 PostgreSQL 真库**（前两处修复后的候选，30 秒时限）：清单 525 个文件（经用例 helper 的 import 闭包取到改动的生产文件的 395 个用例——
  不计只改了头注释的 `src/auth/actor.ts`，几乎所有用例都 import 它——、全部 139 个架构测试与改到的用例），其中 import 闭包能到 PostgreSQL
  引擎选择（`tests/helpers/eachProvider.ts` 与三个 PostgreSQL harness）或直接读 URL 环境变量的 363 个文件都跑；其余 162 个文件不碰 PostgreSQL，
  由 SQLite 覆盖。修复前那条 lane 跑完 93 个文件时停下（修复改了几乎所有用例都会装配的应用根），结果不作证据。
  354 个文件全过，合计 6442 pass / 17 fail / 4 skip（三路并行，与 SQLite 复跑、各包同时跑，负载 20～60）。余下 9 个文件：RFC-472 用例的
  负对照一例即上面第 3 处问题；RFC-167 dw-confirm 的 `approve`（与 SQLite 复跑同一例）；其余 7 个文件 15 例都在 `[postgresql]` 半边的
  runtime fixture，撞用例自带或 30 秒的时限——`scheduler-wrapper-scope-dependencies` 8 例、`scheduler-audit-s04-git-wrapper-cumulative-diff`
  2 例，`rfc359-w9-retry-rollback-parity`、`scheduler-clarify-inline`、`scheduler-default-retries`、`scheduler-rfc040-wrapper-await` 各 1 例，
  `tasks` 的 `GET /:id/diff` 一例等仓库准备到点。对照：同一时刻在 RFC-471 的导出仓库（树与 `9e3ba73a9` 逐字相同）里逐个跑这 8 个文件（两条
  队列并行，每对两边各用一个库，负载 21～51）：`rfc167`、`rfc359-w9`、`s04`、`clarify-inline`、`default-retries`、`rfc040` 两边失败的用例与到点的时限逐一
  相同（依次 1 / 1 / 2 / 3 / 3 / 3 例）；`tasks` 本 RFC 一侧全过，对照一侧正是同一例等仓库准备到点；`scheduler-wrapper-scope-dependencies`
  两边同样 5 例撞 30 秒，本 RFC 一侧多出的一例在对照一侧 29.4 秒擦线通过，120 秒时限下两边都是 18 / 18 全过
  （同一时刻，负载约 54，逐例耗时相近）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，同一份导出仓库，等上面两条 lane 跑完后两引擎分开跑）：SQLite 17 个阶段全部符合预期
  （0 failures）；PostgreSQL 等负载降到 28.0 / 39.9 才放行，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件的哈希一致、
  导出仓库工作树干净。
- **其他包**（前两处修复后的候选；第三处只改 RFC-472 用例自身，这三个包不读它）：shared 209 个文件 2344 pass；frontend
  （`test:frontend:gate`）871 个文件 7361 pass；system-mocks 30 秒时限（RFC-471 实测默认 5 秒在高负载下会让真 Git smart HTTP 用例到点）
  21 个文件 111 / 111 全过。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等，加 RFC-472 用例）：12 个文件全过（100 pass；导出仓库与 HEAD 加候选逐字相同）。
- **计数复核**（`scripts/architecture-report.ts` 在导出仓库的提交上采数，前两处修复后的候选——第三处不动 import，c471 → c472）：`R1-inbound-module-internals` 57 → 53、
  `R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`legacy-horizontal-files` 181 → 180、后端生产文件 3181 → 3182（删一个、新增两个）；
  跨 context import 记录 7804 → 7788（本文件的 18 条与 dispatcher 取它的 3 条消失；新增应用根与 `providerCore` 取 composition、`routes/auth.ts`
  取 `parseLocalBearerHeader`、intent 端口取 `Actor` 类型共 5 条）、模块符号归属 32236 → 32235、public surface 1493 → 1494；偏差 94、未被消费的
  public 符号 322、capability 归属清单 18 逐条相等；跨 context 内部文件对 43、off-DAG offered 文件对 55、不可达生产文件 18、`module-layer-violations` 1、
  off-DAG 值边 0、平台 → 模块 0、`legacy-service-implementations` 61 不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（`a9207cbc0` 对工作树）：`parseLocalBearerHeader` 迁到 identity-access domain 后函数体逐字相同；`composeDurableWorkOwnerAdmission`
  的 `admitOwner` 与 dispatcher 原来的两行同一段计算（同一个 `admitDurableWorkOwner` 与 `actorOfDirectAuthority`）；dispatcher 只改了依赖的名字与
  类型、那三行换成一次端口调用（null 照旧跳过该会话），会话路由只改了转交的依赖名；应用根只多了 composition 的 import 与 `ownerAdmission`
  的组装，intent 束只把 identity-access runtime 换成注入的 `ownerAdmission` 转交，`providerCore` 只换了 import 来源；`routes/auth.ts` 只换了
  两处读令牌的写法（读的仍是 `Authorization` 头、同一个语法函数）与 import；identity-access composition 只少了七个转出名、多了一个组装函数，
  函数定义与模块内调用未变；`src/auth/actor.ts` 只改头注释。
- 行为：属主重新准入的 null 条件不变；守护进程准入取的是同一对函数；HTTP 认证中间件的生产组装从未经过 `multiAuth`，用例改用的就是那条组装；
  RFC-285 B4：REST 仍只有一个 Bearer 读点、没有 query 读点。
- 用例：改到的用例只改 import 路径、构造参数（`identityAccess` → `ownerAdmission`）、`rfc383` 的 spy 对象与路径清单，断言不动；`rfc384` 的路由依赖
  键断言改为新的依赖名并补「dispatch 与路由收同一个」；`auth-session` 的 B4 锁改指新的读点并补「`routes/` 里每处读 `Authorization` 都经这个函数」。
- 账本：`R1` 57 → 53（实测与账本逐条相等，`R2` 0）；public surface 1493 → 1494（`parseLocalBearerHeader`，有生产消费方）；偏差 94、未被消费的
  public 符号 322、capability 归属清单 18 逐条相等；guard-manifest 只刷新 `rfc305-architecture-lock` 的登记行数（947 → 949，其余登记的
  守卫文件行数未变）。

## PR / 提交

单个提交：`refactor(backend): RFC-472 退役 identity-access 的兼容转出 auth/session：intent 的属主重新准入改走自有端口（RFC-294 W9-D 第十九步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
