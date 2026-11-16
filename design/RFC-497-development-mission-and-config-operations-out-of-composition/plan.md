# RFC-497 实施计划

依赖：RFC-496（Done）；与 S12 共用模块 composition 文件（本 RFC 只动 development-automation 的 `composition/missionOperations.ts`、
`composition/configOperations.ts` 与 `composition.ts` 里模块参与方接口的声明）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-497-T1 mission 用例迁入 application**：第 55～98 行、输入接口、持久化接口与第 128～703 行的用例原样迁入
  `application/missionOperationHandlers.ts`；基线解析与时钟取输入，合同类型改取同层文件（design D2）。
- **RFC-497-T2 参与方端口**：用例用到的 10 个成员迁入 `application/ports/developmentMissionAutomation.ts`，`DevelopmentAutomationModule`
  改为继承它（design D3）。
- **RFC-497-T3 配置用例迁入 application**：第 54～152 行、输入接口与第 154～656 行的用例原样迁入 `application/configOperationHandlers.ts`
  （design D4）。
- **RFC-497-T4 composition 只留装配**：两个文件只留组合输入类型（形状不变）、准入开关的查询投影、装配函数与 ACL 参与方类型的转出
  （design D5）。
- **RFC-497-T5 锁、账本与清单**：读用例源码的锁改指新文件；`rfc305-architecture-lock` 的跨 context 使用方清单改指；`counts.json` 收紧
  （design D6）。
- **RFC-497-T6 用例**：新增 RFC-497 用例并登记 guard-manifest（design §4）。
- **RFC-497-T7 集中验证**：backend `tsc`、eslint；RFC-497 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-497-T8 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在新的 application 文件声明；两个 composition 文件只声明、只交出组合输入类型、准入开关的查询投影与装配函数
      （配置一侧另外转出 ACL 参与方类型），没有控制流语句；`DevelopmentAutomationModule` 继承端口、只另外声明其余成员；没有文件从旧
      位置取迁出的名字
- [x] AC-2 同样输入下两组操作的返回、错误码、外部调用的次序与参数和此前一致；基线解析与时钟仍在装配时建一次，ACL 判定照旧经 Resource
      Catalog 交来的参与方
- [x] AC-3 新文件的依赖面是闭集（不取 infrastructure、composition、IO 包与进程全局）；跨 context 边、public surface 不升；组合层控制流
      收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`b01642940` 主 CI run 43784575765 的 70 个 job 全部通过（见 §CI）

## 集中验证（2026-11-15，候选 1）

本机全程高负载（10 核；采样到的 1 分钟负载 39～58，主要是本机其他进程）。验证在候选导出仓库里跑：HEAD 的树加本 RFC 的 15 个路径，核对
与工作树逐字相同；对照导出仓库与 HEAD 的树相同。HEAD 在整个验证期间停在 `1e31f3bc9`（本 RFC 的落档提交）。集中验证没有查出本 RFC 的问题，候选 1 即定稿。

- **静态**：backend `tsc` 0 错（工作树，代码与候选逐字相同；`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动的 13 个 TS 文件无
  告警，`eslint.promises.config.js` 的规则对改动的生产文件同样无告警；prettier：改动的 TS 与本 RFC 的三件套通过（`architecture/` 的账本按
  `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：448 个文件
  （`tests/architecture/` 全部 140 个，以及 308 个相关用例：RFC-496 首批的相关用例，加上按两组操作的名字与内容扫出、此前不在内的 4 个用例
  与本 RFC 用例）。候选 4,255 条通过、5 条跳过、324 条红（66 个文件），对照（少本 RFC 用例）4,233 条通过、5 条跳过、330 条红（70 个文件）。
  - RFC-497 用例 13 / 13；改指的锁里 `rfc305-architecture-lock` 15 / 15、`architecture/rfc317-acl-write-gate-guard` 13 / 13、
    `rfc344-operation-catalog` 23 / 23、`rfc349-development-admission-postgresql-adapter` 4 / 4 两边都过；`rfc310-pr9-cutover` 两边红在同样的
    6 条（PostgreSQL 的钩子撞默认的 5 秒）、`rfc471-development-delivery-code-host-bridge` 两边红在同样的负对照一条（见下文复跑）。
  - 逐文件比失败名，候选有对照之外失败名的 9 个文件（含候选红而对照不红的 4 个）共 13 条，都是 PostgreSQL 撞时限：12 条撞默认的 5 秒
    （5.8～8.4 秒），`rfc370-evidence-artifact-root-bindings` 一条撞自带的 20 秒（21.1 秒）。静态 import 闭包取到本 RFC 路径的只有起整个应用
    的 `rfc370-evidence-artifact-root-bindings` 与 `rfc359-w12-performance-http-conformance`，其余 7 个不经过本 RFC 的代码。
