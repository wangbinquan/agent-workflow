# RFC-500 实施计划

依赖：RFC-499（Done）；与 S12 共用模块 composition 文件（本 RFC 只把 integration 的 `composition/digitalEmployeeEventObserver.ts` 收成装配，
改 bootstrap `daemonModules/integration.ts` 取它的 import、一处类型与一处调用）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-500-T1 观察者归 application**：第 3～428 行原样迁入 `application/developmentEventObservers.ts`；三个用例改名为
  `createDevelopment…EventObserver`，时钟与激活标识必填（design D2）。
- **RFC-500-T2 composition 只装配**：`composition/digitalEmployeeEventObserver.ts` 只留 `composeDevelopmentEmployeeEventObserver`；bootstrap
  改为调它（design D3）。
- **RFC-500-T3 锁与账本**：`rfc310-event-center` 改取新位置；`counts.json` 收紧（design D4）。
- **RFC-500-T4 用例**：新增 RFC-500 的边界用例并登记 guard-manifest；集中验证时补上观察者的行为用例（design §4）。
- **RFC-500-T5 集中验证**：backend `tsc`、eslint；RFC-500 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-500-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在清单列的文件声明；装配文件只有装配函数、没有控制流语句；没有文件从旧位置取迁走的名字；bootstrap 只取装配
      函数、恰好调用一次
- [x] AC-2 同样输入下三个观察者的返回与错误和此前一致；装配交的时钟与激活标识与此前的缺省相同
- [x] AC-3 新文件的依赖面是闭集、不用进程全局；跨 context 边、public surface 不升；`composition-control-flow-integration` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证（2026-11-16，候选 1）

本机全程高负载（10 核；采样到的 1 分钟负载约 40～46，主要是本机其他进程）。验证在候选导出仓库里跑：`3cf7d3404` 的树加本 RFC 的 7 个
路径，核对与工作树逐字相同；对照导出仓库与 `3cf7d3404` 的树相同。验证期间 HEAD 只前进了本 RFC 的落档提交 `31df05fb7`（只改文档），
候选与对照同基于 `3cf7d3404`，两边只差本 RFC 的路径。集中验证没有查出本 RFC 的问题；查出设计 §4 原先高估了现有用例对代码托管观察者的
覆盖，补上观察者的行为用例（候选 1b，见下文）后定稿。

- **静态**：backend `tsc` 退出码 0、无输出（工作树，代码与候选逐字相同；`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动的
  5 个 TS 文件无告警，`eslint.promises.config.js` 的规则对改动的 3 个生产文件同样无告警；prettier：改动的 TS 与本 RFC 的三件套通过
  （`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：158 个文件
  （`tests/architecture/` 全部 140 个，以及 18 个相关用例：直接或经用例侧的辅助取到改动文件的用例、按名字与事件类型扫出的用例、直接取
  bootstrap `daemonModules/integration.ts` 或 `daemonApplication.ts` 的用例与取两个 daemon 装配辅助的用例，含本 RFC 用例）。候选 1,551 条
  通过、37 条红（17 个文件），对照（少本 RFC 用例）1,556 条通过、32 条红（16 个文件）。
  - RFC-500 用例 10 / 10；`rfc310-event-center` 两边都是 24 / 2，红在同样的两条（PostgreSQL，撞默认的 5 秒），纯投影、游标与审批观察者的
    用例两边都过。
  - 候选有对照之外失败名的 4 个文件共 5 条：3 条撞时限（`architecture/rfc400-collaboration-task-participants` 一条撞默认的 5 秒，7.3 秒、
    对照 1.2 秒；`rfc396-case-intake` 与 `rfc396-mr-runtime-wiring` 的 PostgreSQL 各一条撞自带的 30 秒，30.9 / 31.2 秒）；
    `rfc310-digital-employee-system-mock-e2e` 的 SQLite 两例开头向系统模拟服务播种时连接被重置（ECONNRESET，约 20 秒，在
    `seedDevelopmentPipeline` 的请求上，事件中心还没起；RFC-499 的首批里同一处同样红过），同文件 PostgreSQL 两例两边都撞自带的 180 秒。
