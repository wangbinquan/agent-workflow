# RFC-501 实施计划

依赖：RFC-500（Done）；与 S12 共用模块 composition 文件（本 RFC 删除 integration 的 `composition/webhookAdmission.ts`，改
`composition/webhookDispatch.ts` 的一条 import 与一行注释、`composition.ts` 的一条转出，删去 `infrastructure/webhookDispatchRuntime.ts` 里
转手的函数，改 bootstrap `daemonModules/integration.ts` 的一条 import 与一处调用）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-501-T1 准入归 application**：第 1～191 行原样迁入 `application/webhookAdmission.ts`，两个工厂改名（design D2）。
- **RFC-501-T2 composition 不再有这个文件**：删除 `composition/webhookAdmission.ts`；删去 infrastructure 的转手函数；`webhookDispatch.ts`
  改取 application；`composition.ts` 转出校验器工厂，bootstrap 改取它（design D3）。
- **RFC-501-T3 锁与账本**：5 个用例改取新位置；`rfc345` 改读新文件；`rfc380` 的名字表换新名字；`counts.json` 收紧（design D4）。
- **RFC-501-T4 用例**：新增 RFC-501 用例并登记 guard-manifest（design §4）。
- **RFC-501-T5 集中验证**：backend `tsc`、eslint；RFC-501 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-501-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在新文件声明；旧文件不存在、没有文件从旧位置取名字；改名前的两个工厂名没有声明；infrastructure 不再声明转手
      函数、不取 composition
- [x] AC-2 同样输入下启动准入与保存校验的结果、错误码与端口调用和此前一致；派发与触发器服务拿到的是同一份实现
- [x] AC-3 新文件的依赖面是闭集；跨 context 边、public surface 不升；`composition-control-flow-integration` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`1ac43b89b` 主 CI run 44021789499 的 70 个 job 全部通过（见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 44～127，主要是本机其他进程：Docker 的虚拟机、fseventsd 与一个更早会话遗留的 bun 进程）。
验证在候选导出仓库里跑：`ea271ecac` 的树加本 RFC 的 16 个路径（含删除的 `composition/webhookAdmission.ts`），核对与工作树逐字相同；对照
导出仓库与 `ea271ecac` 的树相同。验证期间 HEAD 只前进了本 RFC 的落档提交 `f47466869`（只改文档）。集中验证没有查出本 RFC 的问题，
候选 1 即定稿。

- **静态**：backend `tsc` 退出码 0、无输出（工作树，代码与候选逐字相同；`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动的
  13 个 TS 文件无告警，`eslint.promises.config.js` 的规则对改动的 5 个生产文件同样无告警；prettier：改动的 TS 与本 RFC 的三件套通过
  （`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：352 个文件
  （`tests/architecture/` 全部 140 个，以及 212 个相关用例：直接或经用例侧的辅助取到改动文件的用例——含经辅助取 integration
  `composition.ts` 的、按名字与路径扫出的用例、直接取 bootstrap `daemonModules/integration.ts` 或 `daemonApplication.ts` 的用例与取两个
  daemon 装配辅助的用例，含本 RFC 用例）。候选 3,088 条通过、240 条红（85 个文件），对照（少本 RFC 用例）3,088 条通过、240 条红（86 个
  文件）。
  - RFC-501 用例 9 / 9；改取新位置的用例两边都过：`webhook-trigger-digital-employee-validation` 2 / 2、`webhook-trigger-validation-acl-order`
    6 / 6、`rfc370-webhook-configuration` 4 / 4、`rfc359-w7-integration-composition-roots` 23 / 23、`rfc345-resource-catalog-contracts`
    18 / 18、`architecture/rfc380-daemon-module-bundles` 9 / 9；`rfc359-w4-b4a-adapters` 候选 7 / 8（PostgreSQL 记忆注入那一例 6.1 秒撞默认的
    5 秒，对照 4.8 秒通过），经派发跑启动准入的 `rfc257-webhook-dispatch` 候选 47 / 51、对照 44 / 51，`rfc257-webhook-ingress` 29 / 30、
    27 / 30，`rfc269-webhook-code-host-context-e2e` 两边 2 / 2，`rfc268-webhook-scratch-launch` 两边红在同样的一例。
  - 逐文件比失败名，候选多出 25 条、对照多出 26 条。候选多出的 22 条撞时限（17 条撞默认的 5 秒，3 条撞自带的 10 秒，各 1 条撞 15 秒与
    30 秒）；另 3 条是 `rfc359-w14-legacy-mission-execution` 的等待计时器、前一例超时连带的「Unhandled error between tests」与
    `clarify-review-combination-scenarios` 的 S3（KNOWN-INCIDENT，RFC-500 的 A/B 里对照红过同一例）。