- **红文件放宽默认时限复跑**（首批两边红的 74 个文件里，除两个报告类用例（见下文放宽副本）外的 72 个；默认时限放宽到 60 秒、看门狗
  3,000 秒，其余同首批）：候选 1,256 条通过、18 条红（9 个文件），对照 1,253 条通过、19 条红（9 个文件）。首批候选多出失败名的 9 个文件，
  7 个在这里两边都过；`rfc257-webhook-ingress` 两边只红在同样的一条（自带的 30 秒，见下）；`rfc395-retired-runtime-shapes` 候选通过
  （对照的 PostgreSQL 钩子撞 90 秒）。
  - 候选多出的失败名只有一条：`rfc384-daemon-intent-bundle` 的 PostgreSQL 一例（maintenance deltas）撞自带的 15 秒，15.96 秒；对照 14.08 秒
    通过，首批两边都撞这 15 秒（15.7 / 15.5 秒）。它起整个应用，静态 import 闭包取到本 RFC 的全部 6 个生产路径，放宽副本见下文。
  - 候选余下的红两边相同：撞用例自带时限的 `rfc257-webhook-ingress` 30 秒、系统模拟 E2E 的 PostgreSQL 两例 180 秒、
    `rfc310-employee-case-runtime` 与 `rfc396-mr-bridge` 的 PostgreSQL 各一例 30 秒、`rfc311-perf-guards` 的 PostgreSQL 各路径 180 秒与钩子
    30 秒（连带跨引擎对比的汇总一条）；钩子超时的 `rfc359-w6-t26-postgresql-plan-audit`（600 秒）；环境两条：发布账本
    （`rfc321-repository-publication-ratchet`）与 `rfc471-development-delivery-code-host-bridge` 的负对照（这个跑法的 cwd 是
    `packages/backend`，全量 SQLite 在仓根跑，17 / 17）。对照多红的是 `rfc395-retired-runtime-shapes` 的钩子。
  - 两边红在同样用例的这些文件里，静态 import 闭包含本 RFC 路径的只有 `rfc471`（源码扫描判据，红的是负对照）；`rfc311-perf-guards` 的
    两条 mission 路径直接调持久层的读函数 `listMissionSummariesPage` / `listMissionTerminalOutcomeGroups`，不经过本 RFC 迁动的用例。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的时限照旧；
  清单按耗时从慢到快排，3 个 worker）：2,941 个文件、2,925 个通过（23,910 条通过、127 条按环境跳过）；其余 16 个文件 18 条红，都不归本 RFC：
  - 两个报告类用例撞自带时限：`rfc294-architecture-preflight` 60 / 180 秒、`rfc376-report` 300 秒，见下文放宽副本。
  - 余下 14 个与对照同时、同样跑法 A/B（各 2 个 worker）：候选 116 条通过、9 条红，对照 115 条通过、10 条红；候选没有对照之外的失败名。
    - 4 个两边都过：`rfc098-wrapper-stale-redispatch` 与 `rfc354-nested-loop-frames`（全量红在自带的 20 秒）、`start-task-url`（30 秒）、
      `lifecycle-property`（15 秒）。
    - `tasks` 候选通过、对照红一条（`GET /:id/diff` 的仓库准备没有在等待内落定；全量里候选红的是同一条）。
    - 9 个两边红在同样的用例：发布账本一条（`rfc321-repository-publication-ratchet`：账本记的提交不在导出仓库的历史里）；撞自带时限的
      `rfc400-collaboration-task-participants`、`rfc300-webhook-workspace-cleanup-e2e`、`rfc354-nested-frames-closure`、
      `rfc321-repository-publication-system-mock-e2e`、`rfc363-workspace-content`（各 30 秒）与 `clarify-review-combination-scenarios` 的
      S-RFC074（三个代理依次跑，20 秒时被测试的超时处理取消）；`rfc167-dynamic-workflow-engine` 的 approve 一条（`settleTask` 等满 5 秒时
      任务仍是 running）；`rfc370-execution-effect` 一条（等新起的子进程写出启动标记，10 秒没等到）。
    - 这 14 个文件里，静态 import 闭包取到本 RFC 路径的只有起整个应用的 `tasks`、`rfc300-webhook-workspace-cleanup-e2e` 与
      `rfc167-dynamic-workflow-engine`：`tasks` 候选通过，另两个两边红在同样的用例。
  - mission 与配置相关的用例在全量里全过：RFC-497 用例 13 / 13。mission 一侧：旅程 `rfc310-pr3-journey` 8 / 8、切换 `rfc310-pr9-cutover`
    18 / 18、流水线证据内容 2 / 2、非法请求体 12 / 12、mission 页 4 / 4、操作目录 23 / 23、准入的 PostgreSQL 适配 4 / 4、存储与 worker 根绑定
    10 / 10、`rfc359-w4-d12-adapters` 6 / 6、交付桥 17 / 17、模块组合根 6 / 6、daemon 模块包 9 / 9、员工自动化包 12 / 12；取模块参与方类型的
    旅程与端到端用例 `rfc310-pr4-journey` 5 / 5、`rfc310-pr7b-conflict-repair-journey` 9 / 9、`rfc310-t109-full-journey-e2e` 2 / 2、
    `rfc317-work-start-bind` 6 / 6、`rfc310-pr5-e2e-java` 1 / 1。配置一侧：配置路由错误 5 / 5、配置资源写门 35 / 35、写门守卫 13 / 13、
    ACL 矩阵 79 / 79、员工定义 ACL 8 / 8、创建合同 7 / 7、剧本协调 12 / 12、引导旅程 1 / 1、`rfc305-architecture-lock` 15 / 15。