- **红文件放宽默认时限复跑**（首批任一边红过的 17 个文件里，除报告类的 `rfc376-report`（见下文放宽副本）外的 16 个；默认时限放宽到
  60 秒、看门狗 3,000 秒，其余同首批）：候选与对照都是 222 条通过、7 条红（6 个文件），红在同样的用例，没有候选多出的失败名。
  - 首批候选多出的 5 条：4 条两边都过（`rfc400` 与 `rfc396-mr-runtime-wiring` 各一条，系统模拟 E2E 的 SQLite 两例，候选 99 / 104 秒
    通过——这个用例自己组装事件中心、不带开发员工观察者，是按事件类型名扫进首批的）；`rfc396-case-intake` 那一条两边都撞自带的 30 秒
    （候选 32.1 秒）。`rfc310-event-center` 两边 26 / 26。
  - 两边红在同样的 7 条都撞用例自带的时限：系统模拟 E2E 的 PostgreSQL 两例 180 秒，`rfc257-webhook-ingress`、`rfc310-employee-case-runtime`
    与 `rfc396-case-intake` 的 PostgreSQL 各一条 30 秒，`rfc384-daemon-intent-bundle` 的 PostgreSQL 一条 15 秒，`rfc400` 的源码扫描一条
    30 秒。其中静态 import 闭包取到本 RFC 路径的只有经 daemon 装配的 `rfc396-case-intake` 与 `rfc384-daemon-intent-bundle`，两者的放宽副本
    见下文；其余 4 个不经过本 RFC 的代码。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的时限照旧；
  清单按耗时从慢到快排，3 个 worker；前半程与首批、复跑同时）：2,944 个文件、2,930 个通过（23,945 条通过、127 条按环境跳过）；其余 14 个
  文件 16 条红，都不归本 RFC：
  - 三个报告类用例撞自带时限：`rfc294-architecture-preflight` 60 / 180 秒、`rfc376-report` 300 秒、`rfc370-committed-architecture-source`
    150 秒，见下文放宽副本。
  - 余下 11 个与对照同时、同样跑法 A/B（各 2 个 worker）：候选 93 条通过、8 条红，对照 92 条通过、9 条红，没有候选多出的失败名。
    - 3 个两边都过：`tasks`（全量里两条等仓库准备落定，用例自带的 5 秒没等到）、`lifecycle-property`（15 秒）与
      `rfc398-auto-upgrade-resume-phase-activated`（全量里一条读到写了一半的 `.daemon.info`：daemon 原地写这个文件，用例辅助直接解析、
      把 `Unexpected EOF` 当成失败，产品自己的 `readDaemonInfo` 把解析不了当作还没就绪；辅助的修正另行提交）。
    - 8 个两边红在同样的用例：发布账本一条（`rfc321-repository-publication-ratchet`：账本记的提交不在导出仓库的历史里）；撞自带时限的
      发布 E2E 的 SQLite 一例（30 秒）、`clarify-review-combination-scenarios` 的 S-RFC074（20 秒；对照另红 S3 一条）、
      `rfc300-webhook-workspace-cleanup-e2e`、`rfc354-nested-frames-closure` 与 `rfc363-workspace-content`（各 30 秒）、
      `rfc354-nested-loop-frames`（20 秒）；`rfc167-dynamic-workflow-engine` 的 approve 一条（`settleTask` 等满 5 秒时任务仍是 running）。
  - 静态 import 闭包（含按路径起的夹具）取到本 RFC 改动代码的 260 个文件里 257 个通过（取到装配文件的 259 个里 256 个、取到新文件的
    260 个里 257 个）；红的 3 个是 A/B 两边都过的 `tasks` 与两边红在同样用例的 `rfc300`、`rfc167`，后两者的放宽副本见下文。其余红的文件
    不经过本 RFC 的代码。
- **放宽副本**（候选与对照同时，按首批的跑法、各 2 个 worker；默认时限与用例自带的时限都放宽到 1,500 秒，`settleTask` 的等待 5 → 50 秒，
  其余逐字）：7 个文件两边都全过（各 79 / 79）。
  - 三个报告类用例：`rfc376-report` 16 / 16（byte-identical 那一例候选 590 秒、对照 584 秒，超出自带的 300 秒）、
    `rfc294-architecture-preflight` 14 / 14（697 / 597 秒）、`rfc370-committed-architecture-source` 2 / 2（那一例 317 / 297 秒，超出自带的
    150 秒）。
  - 两边红在同样用例、静态 import 闭包取到本 RFC 路径的 4 个：`rfc384-daemon-intent-bundle` 12 / 12（maintenance deltas 那一例 PostgreSQL
    候选 18.6 秒、对照 21.4 秒，两边都超出自带的 15 秒）、`rfc396-case-intake` 4 / 4（最长 18.7 / 19.2 秒）、`rfc300-webhook-workspace-cleanup-e2e`
    2 / 2（那一例 50.4 / 56.1 秒，超出自带的 30 秒）、`rfc167-dynamic-workflow-engine` 29 / 29。
  - 跑完删除副本，两个导出仓库恢复干净。
