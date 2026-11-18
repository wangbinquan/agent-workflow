# RFC-503 实施计划

依赖：RFC-502（Done）；与 S12 共用模块 composition 文件（本 RFC 删除 intent 的 `composition/platformInventory.ts` 与
`composition/graphValidation.ts`，改 `composition/maintenance.ts` 的一个函数与一条类型 import、`composition/dispatch.ts` 的一行、intent
`composition.ts` 的两条转出，改 bootstrap `daemonModules/intent.ts` 的两条 import 与两处调用）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-503-T1 用例归 application**：平台清单参与者、图校验端口的实现与两条维护命令原样迁入 application 的三个新文件，工厂改名为
  `create…`，维护命令的时钟改为传入（design D2）。
- **RFC-503-T2 composition 只装配**：删除两个组合文件，经 `composition.ts` 转出、bootstrap 改取；`composeIntentMaintenanceCommands` 只交时钟；
  `dispatch.ts` 去掉多余的判空（design D3）。
- **RFC-503-T3 锁与账本**：`rfc349` 平台清单用例改取新位置；`rfc380` 的名字表换新名字；四个边账本改钉新文件（含 RFC-310 的 OS 架构清单，集中验证补出）；`counts.json` 收紧
  （design D4）。
- **RFC-503-T4 用例**：新增 RFC-503 用例并登记 guard-manifest（design §4）。
- **RFC-503-T5 集中验证**：backend `tsc`、eslint；RFC-503 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-503-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的新文件声明；两个组合文件不存在、没有文件从旧位置取名字；改名前的名字没有声明；`maintenance.ts` 与
      `dispatch.ts` 没有控制流
- [x] AC-2 同样输入下平台清单、图校验与两条维护命令的结果、日志与端口调用和此前一致；bootstrap 拿到的是同一份实现；开机恢复对空列表与非空
      列表的行为不变
- [x] AC-3 新文件的依赖面是闭集；跨 context 边、public surface 不升；`composition-control-flow-intent` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`448e40c78` 主 CI run 44222875990 的 70 个 job 里 68 个通过，两格红都与提交无关（依赖审计与随之红的 `CI required`，见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 23～87，主要是本机其他进程）。验证在候选导出仓库里跑：`2f0406cb5` 的树加本 RFC 的 18 个
路径（含两处删除），核对与工作树逐字相同；对照导出仓库与 `2f0406cb5` 的树相同。验证期间 HEAD 没有前进。集中验证查出本 RFC 的两处缺陷，
修复后复验，候选 3 定稿：

- **RFC-503 用例的转出筛选过宽**（首批查出）：② 的“intent 的 `composition.ts` 从新文件转出两个工厂”一例把 `composition.ts` 取 application
  的全部转出都算进来，而 `composition.ts` 在本 RFC 之前就转出 `application/maintenanceJobs`（RFC-399），这一例因此红。改为只看三个新文件的
  转出，负对照加一条既有的 `maintenanceJobs` 转出与一条 `maintenanceCommands` 的转出，断言前者不计、后者被查出（候选 2；guard-manifest 的
  行数 545 → 560）。本 RFC 用例与读 guard-manifest 的四个用例（`rfc317-guard-corpus-floor`、`rfc317-guard-negative-fixture`、
  `rfc317-architecture-ledgers`、`rfc374-node-run-order-guard`）复跑 71 / 71。
- **RFC-310 的 OS 架构清单漏改**（全仓扫描查出）：`design/RFC-310-…/os-architecture-manifest.json` 第 47 行按路径记着
  `modules/intent/composition/platformInventory.ts -> public/participants`，`rfc310-digital-employee-os-architecture` 把 digital-employee 的外部
  import 与清单逐条等值比对。改钉新文件（候选 3，第 18 个路径；design §1、D4、§5 与 T3 同步写成四个边账本）。该用例候选与对照各 11 / 11；
  候选换回旧清单时红（退出码 1，差异正是这一条）。候选 2 → 3 只差这一行。

