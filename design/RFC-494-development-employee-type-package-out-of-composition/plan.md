# RFC-494 实施计划

依赖：无硬前置；与 S12 共用模块 composition 文件（本 RFC 只动 development-automation 的这三个 composition 文件）。按 CLAUDE.md 文首硬规则：
先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-494-T1 合同与编解码迁入 application**：`composition/employeeTypePackage.ts` 除登记对象外原样迁入
  `application/employeeTypePackage.ts`，`runtimePackage`、`WorkContract`、`ToolImplementation` 加 `export`（design D1、D2）。
- **RFC-494-T2 两个依赖文件迁入 application**：工具合同登记（改名 `digitalEmployeeToolContractRegistrationsV2.ts`）与旧程序升级；工具结果
  投影不动（design D3）。
- **RFC-494-T3 composition 只留登记对象**与给 bootstrap 的三个转出（design D4）。
- **RFC-494-T4 使用方与账本**：生产、用例与 e2e 的 import 改到新位置；读源码的锁随内容改指；`counts.json` 收紧、`commons-debt.json` 锚点
  重新定位（design D5）。
- **RFC-494-T5 用例**：新增 RFC-494 用例并登记 guard-manifest（design §4）。
- **RFC-494-T6 集中验证**：backend `tsc`、eslint（含 e2e）；RFC-494 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告
  对照；全仓旧位置扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-494-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在新的 application 文件声明；composition 只交出登记对象与三个转出、迁走的两个文件不在；没有文件从旧位置取
      迁出的名字
- [x] AC-2 同样输入下包语义、执行合同登记、上下文 schema、两个运行时编解码器与旧程序升级的结果与此前一致
- [x] AC-3 新文件的依赖面是闭集（不取 infrastructure、composition、IO 包与进程全局）；跨 context 边、public surface 不升；组合层控制流
      收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`e11313b6b` 主 CI run 43561287620 的 70 个 job 全部通过（见 §CI）

## 集中验证（2026-11-13，候选 1～4）

本机全程高负载（10 核；采样到的 1 分钟负载 25～70，主要是本机其他进程）。验证在候选导出仓库里跑：HEAD 的树加候选路径，每次修复后
重新同步，核对与工作树逐字相同；对照导出仓库与 HEAD 的树相同。HEAD 在整个验证期间停在 `3254d1b2d`（本 RFC 的落档提交）。

集中验证查出本 RFC 的问题，都在本 RFC 范围内修正（design §6 细化 1、5）：

1. 首批（候选 2）：`rfc310-architecture-lock` 报 domain 不纯——取 digital-employee 与 execution-contract 的 `public/types`、`@/util/gitRef`、
   `@/util/platformExec`，旧程序升级的模板文本也被它按正则认成 `node:fs`。改落 application（候选 3，细化 1），这一轮首批与刚起头的
   全量由本会话中止。
2. 首批（候选 3）：RFC-494 用例的文件名不带守卫普查认的词，RFC-317 的三本守卫账本（`rfc317-architecture-ledgers`、
   `rfc317-guard-corpus-floor`、`rfc317-guard-negative-fixture`）报 guard-manifest 比磁盘多一条；改名为 `…-boundary.test.ts`（候选 4）。
3. 首批（候选 3）：`rfc310-digital-employee-os-architecture` 的 OS 依赖清单差三条（取 execution-contract `public/types` 的两条随文件改指
   application，application 的新文件另取一次 digital-employee 的 `public/types`），按 D5 改指（候选 4）。

- **静态**：backend `tsc` 0 错（候选 3，`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动的 backend 文件、e2e 用例与 promise 规则
  都无告警；prettier：改动的 TS、JSON 与本 RFC 的三件套通过（`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。候选 4 只改了一个用例
  文件的文件名、两个 JSON 清单与 design，内容不变的部分沿用候选 3 的静态结果。
- **首批**（候选 3，按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：327 个文件
  （`tests/architecture/` 全部、本 RFC 改动与改指的用例、取员工类型包 / 执行合同 / 数字员工的用例、文档对账用例）。候选 2,917 条通过、
  5 条跳过、144 条红，对照（少本 RFC 用例）2,916 条通过、5 条跳过、138 条红。候选多红的 5 个文件：上面 2 的三个、3 的一个，以及
  `rfc376-structural-guards` 的计数用例撞自带的 20 秒（候选 21.9 秒、对照 18.5 秒；候选打出的 60 项实测都在 `counts.json` 的 `max` 内，
  与对照只差 `composition-control-flow-development-automation` 660 → 491，结论见下文放宽副本）。两边都红的 34 个文件：33 个撞 5 秒
  （用例本身或 beforeEach / afterEach 钩子；钩子超时后，同一 app 生命期里迟到的写被库代际栅栏拒，记成文件间的未处理错误）或撞用例
  自带的时限，逐文件失败名两边相同或只差 ±1～2 条、方向两边都有；`rfc471-development-delivery-code-host-bridge` 的负对照一条两边都红，
  因为这个跑法的 cwd 是 `packages/backend`（探针的相对路径按 cwd 解析，CI 在仓根跑）。
