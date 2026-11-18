# RFC-504 实施计划

依赖：RFC-503（Done）；与 S12 共用模块 composition 文件（本 RFC 删除 resource-catalog 的 `composition/builtinWorkflowCatalog.ts`，改
`composition/intentContextAuthorization.ts`、`composition/mcpOperations.ts`、`composition/resourcePackageOperations.ts`、
`composition/workgroupTaskRoom.ts` 与 resource-catalog `composition.ts` 的一条转出，改 bootstrap `daemonModules/digitalEmployee.ts` 与
`daemonHttpComposition.ts` 的 import 与调用）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态
自查。

## 任务

- **RFC-504-T1 用例归 application、IO 归 infrastructure**：资源包暂存、任务房的两个端口实现（连同两个端口接口）、意图上下文的授权核对迁入
  application，内建工作流目录与 MCP 的 ACL 测试失效迁入 infrastructure；工厂改名为 `create…`，资源包暂存的 id 改为传入（design D2）。
- **RFC-504-T2 composition 只装配**：删除 `composition/builtinWorkflowCatalog.ts`，经 `composition.ts` 转出、bootstrap 改取；四个组合文件只留
  装配入口与转出（design D3）。
- **RFC-504-T3 锁与账本**：改钉 `rfc401`、`rfc345` 的四处、`rfc231`、`rfc390`、`rfc305`；两个用例辅助改 import；`counts.json` 收紧（design D4）。
- **RFC-504-T4 用例**：新增 RFC-504 用例并登记 guard-manifest（design §4）。
- **RFC-504-T5 集中验证**：backend `tsc`、eslint；RFC-504 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-504-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的新位置声明（同名类型钉在原处）；删除的组合文件不存在、没有文件从它取名字；改名前的名字没有声明；四个
      组合文件没有控制流
- [x] AC-2 同样输入下五组行为的结果、错误与端口调用和此前一致；bootstrap 拿到的是同一份实现；资源包暂存与应用的 id 同源
- [x] AC-3 新位置的依赖面是闭集；跨 context 边、public surface 不升；`composition-control-flow-resource-catalog` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`96e678719` 主 CI run 44280453337 的 70 个 job 里 68 个通过，两格红都与提交无关（依赖审计与随之红的 `CI required`，见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 22～66，主要是本机其他进程）。验证在候选导出仓库里跑：`600d36322` 的树加本 RFC 的 28 个
路径（含一处删除），核对与工作树逐字相同；对照导出仓库与 `600d36322` 的树相同。验证期间 HEAD 没有前进。集中验证没有查出本 RFC 的
缺陷（静态一项里 `tsc` 报的新用例类型错误在功能验证起跑前已修正，见下）。