- **静态**：backend `tsc` 退出码 0、无输出（工作树，代码与候选逐字相同；`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动与新增的
  13 个 TS 文件无告警，`eslint.promises.config.js` 的规则对其中 7 个生产文件同样无告警；prettier：改动的 TS、本 RFC 的三件套与 RFC-310 的
  清单通过（`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法；候选 1）：224 个文件
  （`tests/architecture/` 全部 140 个，以及 84 个相关用例：直接或经用例侧的辅助与夹具取到改动的组合文件、intent `composition.ts` 或三个新
  文件的用例，按名字与路径扫出的用例，直接取 bootstrap 的 `daemonModules/intent.ts`、`maintenanceWorkerGraph.ts` 或 `daemonApplication.ts`
  的用例与取它们的用例侧辅助的用例，含本 RFC 用例）。候选 2,538 条通过、301 条红（49 个文件），对照（少本 RFC 用例）2,541 条通过、298 条红
  （47 个文件）。
  - 改钉新位置的锁与改取新文件的用例两边都过：`architecture/rfc294-review-offered-edge-dag` 8 / 8、`architecture/rfc376-structural-guards`
    221 / 221、`architecture/rfc380-daemon-module-bundles` 9 / 9、`rfc305-architecture-lock` 15 / 15、`rfc349-intent-platform-inventory-composition`
    3 / 3。走两条维护命令、图校验与开机恢复的用例两边相同：`rfc349-intent-integration-maintenance` 2 / 2、`rfc358-intent-graph-validation`
    46 / 46、`rfc389-maintenance-worker-root` 6 / 6、`rfc389-maintenance-worker-graph` 10 / 10、`rfc338-maintenance-architecture` 3 / 3、
    `rfc349-intent-boot-resume-authority` 8 / 8；`rfc384-daemon-intent-bundle`（10 / 12）与 `rfc395-q3-application-restart`（1 / 2）两边红在
    同样的用例，见复跑。
  - 逐文件比失败名，候选多出 11 条：本 RFC 用例一条（上文的筛选缺陷），其余 10 条撞时限——默认的 5 秒 5 条（其中 `rfc311-repos-page` 一条是
    钩子撞 5 秒后、仍在跑的组合碰上数据库换代的围栏，对照同文件 7 条同样如此），自带的 30 秒 3 条、20 秒 1 条，`rfc384` 的 PostgreSQL 一段
    钩子撞 60 秒 1 条（对照同一段撞默认的 5 秒）。对照多出 7 条，都撞时限。