- **红文件放宽默认时限复跑**（首批任一边红过的 90 个文件里，除报告类的 `rfc376-report` 外的 89 个；默认时限放宽到 60 秒、看门狗 3,000 秒，
  其余同首批）：候选 1,269 条通过、70 条红，对照 1,267 条通过、72 条红。首批候选多出的 25 条：20 条两边都过、5 条两边都红，没有一条仍
  只红在候选。这一轮候选多出 4 条（`scheduler-cross-clarify-dispatch` 的 PostgreSQL 一例撞自带的 60 秒、`rfc359-w9-retry-rollback-parity`
  的 SQLite 一例撞自带的 10 秒、`scheduler-wrapper-fanout-e2e` 的 PostgreSQL 一例撞默认的 60 秒、`clarify-review-combination-scenarios` 的
  S10 等任务收尾时断言状态），对照多出 6 条（同样是撞 60 / 20 秒与 `clarify` 的 S16）；4 个文件的静态 import 闭包都经应用装配取到本 RFC
  路径，放宽副本见下文。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的时限照旧；
  清单按耗时从慢到快排，3 个 worker；与首批、复跑同时）：2,946 个文件、2,932 个通过（23,959 条通过、127 条按环境跳过）；其余 14 个文件
  15 条红，都不归本 RFC：
  - 三个报告类用例撞自带时限：`rfc294-architecture-preflight`、`rfc376-report`、`rfc370-committed-architecture-source`，见下文放宽副本。
  - 余下 11 个与对照同时、同样跑法 A/B（各 2 个 worker）：候选 91 条通过、11 条红，对照 90 条通过、12 条红，没有候选多出的失败名（对照
    另红 `rfc395-v1-source-evidence` 的 watermark 一例）。11 个都两边红在同样的用例：发布账本一条（账本记的提交不在导出仓库的历史里）；
    撞自带时限的 `rfc395-restore-epoch-routing`（30 秒）、`rfc395-v1-source-evidence` 与 `rfc395-v1-source-readers`（40 秒）、
    `rfc354-nested-failure-modes`、`rfc354-nested-frames-closure`、`rfc300-webhook-workspace-cleanup-e2e` 与 `rfc363-workspace-content`
    （各 30 秒）、`rfc354-nested-loop-frames`（20 秒）、`architecture/rfc400-collaboration-task-participants` 的源码扫描（30 秒）；
    `rfc167-dynamic-workflow-engine` 的 approve 一条（`settleTask` 等满 5 秒时任务仍是 running）。
  - 静态 import 闭包（含按路径起的夹具）取到本 RFC 改动代码的 430 个文件里 425 个通过（取到新文件的 429 个里 424 个、取到派发运行时的
    268 个里 266 个、取到 `webhookDispatch.ts` 的 266 个里 264 个、取到 `composition.ts` 的 423 个里 418 个、取到 bootstrap 文件的 259 个
    里 257 个）；红的 5 个是上面两边红在同样用例的 `rfc354-nested-failure-modes`、`rfc300`、`rfc167`、`rfc354-nested-frames-closure` 与
    `rfc354-nested-loop-frames`，它们的放宽副本见下文。