- **候选 1b**：上面各轮跑的是候选 1；之后只加了观察者的行为用例（design §4），生产代码与其余用例逐字不变。候选导出仓库同步到 HEAD
  `31df05fb7` 的树加本 RFC 的 8 个路径，按 CI 的跑法跑 RFC-500 的两个用例与 `rfc310-event-center`：边界用例 10 / 10、行为用例 4 / 4（主树上
  另跑一次同样 4 / 4）；`rfc310-event-center` 25 / 26，红的是首批两边都红、复跑两边都过的那一例（PostgreSQL 的 observer batches rotate，
  5.4 秒撞默认的 5 秒）。`tsc` 对加了用例的工作树退出码 0、无输出。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的
  `max`）：
  - `composition-control-flow-integration` 101 → 74：少掉的 27 条正是观察者文件的全部，没有新增，保留的装配文件 0 条，integration 其余
    组合文件逐个相同。
  - 生产文件 4,101 → 4,102（backend 3,237 → 3,238：增一个）。
  - 跨 context import 7,505 → 7,503：context 对 135 → 135，没有新的符号。4 条随内容迁到新文件（取 development-automation `public/types` 的
    一个类型与两个值、取 `@/util/hash` 的一个值）；bootstrap 少取两个改名前的观察者（非模块代码 → integration 70 → 68）。
  - public surface 1,195 → 1,195（development-automation `public/types` 的使用方边随 import 换成新文件）；模块符号归属 32,367 → 32,369
    （观察者文件 19 项 → 2 项，新文件 19 项）；变更入口 2,346 → 2,349（三个用例离开 composition 后在 application 记为三项，报告不把
    composition 文件计入变更入口）；其余各节逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 37 处，都是
  预期的：import 3 处（`rfc310-event-center` 取新文件、bootstrap 取装配文件、装配文件取新文件），其余 34 处是 RFC-500 用例的常量与负对照。
  改名前的两个观察者名在全仓（含注释与文档）只出现在 RFC-500 用例、本 RFC 的 design 与 RFC-471 的 design（当时的记述，不改）。
  `design/`、`docs/` 与 `STATE.md` 里没有指向旧位置的链接失效（装配文件照旧在）。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `31df05fb7` 的树加本 RFC 的 11 个路径（8 个代码路径与这三份
  文档），读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、`docs-runbook-command-guard`、`rfc-index-status-drift`、
  `rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- 【待补：实现提交】
- 本 RFC 的落档提交 `31df05fb7`（只改文档）：主 CI run 43933933245 的 70 个 job 里 67 个通过。Backend tests shard 20/44 红一条：
  `rfc359-w5hn-workflow-route-launch-provider-parity` 的 PostgreSQL「缺必填 / 未声明键」，打开 HTTP 应用的 `beforeEach`（组装整个 daemon）
  用了 6.2 秒、撞 bun 默认的 5 秒，随后的「graph-builtin-implementer-missing」是钩子超时后清理与组装交错的连带；归因：这个提交只改文档，
  代码相同的父提交 `3cf7d3404` 的 run 43924182021 里同一分片同一例 0.7 秒通过——runner 时序，按 flaky 的规则给这个钩子显式的 30 秒，
  修用例另行提交。Playwright e2e（macOS 2/4）没有分到 runner 就被取消（`not acquired`、0 个步骤），归 runner 容量；两者连带 CI required 红。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **观察者**：脚本比对新文件（去掉两行文件头注释）与 HEAD 原文件第 3～428 行，差异只有 design D2 的三处——三个用例改名（分派器输入的
  两处 `ReturnType` 随之改名），时钟与激活标识的 `?` 去掉、第 224～225 行与第 339 行直接取输入，`../application/mrFacts` 与
  `../application/mrEnsure` 改为同目录；两个纯函数、私有类型、表、schema、网关接口与三个 `run` 的函数体逐字不变。
- **装配**：此前 bootstrap 先建代码托管观察者、再建审批观察者、最后建分派器，两个观察者取缺省的 `Date.now` 与 `randomUUID`；装配函数里
  对象字面量按同样的次序求值，交的是同样的两个函数（都按不绑定 `this` 的引用调用，此前的缺省也是），三个构造都是纯的（只建闭包）。
- **bootstrap**：只有 3 处——import 只取装配函数；`developmentCodeHostBinding` 的类型改取装配函数的参数（同一个类型）；调用改为交绑定与
  网关，取值与此前交给两个观察者的相同；其余逐字，`rfc471` 要求的那一行照旧在。
- **用例**：`rfc310-event-center` 只改 import 与审批观察者的函数名，断言不变。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-499 转 Done 提交 `b1ebf236f` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-500 集成的开发员工事件观察者迁出 composition（RFC-294 S10 第七步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