- **红文件放宽默认时限复跑**（首批任一边红过的 51 个文件里，除报告类的 `rfc376-report` 外的 50 个；默认时限放宽到 60 秒、看门狗 3,000 秒，
  其余同首批；对照少本 RFC 用例；候选 2 起跑，候选 3 只多改 RFC-310 的清单，这 50 个文件不读它）：候选 903 条通过、5 条红，对照 903 条
  通过、5 条红。
  - 首批候选多出的 11 条：本 RFC 用例 9 / 9；9 条两边都过（含 `rfc384` 钩子撞 60 秒的那一段）；1 条仍只红在候选——
    `rfc395-af2-daemon-wiring` 的 PostgreSQL「hosted-targeted-resume」一例撞自带的 30 秒（30.7 秒，对照 23.0 秒；首批是 33.2 / 31.2 秒）。
    这个文件的 PostgreSQL 用例每条 17～33 秒（首批与复跑两边共 36 条）、不少贴着 30 秒，逐条耗时两边互有快慢（首批候选慢 10 条、快 8 条，复跑 12 / 6；整文件
    +1.2% / +2.8%；首批对照也有一条撞 30 秒），同一例的 SQLite 版两边都是 0.4～0.7 秒；放宽副本见下文。
  - 这一轮对照多出 1 条（`tasks-multipart` 的 PostgreSQL 一例撞自带的 30 秒）。两边都红的 4 条：
    `architecture/rfc400-collaboration-task-participants` 的源码扫描（自带的 30 秒，不取本 RFC 路径）、`rfc167` 的 approve 一条（同下文全量）、
    `rfc300`（30 秒）与 `rfc384` 的 PostgreSQL 维护增量一例（自带的 15 秒）。取到本 RFC 代码、这一轮任一边红的文件都做了放宽副本。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的时限照旧；
  清单按耗时从慢到快排，3 个 worker；与首批、复跑同时；跑到一半时候选由 1 换成 2、3，见下）：2,948 个文件、2,934 个通过（23,977 条通过、
  127 条按环境跳过）；其余 14 个文件 17 条红：
  - 本 RFC 用例一条：上文的筛选缺陷（这个文件在候选 1 上跑）。候选 2、3 只改本 RFC 用例、guard-manifest 的行数与 RFC-310 的清单：前两者的
    读者已在候选 2 上复跑（见上文），`rfc310-digital-employee-os-architecture` 在全量里落在候选 3 之后、通过。
  - 三个报告类用例撞自带时限：`rfc294-architecture-preflight`（两例，60 秒与 180 秒）、`rfc376-report`（300 秒）、
    `rfc370-committed-architecture-source`（150 秒），见下文放宽副本。
  - 余下 10 个与对照同时、同样跑法 A/B（各 2 个 worker）：候选 81 条通过、10 条红，对照 82 条通过、9 条红。失败名逐文件相同，只有
    `lifecycle-property` 候选多红“1～8 个事件”一例（撞自带的 15 秒，15.9 秒；对照 15.8 秒通过；这个文件的静态 import 闭包不取本 RFC 的
    任何路径；全量里它的第二例红是第一例超时后、仍在跑的属性检查与下一例争用数据库的连带）。`tasks` 两边 29 / 29（全量里两例等仓库准备
    超过 5 秒）。其余两边红在同样的用例：发布账本一条（`rfc321-repository-publication-ratchet`，账本记的提交不在导出仓库的历史里）；撞自带
    时限的 `rfc395-restore-epoch-routing`、`rfc300-webhook-workspace-cleanup-e2e`、`rfc321-repository-publication-system-mock-e2e`、
    `rfc354-nested-frames-closure`（各 30 秒）、`rfc098-wrapper-stale-redispatch` 两例与 `rfc354-nested-loop-frames`（各 20 秒）；
    `rfc167-dynamic-workflow-engine` 的 approve 一条（`settleTask` 等满 5 秒时任务仍是 running）。
  - 静态 import 闭包（含按路径起的夹具）取到本 RFC 改动代码的 268 个文件里 265 个通过（取到三个新文件的 261～263 个、`composition/maintenance.ts`
    的 261 个、`composition/dispatch.ts` 的 255 个、intent `composition.ts` 的 262 个、bootstrap `daemonModules/intent.ts` 的 255 个，各自只差
    这 3 个）；红的 3 个是 `tasks`、`rfc300` 与 `rfc167`，它们的放宽副本见下文。
- **放宽副本**（候选与对照同时，按首批的跑法、各 2 个 worker；默认时限与用例自带的时限都放宽到 1,500 秒，`tasks` 等仓库准备的截止
  5 → 500 秒、`rfc167` 的 `settleTask` 等待 5 → 50 秒、`tasks-multipart` 的流程时限 20 → 600 秒（git 与节点 10 → 100 秒、收尾 5 → 50 秒），
  其余逐字）：9 个文件两边都全过（各 171 / 171）。
  - 三个报告类用例：`rfc376-report` 16 / 16（byte-identical 那一例候选与对照 736 / 735 秒，超出自带的 300 秒）、
    `rfc294-architecture-preflight` 14 / 14（public surface 一例 183 / 96 秒、能力归属一例 557 / 537 秒，超出自带的 60 秒与 180 秒）、
    `rfc370-committed-architecture-source` 2 / 2（那一例 117 / 62 秒；全量里 329 秒，超出自带的 150 秒）。两边的用例次序随 `--randomize`
    不同、与别的文件并发的时段也不同；为排除迁移让分析变重，单独把 public surface 与 `rfc370` 那两例在两边同时跑一遍：墙钟 142 / 141 秒与
    257 / 261 秒，CPU（user + sys）37.2 / 37.5 秒与 73.8 / 74.6 秒，两边相同。
  - 全量 SQLite 里红、取到本 RFC 代码的 3 个：`tasks` 58 / 58（两种 provider）、`rfc300-webhook-workspace-cleanup-e2e` 2 / 2（33 / 36 秒，
    超出自带的 30 秒）、`rfc167-dynamic-workflow-engine` 29 / 29（approve 一例 12 / 14 秒）。
  - 复跑里任一边红、取到本 RFC 代码的 3 个：`rfc395-af2-daemon-wiring` 18 / 18（只红在候选的 hosted-targeted-resume 一例 PostgreSQL
    21.3 / 22.3 秒，这一轮在自带的 30 秒内）、`rfc384-daemon-intent-bundle` 12 / 12（PostgreSQL 维护增量一例 21.6 / 21.6 秒，超出自带的
    15 秒）、`tasks-multipart` 20 / 20。
  - 跑完删除副本，两个导出仓库恢复干净。