- **放宽副本**（候选与对照同时，按首批的跑法、默认 60 秒，各 2 个 worker）：两个报告类用例与 `rfc384-daemon-intent-bundle` 各做一份只放宽
  时限的副本（用例自带的时限 → 1,500 秒）。两边都全过（42 / 42）：候选 `rfc376-report` 16 / 16（872 秒）、`rfc294-architecture-preflight`
  14 / 14（682 秒）、`rfc384-daemon-intent-bundle` 12 / 12——PostgreSQL 那一例候选 20.3 秒、对照 17.2 秒，两边都超出自带的 15 秒；这个文件
  PostgreSQL 的其余几例两边快慢互有先后（例如 HTTP 注入边界一例候选 13.9 秒、对照 17.0 秒）。跑完删除副本，两个导出仓库恢复干净。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内，与对照只差
  `composition-control-flow-development-automation` 274 → 195（= 新的 `max`；少掉的 79 条是 `composition/missionOperations.ts` 的 61 条与
  `composition/configOperations.ts` 的 18 条，没有新增）；生产文件 4,096 → 4,099（backend 3,232 → 3,235，即三个新的 application 文件）；
  跨 context import 7,504 → 7,504（8 条随内容迁到 application：取 identity-access `public/participants` 的一条与取 `@/util` 的七条，context 对与
  符号相同）；public surface 1,195 → 1,195（只有 identity-access 的 `DirectAuthenticatedAuthority` 一项的使用方边随那条 import 换成新文件）；
  模块符号归属 32,360 → 32,367（17 个名字随内容迁到 application，`composeDevelopmentMissionOperationsFromPersistence` 由
  `createDevelopmentMissionOperations` 取代；另加 3 个新文件本身、两个输入类型、`createDevelopmentConfigOperations` 与端口
  `DevelopmentMissionAutomation`）；变更入口 2,343 → 2,345（多出 application 的两个 `create…Operations`；只进清单、没有钉住的计数）；其余各节
  逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 34 处，都是预期的：
  import 13 处（bootstrap 与 3 个用例取组合名字、composition 取新文件、`public/operations` 取两份合同、新文件取端口与合同）；其余 21 处是
  改指后的锁与 RFC-497 用例的负对照，按 D6 仍读 composition 文件的 `rfc344-operation-catalog`、`rfc370-storage-and-worker-root-bindings`、
  `rfc359-w4-d12-adapters`，读合同文件的前端用例 `code-config-api-base` 与 `rfc344` / `rfc305` 的合同条目，以及 `rfc383` 里装配包的键名
  `missionOperations`。`design/`、`docs/` 与 `STATE.md` 里没有指向这两个文件的链接；带路径提到它们的是 RFC-370 的接缝清单与 RFC-380 /
  RFC-383 / RFC-471 的设计记述（当时的锚点），不改。