- **静态**：backend `tsc` 第 1 次只报 RFC-504 用例的一处类型错误（按文件名索引取 `TAKES` 时可能为 `undefined`），改为
  `[...(TAKES[location] ?? [])]` 后第 2 次退出码 0、无输出（工作树，代码与候选逐字相同；`tsconfig` 覆盖 `tests/`；验证从修正后的候选起跑）；
  eslint `--max-warnings 0`：改动与新增的 25 个 TS 文件无告警，`eslint.promises.config.js` 的规则对其中 14 个生产文件同样无告警；prettier：
  改动的 TS 与本 RFC 的三件套通过（`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 与 `docs/` 按约定
  不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：285 个文件
  （`tests/architecture/` 全部 140 个，以及 145 个相关用例：直接或经用例侧的辅助与夹具取到五个组合文件、三个新文件、三个扩充的文件或
  infrastructure 的 `workgroupTaskRoom.ts` 的用例，按名字与路径扫出的用例，直接取 bootstrap 的 `daemonModules/digitalEmployee.ts`、
  `daemonModules/resourceCatalog.ts`、`daemonModules/intent.ts`、`daemonHttpComposition.ts` 或 `daemonApplication.ts` 的用例与取它们的用例侧
  辅助的用例，含本 RFC 用例）。候选 3,425 条通过、373 条红（68 个文件），对照（少本 RFC 用例）3,415 条通过、367 条红（65 个文件）。
  - 本 RFC 用例 10 / 10。改钉新位置的锁两边都过：`architecture/rfc390-neutral-http-binding` 5 / 5、
    `architecture/rfc401-resource-write-participants` 3 / 3、`rfc305-architecture-lock` 15 / 15、`rfc345-intent-context-resource-authorization`
    4 / 4、`rfc345-resource-acl-facade-retirement` 3 / 3、`rfc345-resource-catalog-contracts` 18 / 18、`rfc345-workgroup-task-room-provider`
    6 / 6；`rfc231-private-copy` 对照 20 / 20、候选 19 / 20（PostgreSQL 一例撞默认的 5 秒，见复跑）。不改的锁两边都过：
    `architecture/rfc380-daemon-module-bundles` 9 / 9、`rfc359-w4-d16-adapters` 7 / 7。
  - 走迁出代码的用例两边相同：资源包暂存 `rfc271-package-upload-bounds` 11 / 11、`rfc359-w12-resource-package-commit-provider` 14 / 14；
    MCP 的 ACL 测试失效 `rfc238-mcp-runtime-test-transitions` 4 / 4；任务房 `rfc359-w4-d19b-adapters` 4 / 4、`rfc167-dw-e2e` 2 / 2、
    `rfc329-workgroup-pending` 12 / 12、`rfc359-w28-workgroup-snapshot-conformance` 7 / 7；意图上下文授权 `intent-privileged-node-capability`
    104 / 104、`rfc349-intent-boot-resume-authority` 8 / 8、`rfc358-intent-graph-validation` 46 / 46。两边红在同样用例、都撞时限的：
    `rfc167-dynamic-workflow-engine` 的三例 approve（默认的 5 秒）、`rfc359-w13-resource-package-apply-conformance` 与
    `rfc359-w15-workgroup-row-values-conformance`（PostgreSQL 一段的钩子撞 60 秒）、`rfc383-daemon-employee-automation-bundles`、
    `rfc384-daemon-intent-bundle` 等，见复跑。
  - 逐文件比失败名，候选多出 33 条：撞默认的 5 秒 23 条、钩子撞 5 秒 2 条、撞自带的 20 秒 1 条、PostgreSQL 一段的钩子撞 60 秒 4 条，
    `rfc370-mcp-diagnostics-family` 的轮询截止 1 条，`rfc238-mcp-runtime-test-service` 2 条（一条是用例自己 2 秒的轮询截止；一条读到会话已是
    `ended`、期望 `active`——同一文件前面几例撞时限，日志里有它们留下的服务仍在做周期对账的告警；这个文件只取 MCP 目录的装配入口，不取
    迁走的生命周期）。对照多出 27 条，同样这几类。
  - bootstrap `daemonModules/digitalEmployee.ts` 的文本读者（按源码读文件、不 import，首批的清单没有收）另跑一遍（SQLite，单条 60 秒）：
    12 个文件两边都是 84 / 84（`rfc310-digital-employee-os-architecture` 11 / 11、`rfc310-architecture-lock` 12 / 12、
    `rfc471-development-delivery-code-host-bridge` 17 / 17 与 RFC-370 的绑定用例等）。
- **红文件放宽默认时限复跑**（首批任一边红过的 69 个文件里，除报告类的 `rfc376-report` 外的 68 个；默认时限放宽到 60 秒、看门狗 3,000 秒，
  其余同首批；与全量同时）：候选 1,380 条通过、30 条红（16 个文件），对照 1,423 条通过、21 条红（11 个文件）；通过数差的 43 条全在下面
  撞钩子的 describe 里（钩子超时后同一 describe 余下的用例不再跑）与 `rfc238-mcp-runtime-test-service` 多红的两条。
  - 首批候选多出的 33 条：26 条两边都过（`rfc231-private-copy` 20 / 20，`rfc238-mcp-runtime-test-service` 读到 `ended` 的那一例，
    `rfc395-q1-clarify-history`、`skill-main-file-guard`、`rfc370-mcp-diagnostics-family` 等）；首批钩子撞 60 秒的 4 条所在的
    `rfc234-dump-builder` 与 `rfc359-w12` 的三个文件这一轮两边全过；其余 3 条一边过、另一边所在的 describe 撞了下面的钩子或轮询
    （`admin-only-gate` 一条与 `rfc238-mcp-runtime-test-service` 的幂等一例候选过，`agents` 一条对照过）。首批对照多出的 27 条同样：23 条
    两边都过，3 条钩子所在的文件两边全过，`reviews-comment-patch` 一条对照过、候选那一段撞钩子。首批两边都红的 `rfc359-w13`、
    `rfc359-w15`、`rfc380`、`rfc383`、`rfc304`、`rfc310-employee-outcome-summary`、`rfc349-digital-employee-platform-tools-wiring` 这一轮两边
    全过。
  - 这一轮的红都在 PostgreSQL 一段、都撞时限：
    - 钩子撞 60 秒（“a beforeEach/afterEach hook timed out”）：候选 19 条在 10 个文件（`admin-only-gate`、`agents`、
      `architecture/rfc359-w5-composition-root-route-surface`、`cached-repos-http-batch`、`cached-repos-http-submodule`、
      `inventory-in-flight-fallback`、`mcps-http`、`plugins-http`、`repos`、`reviews-comment-patch`），对照 12 条在其中 5 个文件
      （`admin-only-gate`、`agents`、`inventory-in-flight-fallback`、`mcps-http`、`plugins-http`）。这 10 个文件里通过的 PostgreSQL 用例
      两边最慢的每条 28～53 秒（各文件的中位数候选 4.5～37.5 秒、对照 6.0～35.3 秒，互有快慢），同一批文件的 SQLite 用例中位数 0.1～3.5 秒。
    - 用例自带的时限：`rfc238-mcp-runtime-test-service` 的 2 秒轮询（候选 6 条、对照 4 条，其中 3 条两边都红）；两边相同的是 `rfc300`
      （30 秒）、`rfc384` 的维护增量一例（15 秒）、`rfc359-w6-t26-postgresql-plan-audit` 装载十万行并 `vacuum analyze` 的钩子（600 秒，首批
      两边也红）与 `rfc167` 的 approve 一条（`settleTask` 5 秒）。
    - `rfc238-mcp-runtime-test-real-e2e` 两边同样红在一例（首批也是）：真实子进程退出后 stdout/stderr 的排空撞到生产代码的界限
      （`post-exit-flush-timeout`），会话随之结束，第二条消息被拒（409 `mcp-test-session-not-ready`）。
  - 这 16 个文件都取到本 RFC 的代码，全部进了放宽副本（见下文）。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的时限照旧；
  清单按耗时从慢到快排，3 个 worker；与首批、复跑同时）：2,949 个文件、2,928 个通过（23,980 条通过、127 条按环境跳过）；其余 21 个文件
  24 条红：
  - 三个报告类用例撞自带时限：`rfc294-architecture-preflight`（两例，60 秒与 180 秒）、`rfc376-report`（300 秒）、
    `rfc370-committed-architecture-source`（150 秒），见下文放宽副本。
  - 余下 18 个与对照同时、同样跑法 A/B（各 2 个 worker）：两边都是 148 条通过、13 条红（各 11 个文件）。失败名逐文件相同，只有两个
    `architecture/` 的源码扫描互换：候选红 `rfc349-schema-contract` 的“六张只归档的表没有生产消费方”一例（撞 60 秒，63.9 秒；对照整个文件
    21.0 秒通过），对照红 `rfc395-neutral-query-boundary` 的“业务查询不用方言终端”一例（撞 60 秒，64.0 秒；候选整个文件 56.2 秒通过）；两个
    文件都按源码读全部生产文件、不经 import 取到本 RFC 的代码；单独把这两例在两边同时跑一遍（默认时限放宽到 1,500 秒）：两边都过，墙钟
    23.7 / 23.2 秒与 52.4 / 51.8 秒，CPU（user + sys）13.4 / 13.1 秒与 25.8 / 26.6 秒，两边相同。两边红在同样用例的：撞自带时限的 `epoch1-permission-text-backup`（60 秒）、
    `rfc098-wrapper-stale-redispatch` 两例（各 20 秒）、`rfc300-webhook-workspace-cleanup-e2e`、`rfc321-repository-publication-system-mock-e2e`
    与 `rfc354-nested-frames-closure`（各 30 秒）、`rfc395-v1-source-evidence` 与 `rfc395-v1-source-readers`（各 40 秒）；`tasks` 两例（等仓库
    准备超过 5 秒）、`rfc167-dynamic-workflow-engine` 的 approve 一条（`settleTask` 等满 5 秒时任务仍是 running）与发布账本一条
    （`rfc321-repository-publication-ratchet`，账本记的提交不在导出仓库的历史里）。全量里红的 `review-state-machine` 两例（等调度器跑完上游
    节点的 `buildHarness` 用了 29.5 / 22.0 秒，超过 `beforeEach` 里 20 秒的流程看门狗，审阅节点没有建出）、`rfc395-q3-phase-planned`、
    `rfc395-ii-pre-architecture-lock`、`rfc359-w9-retry-rollback-parity`、`scheduler-audit-s17-readonly-starved-by-writer-queue` 与
    `rfc354-nested-loop-frames` 这一轮两边都过。
  - 静态 import 闭包（含按路径起的夹具）取到本 RFC 改动的生产文件的 894 个文件里 885 个通过（取到各改动文件的 255～745 个，都只差下面
    9 个里取到它的那些）。红的 9 个：`review-state-machine`、`tasks`、`rfc300`、`rfc167` 与 `scheduler-audit-s17-…` 取到全部 14 个改动的生产
    文件，`rfc098`、`rfc354` 的两个与 `rfc359-w9` 取到其中 4 个（`ports.ts`、resource-catalog 的 `composition.ts`、infrastructure 的内建工作流
    目录与 MCP 的 ACL 测试失效）；9 个都撞时限，放宽副本见下文。
- **放宽副本**（候选与对照同时，按首批的跑法、各 3 个 worker；默认时限放宽到 1,500 秒。用例自带的时限改在副本里：报告类三个、全量里红的
  9 个与复跑里红而带自带时限的 5 个，用例与钩子的时限都放宽到 1,500 秒，另有 `tasks` 等仓库准备的截止 5 → 500 秒、`rfc167` 的
  `settleTask` 等待 5 → 50 秒、`review-state-machine` 的流程看门狗 20 → 600 秒（git 与节点 10 → 100 秒）、`rfc300` 的轮询 15 → 150 秒、
  `rfc238-mcp-runtime-test-service` 的两个 2 秒等待与 `plugins-http` 的 2 秒等文件 → 200 秒、`rfc238-mcp-runtime-test-real-e2e` 的轮询
  12 → 120 秒，其余逐字；复跑里红的另 9 个没有自带时限，原样跑）：26 个文件，候选 505 条通过、2 条红，对照 502 条通过、5 条红；候选红的
  2 条对照同样红，没有只红在候选的用例。
  - 22 个文件两边都全过：三个报告类用例 `rfc376-report` 16 / 16（byte-identical 那一例候选与对照 455 / 477 秒，超出自带的 300 秒）、
    `rfc294-architecture-preflight` 14 / 14（public surface 一例 105 / 103 秒、能力归属一例 696 / 706 秒，超出自带的 60 秒与 180 秒）、
    `rfc370-committed-architecture-source` 2 / 2（那一例 231 / 218 秒，超出自带的 150 秒）；全量里红的 `tasks` 58 / 58（两例的 PostgreSQL 版
    30～36 秒）、`review-state-machine` 15 / 15、`rfc300` 2 / 2（42 / 42 秒）、`rfc167` 29 / 29（approve 一例 14 / 21 秒）、`rfc098` 4 / 4、
    `rfc354` 的两个、`rfc359-w9` 26 / 26（PostgreSQL 一例 62 / 48 秒）；复跑里红的 `admin-only-gate` 44 / 44、`agents` 44 / 44、`mcps-http`
    42 / 42、`plugins-http` 42 / 42、`inventory-in-flight-fallback` 25 / 25、`reviews-comment-patch` 34 / 34、`repos` 16 / 16、
    `cached-repos-http-batch` 14 / 14、`cached-repos-http-submodule` 2 / 2、`architecture/rfc359-w5-composition-root-route-surface` 2 / 2、
    `rfc384-daemon-intent-bundle` 12 / 12（维护增量一例的 PostgreSQL 版 22 / 23 秒）。
  - 候选全过、对照红一条的 2 个：`scheduler-audit-s17-readonly-starved-by-writer-queue`（对照的 PostgreSQL 一例两个写节点的子进程没有
    重叠）与 `rfc238-mcp-runtime-test-real-e2e`（对照的 PostgreSQL 一例同复跑：排空撞生产代码的界限）。
  - 两边同样红的 2 个：`rfc359-w6-t26-postgresql-plan-audit` 的 PostgreSQL 计划审计（装载十万行并 `vacuum analyze` 的钩子放宽到 1,500 秒
    仍超时，两边都只跑了账本形状的 5 条；本 RFC 不改任何查询）；`rfc238-mcp-runtime-test-service` 的 PostgreSQL“多轮续接、终态空闲 10 分钟
    才过期”一例（两边都在第一轮后读到会话已是 `ended`、期望 `active`；对照另红“旧子进程收不掉时开机恢复保留身份”一例）。两个文件分别经
    任务房的端口与协作文件、MCP 目录的组合文件与 `mcpRuntimeTestTransitions.ts` 取到本 RFC 的代码，迁移的函数体逐字（见实现门）。
  - 跑完删除副本，两个导出仓库恢复干净（候选 `bd6319f`、对照 `9ec329b`，工作区无改动）。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的 `max`）：
  - `composition-control-flow-resource-catalog` 92 → 77：少掉的 15 条正是五个文件的全部（`resourcePackageOperations.ts` 7、
    `builtinWorkflowCatalog.ts` 3、`intentContextAuthorization.ts` 2、`workgroupTaskRoom.ts` 2、`mcpOperations.ts` 1），没有新增；留下的 77 条是
    RFC-370 余项 72 条与 `resourcePackageMaintenance.ts` 2 条、`resourceAcl.ts`、`skillContentBinding.ts`、`skillVersionCommit.ts` 各 1 条。
  - 生产文件 4,108 → 4,110（backend 3,244 → 3,246：两个 application 新文件与一个 infrastructure 新文件，组合层删除一个）。
  - 跨 context import 7,503 → 7,503：context 对 135 → 135；11 条换了位置——7 条随内容迁到新位置（暂存文件的 `@/auth/actor` 类型、identity-access
    `public/participants` 的 `CommandContext` 类型与 `@/util/hash`，授权文件的 `DirectAuthenticatedAuthority` 类型，任务房文件的 `@/util/errors`，
    内建工作流目录的 `@/auth/systemIdentity` 与 platform 的 `PersistenceDb` 类型），bootstrap 的 4 条（`daemonHttpComposition.ts` 两条换成改名后的
    工厂、`daemonModules/digitalEmployee.ts` 一条改取 resource-catalog 的 `composition.ts`、`daemonModules/resourceCatalog.ts` 取
    `mcpAclRuntimeTestLifecycle` 的一条随符号归属换到 infrastructure）；目标符号只换了改名的三个工厂名。
  - public surface 1,195 → 1,195（identity-access 的 `CommandContext` 与 `DirectAuthenticatedAuthority` 两个条目的使用方边随 import 换成新位置）；
    模块符号归属 32,377 → 32,380（+20 −17：净多两个文件条目与 `createResourcePackageStagedExecution`，其余一一迁移或改名）；变更入口
    2,360 → 2,365（五个 `create…` 工厂在 application / infrastructure 记为入口，组合层此前不计；`StagedResourcePackageInput` 一项随暂存迁到新文件）；
    其余各节逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 44 处，都是预期的：
  本 RFC 用例的常量与负对照 26 处；改钉的锁（`rfc305` 的新边、`rfc345-resource-catalog-contracts` 的生命周期两条、`rfc345-resource-acl-facade-retirement`
  的暂存文件、`rfc231` 的任务房文件、`rfc401` 的场景、`rfc390` 的两个名字、`rfc345-intent-context-resource-authorization` 的解析器调用）；不改的锁
  （`rfc345-workgroup-task-room-provider` 断言 infrastructure 仍取两个端口类型、`rfc380` 的名字表、`rfc359-w4-d16-adapters` 读 bootstrap
  `daemonModules/resourceCatalog.ts` 里的 `lifecycle: mcpAclRuntimeTestLifecycle()`）；四处 import 取新位置。没有文件从删除的位置取名字。全部
  文件类型（含 JSON 与 markdown，已跟踪与未跟踪）按删除的路径与改名前的四个名字再扫：只剩本 RFC 三件套、`STATE.md`、RFC 索引、RFC-359 plan
  与 RFC-395 `ii0-revision.md` 的叙述，以及两个新位置里记来历的注释；JSON、配置与 `scripts/` 里没有按路径钉五个组合文件或迁走名字的账本
  （`tests/fixtures/rfc395-module-table-ownership-debt.json` 记的是 `infrastructure/workgroupTaskRoom.ts` 用到的表，本 RFC 不改它的取表）。
- **收口文档**：plan 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `600d36322` 的树加本 RFC 的 31 个路径（28 个代码与账本路径，以及
  RFC-504 的 plan、`STATE.md` 与 RFC-503 的 plan），读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、
  `docs-runbook-command-guard`、`rfc-index-status-drift`、`rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、
  `rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `96e678719`（实现，父提交是 `600d36322`）：exact SHA 主 CI run 44280453337 的 70 个 job 里 68 个通过，另两格红都与提交无关：
  - 「Static scans」的 dependency audit gate（high+critical）：本提交不改任何依赖清单与锁文件，同一步骤在父提交的 run 44228954525
    同样红；依赖面相同，按用户规则不分析、只记录。
  - `CI required` 随之红。
  - 其余 68 个 job 第 1 次全部通过，未重跑；同一推送另触发的 windows-platform run 44280453189 通过。
- 本 RFC 的落档提交 `600d36322`（只改文档，同一提交补记 RFC-503 转 Done 提交的 CI）：主 CI run 44228954525 共 70 个 job，68 个通过；红的
  两格与提交无关：「Static scans」的 dependency audit gate（high+critical）（依赖面没有变化，按用户规则不分析、只记录）与随之红的
  `CI required`。没有重跑。
- 补记（RFC-505 的落档提交）：转 Done 的 `a1a5b70a1`（只改文档）：主 CI run 44286472930 在本提交时仍排队，结果补记于 RFC-505 的实现提交。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **内建工作流目录**：脚本比对新文件与 HEAD 的 `composition/builtinWorkflowCatalog.ts`，差异只有三行文件头、四条 import 按新目录改为同目录的
  `./legacy/workflow`、`./resourceCatalogTransaction`、`./workflowMutationParticipant` 与 `./workflowPersistence`，以及工厂改名为
  `createBuiltinWorkflowCatalog`；`ensure` 的函数体逐字（读已有行、内容不符时抛错、缺失时在资源目录事务里以系统身份经工作流写入参与者建行
  并广播）。resource-catalog 的 `composition.ts` 转出它，bootstrap 改从这里取，参数仍是同一个 `db`。
- **意图上下文授权**：授权对接口与解析器是 HEAD 第 10～13 行与第 22～31 行逐字，解析器改名并导出；组合文件的工厂把同一个 `pair` 交给它，
  会话工厂与读端口的接线不变。
- **MCP 的 ACL 测试失效**：`mcpAclRuntimeTestLifecycle` 是 HEAD 第 74～92 行逐字（JSDoc 多一行记来历），类型改从同目录的
  `resourceAclRepository.ts` 取；组合文件转出同名函数，bootstrap 与用例的 import 不变，取到的是同一个函数。
- **资源包暂存**：类型是 HEAD 第 26～103 行逐字（JSDoc 一句随位置改写：留存一次性句柄的从组合层换成下面的暂存）；暂存的函数体是 HEAD
  第 119～154 行与第 163～214 行逐字，只把 `nextId` 改取 `deps.id`。组合文件只取一次 `deps.id ?? ulid`，同一个函数交给暂存与应用的 `ids`，
  暂存句柄、导出包 id 与应用的 id 仍同源；两张内存表仍随每次装配新建。
- **任务房协作**：两个工厂与另存投影是 HEAD 第 34～101 行逐字（两处改名，JSDoc 一处措辞去掉“的装配”）；两个端口接口是 HEAD
  infrastructure 第 50～67 行逐字，infrastructure 改从 application 的端口文件取类型、去掉不再用的 `WorkflowDefinition` 类型 import；
  `composeWorkgroupTaskRoom` 不变；`daemonHttpComposition.ts` 与用例辅助只换名字、参数不变。
- **锁与用例**：改钉的锁只换路径与名字，断言没有放松（`rfc345-resource-catalog-contracts` 改钉调用形式
  `await transitionMcpAclRuntimeTests(transaction, {`；`rfc345-intent-context-resource-authorization` 另加组合文件不再含核对的反向断言）；
  `rfc305` 的两条边改钉新文件，上下文对不变。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-503 转 Done 提交 `d0bcbd1c8` 的 CI）；实现与验证后再
提交 `refactor(backend): RFC-504 资源目录的内建工作流、资源包暂存、任务房协作、意图上下文授权与 MCP 测试失效迁出 composition（RFC-294 S10
第十一步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