- **修复批**（候选 4）：上面 2、3 的四个用例与 RFC-494 用例全过（RFC-494 用例 7 / 7）。
- **两边都红的 33 个文件放宽默认时限复跑**（候选 4 与对照同时，默认 60 秒，其余同首批；架构报告 `rfc376-report` 另见下文）：两边都是
  554 条通过、5 条红，29 个文件全过，余下 4 个两边红在同样的用例：`rfc310-digital-employee-system-mock-e2e` 的 PostgreSQL 两例撞自带的
  180 秒（SQLite 两例通过）、`rfc310-employee-case-runtime` 与 `rfc396-mr-bridge` 的 PostgreSQL 各一例撞自带的 30 秒，以及上面
  `rfc471` 的 cwd 一条。这几处走的代码本 RFC 只改了 import，不归本 RFC（候选的绿不作通过依据）。
- **全量 SQLite**（候选 4；导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带
  时限的照旧；清单按耗时从慢到快排，3 个 worker）：2,938 个文件、2,919 个通过（23,869 条通过、127 条按环境跳过）；其余 19 个文件 24 条红，
  都不归本 RFC：
  - 三个报告类用例撞自带时限：`rfc294-architecture-preflight` 60 / 180 秒、`rfc370-committed-architecture-source` 150 秒、`rfc376-report`
    300 秒（超时后进程被结束，随后的 `git show` 断言跟着红），见下文放宽副本。
  - 余下 16 个与对照同时、同样跑法 A/B（各 2 个 worker；候选 104 条通过、11 条红，对照 106 条通过、9 条红）：
    - 6 个两边都过（全量红在撞自带时限或检查点等待）：`rfc398-auto-upgrade-resume-refused`（全量红在 SIGKILL both 一例撞自带的 240 秒；
      A/B 两边 377 秒、371 秒）、`rfc363-preparation-process-recovery`、`rfc354-nested-failure-modes`、`rfc395-v3-old-epoch-unpack`、
      `rfc098-wrapper-stale-redispatch`、`lifecycle-property`。
    - 8 个两边红在同样的用例：发布账本一条（`rfc321-repository-publication-ratchet`：账本记的提交不在导出仓库的历史里，导出仓库也不是
      浅克隆）；撞单条 60 秒的 `epoch1-permission-text-backup`；撞自带 30 秒的 `rfc400-collaboration-task-participants`、
      `rfc300-webhook-workspace-cleanup-e2e`、`rfc354-nested-frames-closure`、`rfc321-repository-publication-system-mock-e2e`、
      `rfc363-workspace-content`；`rfc167-dynamic-workflow-engine` 的 `settleTask` 等满 5 秒时任务仍是 running。
    - 2 个候选多红一条：`clarify-review-combination-scenarios`（两边都红 S-RFC074，候选另红 S3：都是文件自带的 20 秒看门狗中止全部任务、
      状态成 canceled）与 `rfc370-execution-effect`（候选红“real direct system target exists before receipt ACK”：等新起的 `bun -e`
      子进程写出启动标记，10 秒没等到）。两个文件的静态 import 闭包（1,867 与 712 个文件，含 clarify 起的桩进程脚本）不含本 RFC 的任何
      路径，逐个文件与对照逐字相同。两边同时各跑 3 轮：clarify 每轮两边都只红 S-RFC074；`rfc370-execution-effect` 每轮两边都红上面那条与
      “real direct owner receipt rejection …”（同一个 10 秒等待），第 1 轮候选另红一条取消用例、对照另红的 receipt rejection 一条，都撞
      自带的 30 秒。这两个文件不经过本 RFC 的代码（候选的绿不作通过依据）。
- **放宽副本**（候选 4 与对照同时，各 2 个 worker）：四个报告类用例——上面三个与首批候选撞 20 秒的 `rfc376-structural-guards`——各做一份
  只放宽时限的副本（全部时限 → 1,500 秒），两边都全过：`rfc376-structural-guards` 221 / 221（候选 254 秒、对照 253 秒）、`rfc376-report`
  16 / 16（560 秒、519 秒）、`rfc370-committed-architecture-source` 2 / 2（212 秒、212 秒）、`rfc294-architecture-preflight` 14 / 14（205 秒、
  214 秒）；跑完删除副本。`rfc376-structural-guards` 在全量里也在自带的 20 秒内通过（计数用例 4.6 秒）。