- **架构报告**（`scripts/architecture-report.ts`，候选 1 与对照各出一份；候选 2、3 只改用例与两份清单，报告不读它们）：60 项实测都在
  `counts.json` 的 `max` 内，与对照只差一项（= 新的 `max`）：
  - `composition-control-flow-intent` 23 → 5：少掉的 18 条正是两个删除的组合文件（9 + 5）、`maintenance.ts` 的 3 条与 `dispatch.ts` 的 1 条，
    没有新增；留下的 5 条是 `resourceCatalog.ts` 1 条与 RFC-370 余项 `crewstationArtifacts.ts` 3 条、`crewstationScratch.ts` 1 条。
  - 生产文件 4,107 → 4,108（backend 3,243 → 3,244：application 三个新文件，组合层删除两个）。
  - 跨 context import 7,503 → 7,503：context 对 135 → 135，没有新的符号；10 条换了文件——8 条类型 import 随内容迁到两个新文件
    （`@/auth/actor` 两条，development-automation `public/operations`、digital-employee 与 identity-access 的 `public/participants`，
    resource-catalog 的 `public/participants` 与 `public/queries` 两条），bootstrap 的 2 条从两个删除的组合文件改为 intent 的 `composition.ts`。
  - public surface 1,195 → 1,195（6 个条目的使用方边随 import 换成新文件）；模块符号归属 32,374 → 32,377（组合文件的 11 项迁成 application 的
    14 项：净多一个文件条目，另加 `IntentMaintenanceCommandDependencies` 与 `createIntentMaintenanceCommands`）；变更入口 2,357 → 2,360（三个
    `create…` 工厂在 application 记为三项，组合层此前不计；`publishState` 一项随平台清单迁到新文件）；其余各节逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 37 处（import 7 处、
  字面量 30 处），都是预期的：import 里，`composition.ts` 与 `maintenance.ts` 取三个新文件，`rfc349` 用例改取新文件，另三处是 application 里
  早就有的同名消费方文件（`platformInventory.ts`、`graphValidation.ts`，RFC-401 起）的本模块 import；字面量里，按路径钉文件的锁已改钉新文件
  （`rfc305`、`rfc294-review-offered-edge-dag`、`rfc376-structural-guards`），`rfc380` 的名字表是新名字，其余 23 处是本 RFC 用例的常量与
  负对照。没有文件从旧位置取名字。全部文件类型（含 JSON 与 markdown，已跟踪与未跟踪）按路径片段再扫：除上文 RFC-310 的清单（已改）外，
  只剩本 RFC 三件套、`STATE.md`、RFC 索引的叙述与新文件、用例里记来历的注释；`design/`、`docs/` 与 `STATE.md` 里没有指向两个删除文件的
  链接。