- **收口文档**：plan 与 `STATE.md` 定稿后重新同步到候选导出仓库，读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、
  `docs-runbook-command-guard`、`rfc-index-status-drift`、`rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、
  `rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `b01642940`（实现，父提交是本 RFC 的落档提交 `1e31f3bc9`）：exact SHA 主 CI run 43784575765 的 70 个 job 全部通过；同一推送按路径
  触发的 windows-platform run 43784575771（1 个 job）通过。
- 本 RFC 的落档提交 `1e31f3bc9`（只改文档）：主 CI run 43756084489 的 70 个 job 全部通过。
- 转 Done 的 `b84ac06c2`（只改文档；补记于 RFC-498 的落档提交）：主 CI run 43788244224 的 70 个 job 全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **mission 用例正文**：脚本比对 `application/missionOperationHandlers.ts` 与 HEAD 原文件：第 55～98 行逐字相同；用例（原第 128～703 行）
  除函数头（改名 `createDevelopmentMissionOperations`、输入类型改名）外只有 design D2 的 5 处——`resolveBaseline` 取
  `deps.resolveBaseline`，`launchDeps` 与 `cutoverDeps` 的 `now` 取 `deps.now`，`readCutover` / `materializeCutover` 的 `analyze(Date.now())`
  改为 `analyze(deps.now())`；其余分支、错误码、日志与注释逐字不变。
- **配置用例正文**：第 54～79、90～152 行逐字相同；用例（原第 154～656 行）除函数头外只改 `const now = deps.now`。
- **装配时机与次序**：composition 按原次序建 7 个持久化，再以 `persistence.repositories` 与 `deps.repositoryBaselines` 建基线解析——原来
  这一步在用例开头，同样在装配时执行一次；默认时钟 `Date.now`（原为 `() => Date.now()`，`Date.now` 不取 `this`，结果相同）。配置一侧
  `deps.now ?? Date.now` 与原来用例里的 `deps.now ?? (() => Date.now())` 相同。
- **类型**：两个组合输入类型由 application 的输入类型推出，字段与可选性与此前逐个相同；`DevelopmentAutomationModule` 的成员集合与类型
  不变（继承端口的 10 个加自己的 6 个）；bootstrap 与用例的 import 不变，`tsc` 0 错。
- **public 与装配**：public 不变；两个 composition 文件没有控制流语句；配置一侧取 identity-access 的一条跨 context 引用随内容迁到
  application（同样的 context 对与符号）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-496 转 Done 提交 `b549dcc5e` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-497 开发自动化的 mission 与配置操作用例迁出 composition（RFC-294 S10 第四步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