- **架构报告**（`scripts/architecture-report.ts`，候选 3、候选 4 与对照各出一份，两个候选相同）：60 项实测都在 `counts.json` 的 `max` 内，
  与对照只差 `composition-control-flow-development-automation` 660 → 491（= 新的 `max`；减少的 169 行都在迁出的内容里）；生产文件
  4,090 → 4,091（backend 3,226 → 3,227：三个新的 application 文件、删去两个 composition 文件）；跨 context import 7,504 → 7,504（15 条随文件
  迁到 application，context 对与符号相同）；变更入口 2,340 条里 7 条随 `runtimePackage` 与几个合同 schema 迁到新文件；其余各节逐项相同。
- **旧位置全仓扫描**（候选 4，工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍——没有指向
  迁走的两个 composition 文件的字面量，也没有指向 domain 下同名文件的；仍取 `composition/employeeTypePackage` 的 34 处（bootstrap 2、
  用例与 helper 25、e2e 6、同目录的 `graphDeliveryLifecycle.ts` 1）只取登记对象，bootstrap 另取三个转出（RFC-494 用例 ③ 钉住）。`design/`
  与 `STATE.md` 里没有指向旧目录名 `…-into-domain` 的链接。
- **收口文档**：plan、`STATE.md` 与 `docs/dev-gotchas.md` 定稿后重新同步到候选导出仓库，读这几处文档与 RFC 索引的 6 个用例
  （`docs-implementation-parity`、`docs-runbook-command-guard`、`rfc-index-status-drift`、`rfc310-ac-evidence-index`、
  `review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `e11313b6b`（实现，父提交是本 RFC 的落档提交 `3254d1b2d`）：exact SHA 主 CI run 43561287620 的 70 个 job 全部通过；这次推送没有按路径
  触发其他 workflow。
- 本 RFC 的落档提交 `3254d1b2d`（只改文档）：主 CI run 43519338266 通过。

## 收口后补正（2026-11-13）

- `architecture/commons-debt.json` 里指向类型包的两个锚点：实现提交 `e11313b6b` 只把 DE-13 的路径改到 application、行号照旧
  （`1412-1436`，design 当时写成“行号恰好不变”），CC-08 的锚点漏改、仍指 composition 的 `2631-2668`（composition 文件现只有 43 行）。
  脚本逐行比对原文件与 `application/employeeTypePackage.ts`：迁入的正文整体下移 2 行（只差三处加上的 `export`），两段原文逐字对应
  `1414-1438` 与 `2633-2670`，按此改正。RFC-317 的账本用例不校验锚点的行号与内容，`e11313b6b` 的 CI 不受影响；改正后
  `rfc317-architecture-ledgers` 与文档对账用例重跑通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。查出两处并已修正（落点从 domain 改为 application、bootstrap 的取处，design §6 细化 1、2），其余
逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **合同与编解码**：脚本比对 `application/employeeTypePackage.ts` 的正文（import 之后）与 HEAD 原文件第 37～3091 行、第 3114 行起逐行相等，
  唯一的改动是给 `runtimePackage`、`WorkContract`、`ToolImplementation` 加上 `export`；登记对象（第 3092～3112 行）逐字留在
  `composition/employeeTypePackage.ts`，从 application 取同一个 `runtimePackage` 与升级函数。import 按两边实际用到的名字重新生成。
- **两个依赖文件**：与 HEAD 的原文件 `diff`，只多了头注、改了取投影的相对路径（同层 `./`）；函数体与注释逐字不变。旧程序升级里的
  `node:fs` / `node:child_process` 在模板字符串里，是生成的兼容包装器源码，不是这个文件的 import。工具结果投影与 HEAD 相同。
- **bootstrap**：`src/bootstrap` 无改动；它取的三个值由 composition 从 application 转出，是同一组对象（`tsc` 0 错，RFC-494 用例 ② 钉住转出的
  名字）。
- **使用方**：生产 4 个、用例 18 个与测试 helper 1 个的改动只在 import 行（登记对象照旧取 composition）；读源码的四处登记与锁（架构报告的
  受管字段面、RFC-284 的进程启动点棘轮、RFC-317 的平台工作项 slotRef 两侧、RFC-323 的否定锁）、`commons-debt.json` 的锚点与 e2e 注释里的
  两处引用改指新文件，断言不变。
- **public 与装配**：public 不变；development-automation 的 composition 只少了迁出的内容，登记对象没有循环、`switch`、`try` 与 `throw`；
  跨 context 引用 15 条原样随文件迁到 application（同样的 context 对与符号）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（已提交，`3254d1b2d`，当时目录名为 `…-into-domain`）；实现与验证后再提交
`refactor(backend): RFC-494 开发自动化的员工类型包合同与编解码迁出 composition（RFC-294 S10 第一步）`，同一提交把 RFC 目录更名为
`…-out-of-composition`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