- **收口文档**：plan 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `2f0406cb5` 的树加本 RFC 的 22 个路径（18 个代码与账本路径，以及 RFC-503
  的 design、plan、`STATE.md` 与 RFC-502 的 plan），读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、
  `docs-runbook-command-guard`、`rfc-index-status-drift`、`rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、
  `rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `448e40c78`（实现，父提交是 `2f0406cb5`）：exact SHA 主 CI run 44222875990 的 70 个 job 里 68 个通过，另两格红都与提交无关：
  - 「Static scans」的 dependency audit gate（high+critical）：本提交不改任何依赖清单与锁文件，同一步骤在父提交的 run 44185405801
    同样红；依赖面相同，按用户规则不分析、只记录。
  - `CI required` 随之红。
  - 其余 68 个 job 第 1 次全部通过，未重跑；同一推送没有触发别的 workflow。
- 本 RFC 的落档提交 `2f0406cb5`（只改文档）：主 CI run 44185405801 第 1 次 70 个 job 里 66 个通过，另四格红与提交无关：
  - 「Static scans」的 dependency audit gate（high+critical）：依赖面没有变化，按用户规则不分析、只记录；
  - macOS 的 e2e 分片 4/4 没有分到 runner（0 个步骤）；
  - backend 分片 16/44：`rfc311-perf-guards` 的「task-operations catalog — 过滤视图（G1 快路径）」[sqlite] 一例，AC-11 的塌缩检测比出
    PostgreSQL 的 P95 10,015ms 对 SQLite 的 136.6ms（73.3 倍）。这个提交只改文档，代码树与 `249e9f0b0` 相同，后者的 backend 分片全部通过，
    是那台 runner 上 PostgreSQL 慢；
  - `CI required` 随之红。
  - 只重跑失败的作业：第 2 次 macOS 的 e2e 分片 4/4（17 个步骤）与 backend 分片 16/44 都通过，依赖审计仍红（外部，与提交无关）。
- 转 Done 的 `d0bcbd1c8`（只改文档）：主 CI run 44227363882 的 70 个 job 里 68 个通过（补记于 RFC-504 的实现提交）：依赖审计红（外部，与提交无关）
  与随之红的 `CI required`，其余全部通过，未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **平台清单参与者**：脚本比对新文件与 HEAD 的 `composition/platformInventory.ts`，差异只有 design D2 列的几处——三行文件头、端口类型的
  import 按新目录改写为 `./ports/intentAuxiliaryQueries`、依赖接口与工厂两处改名；私有函数与工厂的函数体逐字。
- **图校验端口**：文件头按 D2 改写（加 RFC-503 一行：知道“由谁提供”的地方换成这个文件，application 的其余代码仍只见端口），端口类型的
  import 按新目录改写，工厂改名；函数体逐字。
- **维护命令**：`IntentMaintenanceLog` 与两条命令逐字迁入，只有两处 `input.now ?? Date.now()` 改为 `input.now ?? dependencies.now()`；
  `composeIntentMaintenanceCommands` 交的是 `() => Date.now()`，进程时钟仍在调用时取。组合文件把传入的依赖展开成新对象、再加上时钟交给
  工厂；它的两处调用方（按 app home 的装配、`rfc349-intent-integration-maintenance`）每次都传新的对象字面量，与此前直接读传入的对象等价
  （传入对象上即使带 `now` 也被覆盖成进程时钟，与此前一律取 `Date.now()` 相同）。
- **开机恢复**：`dispatch.ts` 去掉判空后，application 的 `resumeQueuedIntentWorkingSets` 收到空数组：`??` 不把空数组当缺省，不列表、
  循环不进、返回 0，组合层照旧返回 `void`，与此前直接返回相同（只多一次 `await`）。
- **装配、锁与用例**：bootstrap 经 intent `composition.ts` 的转出取到的是同一份实现，两处调用只换名字、参数不变；用例与账本只改钉路径与名字，
  断言没有放松；RFC-503 用例的筛选修正收窄到三个新文件，并用负对照钉住既有转出不计、新文件的转出被查出。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-502 转 Done 提交 `7d2e82937` 与用例修正 `249e9f0b0`
的 CI）；实现与验证后再提交 `refactor(backend): RFC-503 意图的平台清单、图校验与维护命令迁出 composition（RFC-294 S10 第十步）`。走私有
index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