- **放宽副本**（候选与对照同时，按首批的跑法、各 2 个 worker；默认时限与用例自带的时限都放宽到 1,500 秒，`settleTask` 的等待 5 → 50 秒、
  `clarify` 的流程时限 20 → 600 秒，其余逐字；`scheduler-wrapper-fanout-e2e` 没有自带的时限，原文件照跑）：12 个文件两边都全过（各
  145 / 145）。
  - 三个报告类用例：`rfc376-report` 16 / 16（byte-identical 那一例候选 376 秒、对照 680 秒，超出自带的 300 秒）、
    `rfc294-architecture-preflight` 14 / 14（712 / 733 秒）、`rfc370-committed-architecture-source` 2 / 2（那一例 268 / 417 秒，超出自带的
    150 秒）。
  - 全量 SQLite 的 A/B 里两边红在同样用例、取到本 RFC 路径的 5 个：`rfc354-nested-failure-modes` 7 / 7、`rfc354-nested-frames-closure` 1 / 1、
    `rfc354-nested-loop-frames` 1 / 1、`rfc300-webhook-workspace-cleanup-e2e` 2 / 2、`rfc167-dynamic-workflow-engine` 29 / 29，超出原时限
    的那几例两边都超出（最长 48.0 / 34.9、54.6 / 42.0、27.3 / 22.8、53.0 / 46.1 秒）。
  - 复跑里候选多出撞时限的 4 个：`scheduler-cross-clarify-dispatch` 17 / 17（超出自带 60 秒的两边各 7 例，最长 124.0 / 123.3 秒）、
    `rfc359-w9-retry-rollback-parity` 26 / 26（超出自带 10 秒的 4 例，最长 61.9 / 63.3 秒）、`scheduler-wrapper-fanout-e2e` 12 / 12、
    `clarify-review-combination-scenarios` 18 / 18（超出原 20 秒的 10 例，最长 30.4 / 30.2 秒）。
  - 跑完删除副本，两个导出仓库恢复干净。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的
  `max`）：
  - `composition-control-flow-integration` 74 → 57：少掉的 17 条正是删掉的 `webhookAdmission.ts` 的全部，没有新增，integration 其余组合
    文件逐个相同。
  - 生产文件 4,102 → 4,102（删一个、增一个）。
  - 跨 context import 7,503 → 7,503：context 对 135 → 135，没有新的符号；4 条随内容迁到新文件（resource-catalog 的 `public/types` 与
    `public/queries`、`@/util/errors`、`@/auth/actor`），bootstrap 取校验器工厂的一条改名。
  - public surface 1,195 → 1,195（resource-catalog public 的使用方边随 import 换成新文件）；模块符号归属 32,369 → 32,368（旧文件 4 项 →
    新文件 4 项，infrastructure 的转手函数少一项）；变更入口 2,349 → 2,350（两个工厂在 application 记为两项，infrastructure 的转手函数少
    一项）；其余各节逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 35 处，都是
  预期的：import 7 处都取新文件（5 个用例、`composition.ts` 的转出、`webhookDispatch.ts`），`rfc345` 改读的新路径 1 处、`rfc380` 换上的
  两个新名字 2 处，其余 25 处是 RFC-501 用例的常量与负对照。没有文件按旧路径取东西；`design/`、`docs/` 与 `STATE.md` 里没有指向旧文件的
  链接，提到它的是 RFC-437、RFC-438、RFC-477 与 RFC-359 的记述（当时的锚点），不改。
- **收口文档**：plan 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `f47466869` 的树加本 RFC 的 18 个路径（16 个代码路径与这两份文档），
  读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、`docs-runbook-command-guard`、`rfc-index-status-drift`、
  `rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `1ac43b89b`（实现，父提交是 `f47466869`）：exact SHA 主 CI run 44021789499 的 70 个 job 全部通过。
- 本 RFC 的落档提交 `f47466869`（只改文档）：主 CI run 43984477325 的 70 个 job 全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **准入**：脚本比对新文件（去掉两行文件头注释）与 HEAD 原文件，差异只有 design D2 的两处——两个工厂改名、5 条 import 的路径按新目录
  改写；三个函数的签名与函数体逐字不变。
- **派发运行时**：只删去转手的 `createWebhookLaunchAdmission`、它取 composition 的 import 与随之不再使用的 `ScheduledTaskOperations` 类型
  import；`rfc257`、`rfc243` 与 `rfc321` 读的执行运行时与参与方转交逐字不变。
- **派发装配**：`webhookDispatch.ts` 取的 `createWebhookLaunchAdmission` 此前是 infrastructure 的转手（原样返回 composition 的工厂的结果），
  现在直接是 application 的同一个函数，`admitLaunch` 的取值相同；注释改名。
- **bootstrap 与 `composition.ts`**：`composition.ts` 增一条转出；bootstrap 只改 import 来源与调用名，两个实参不变。
- **用例**：5 个用例只改 import 与函数名，`rfc345` 只改读的路径、断言不变，`rfc380` 的名字表换新名字。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-500 转 Done 提交 `7bfd2c5e8` 与用例修正 `ea271ecac`
的 CI）；实现与验证后再提交 `refactor(backend): RFC-501 集成的 webhook 启动准入与触发器校验迁出 composition（RFC-294 S10 第八步）`。走
私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
