# RFC-509 实施计划

依赖：RFC-508；与 S12 共用模块 composition 文件（本 RFC 只改 development-automation `composition/` 下的 6 个文件；装配入口不变）。按 CLAUDE.md
文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-509-T1 实现归 application**：图交付生命周期与作业模板迁入 `application/graph-development/`，案例详情投影与执行终态唤醒各成新文件，活动
  周期与选定内容核对并入既有的 `application/activityOperations.ts` 与 `application/evidenceStaging.ts`（design D3）。
- **RFC-509-T2 composition 只装配**：6 个组合文件改为从新位置取实现，转出原有的名字，登记对象、id 与时钟由装配传入，删去不再用的 import
  （design D4）。
- **RFC-509-T3 账本、清单与随代码改的锁**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`）；RFC-310 的 OS 架构清单改三增
  一删；`rfc344-operation-catalog` 读组合文件原文的一段改读新位置，P0 变异脚本的指纹清单增新文件（design D5）。
- **RFC-509-T4 用例**：新增 RFC-509 用例（design §4）。
- **RFC-509-T5 集中验证**：backend `tsc`、eslint、prettier；按静态 import 闭包取到改动文件的用例、全部 `tests/architecture/` 与按名字、路径和
  错误串扫出的用例，按 CI 的跑法与 HEAD 同时 A/B；撞时限或等待到点的红用放宽时限的副本两边复核；报告类用例的放宽副本；架构报告对照；全仓
  旧位置扫描。全量语料交给 CI 的 backend 分片（RFC-508 的教训：本机高负载下全量 SQLite 要数小时）。
- **RFC-509-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的位置声明；6 个组合文件只留装配入口、转出与装配期选择；装配入口与转出的名字不变
- [x] AC-2 同样输入下各实现的结果、错误与端口调用和此前一致
- [x] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-development-automation` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 20～72，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD 的树相同。集中验证查出本 RFC 的一处缺陷，修正后复验了相关范围；另有一次环境事故，受影响的结果作废重跑：

- **缺陷与修正**：候选 1（`f07489c9c` 的树加本 RFC 的 16 个代码与账本路径）里，`rfc344-operation-catalog` 有一段按原文读
  `composition/executionTerminalObserver.ts`，要求其中出现 `recordWakeHint`；这个调用随唤醒迁到了 application 的新文件，所以首批里这一例只在
  候选一边红（读不到这个词）。design D5 起初只清点了按名字与路径取用组合文件的用例，漏了这段读原文的锁（design §5 补记这一失败模式）。改为
  同时读组合文件与新文件：组合文件里有 `missionIdOfExecutionRef`，新文件里有 `recordWakeHint`，两者都不取 task-execution，意图不变；
  `scripts/rfc359-p0-mutations.ts` 的指纹清单同时增 application 的新文件（与 RFC-400、RFC-480 的做法一致）。候选 2 只差这两个文件；
  它们不改生产代码，复验见下文。
- **环境事故**：08:02 左右，系统的临时目录清理把两个导出仓库（11-15 建）里 3 天没碰过的文件删掉了（`.git` 的大部分、多数仓库文件与
  `node_modules/.bun` 的包；11-14 也发生过一次）。此后跑的用例纷纷报 `Cannot find package 'drizzle-orm'`。两个导出仓库从 HEAD
  `afd425c00`（只改文档的后继，代码树与 `f07489c9c` 相同）用 `git archive` 重建并 `bun install --frozen-lockfile`，核对与工作树逐字相同
  （12,320 个文件）；首批里 08:00 之后才结束的文件两边都作废，在重建的导出仓库里同时重跑（见“首批”）。
- **静态**：
  - backend `tsc` 退出码 0、无输出（第一次查出 RFC-509 用例里唤醒提示替身的返回类型写错，改为异步后为 0；修正缺陷后再跑仍为 0）。
  - eslint `--max-warnings 0`：改动与新增的 15 个 TS 文件无告警，`eslint.promises.config.js` 的规则对其中 12 个生产文件同样无告警。
  - prettier：改动的 TS 与本 RFC 的三件套通过。`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 按约定
    不跑。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对照同时、同样跑法）：257 个文件。其中
  `tests/architecture/` 全部 140 个，另 117 个：
  - 直接或经用例侧的辅助与夹具取到 6 个组合文件、6 个新位置或本模块 `composition.ts` 的用例；
  - 直接取 bootstrap 的 `daemonModules/digitalEmployee.ts`、`developmentAutomation.ts`、`daemonHttpComposition.ts`、`daemonApplication.ts`、
    `standalone.ts` 或 `developmentPurposeRoot.ts` 的用例，以及取它们的用例侧辅助的用例；
  - 按名字、路径与错误串扫出的用例（含读 RFC-310 OS 架构清单的用例）与本 RFC 用例。

  08:00 之前两边都已结束的 171 个文件有效：候选 1,775 条通过、170 条红（22 个文件），对照 1,770 条通过、175 条红（23 个文件）；逐文件比失败
  名，各自多出的 8 条与 13 条都撞默认的 5 秒或用例自带的时限（多是 PostgreSQL 一段的 `beforeEach` / `afterEach` 钩子），对照同一条在时限附近
  通过。其余 86 个文件（对照 85 个）在重建的导出仓库里重跑：候选 897 条通过、141 条红（37 个文件；通过的含本 RFC 用例 22 / 22），对照 877 条
  通过、139 条红（36 个文件），没有再出现找不到包的错误。逐文件比失败名，候选多出 10 条：上面的缺陷 1 条（`rfc344`）；撞默认的 5 秒 5 条
  （`rfc370-port-artifact-bindings` 2 条，`rfc382-gate-continuation-bundle`、`rfc385-daemon-execution-generation` 与
  `rfc386-task-drive-coordinator-factory` 各 1 条）；撞用例自带时限 3 条（`rfc370-evidence-artifact-root-bindings` 的
  20 秒、`tasks-multipart` 的 30 秒、`rfc359-w14-legacy-mission-execution` 的 script 一例等终态回调的 25 秒，同一文件的 agent 一例两边都红在
  这里）；`rfc310-digital-employee-system-mock-e2e` 的 crewstation 一例 SQLite 一段 1 条（系统 mock 的控制端口在一次请求上 ECONNRESET；首批
  里这一例在环境事故期间红在流水线适配器 `exit 1` 上）。对照多出 8 条，都撞时限（默认的 5 秒或用例自带的 20 / 30 秒）。下文逐个复核。

- **放宽默认时限复跑**（候选 2 与对照；按首批的跑法，默认时限放宽到 60 秒，各 3 个 worker，与对照同时）：首批两次运行里任一边红过的 63 个
  文件中，静态 import 闭包取到本 RFC 改动的有 60 个（另 3 个 `rfc317-transition-table-oracle`、`architecture/rfc376-report` 与
  `architecture/rfc400-collaboration-task-participants` 的负对照不取改动的代码）。先跑的 15 个重型 HTTP 文件两边各 326 条通过、1 条红：14 个
  两边全过（`admin-only-gate`、三个 `cached-repos-http`、`inventory-in-flight-fallback`、`mcps-http`、`plugins-http`、`repos`、两个
  `reviews-*`、`rfc165`、`rfc193`、`rfc199` 与 `architecture/rfc359-w5-composition-root-route-surface`），红的那条两边相同，是 `rfc167` 等
  任务落定的 5 秒等待（见下文副本）。为加快推进，其余的改为只跑默认 5 秒下红过、且不靠用例自带时限的文件，连同复验：`rfc344-operation-catalog`
  23 / 23（候选 2 上修正后的锁通过，对照上原锁通过）、`rfc359-w14-p0-mutation-verdict` 18 / 18、本 RFC 用例 22 / 22，以及
  `rfc370-port-artifact-bindings` 18 / 18、`rfc382-gate-continuation-bundle` 8 / 8、`rfc385-daemon-execution-generation` 10 / 10、
  `rfc386-task-drive-coordinator-factory` 56 / 56、`rfc387-continuation-semantics` 50 / 50 与 `rfc396-mr-runtime-wiring` 13 / 13，两边全过。
- **放宽副本**（候选 2 与对照各一份、同时跑，单条 1,500 秒；副本只放宽用例自带的时限与等待，断言不动；跑完删掉，两个导出仓库回到原提交、
  没有未跟踪文件）：10 个文件，两边结果相同、全过：
  - 取到本 RFC 改动代码、撞用例自带时限或等待到点的 8 个（按首批的跑法）：`rfc310-digital-employee-system-mock-e2e`（180 秒）4 / 4，含
    crewstation 与 direct 两例的两种 provider；`rfc359-w14-legacy-mission-execution`（终态回调的 25 秒等待与 5 秒的释放等待）4 / 4；
    `tasks-multipart`（四个时限）20 / 20；`rfc370-evidence-artifact-root-bindings`（两处 20 秒）9 / 9；
    `rfc370-evidence-document-write-root-bindings`（20 秒）4 / 4；`rfc395-q3-application-restart`（30 秒）2 / 2；
    `rfc349-mcp-runtime-test-daemon-identity`（20 秒与 5 秒的等待）2 / 2；`rfc167` 的落定等待（5 → 50 秒）29 / 29。
  - 报告类 2 个（SQLite）：`rfc294-architecture-preflight`（60、180 与 30 秒）14 / 14、`architecture/rfc376-report`（300 秒）16 / 16。
- **架构报告**（`scripts/architecture-report.ts`，候选 1 与对照各出一份，在环境事故之前）：
  - 60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的 `max`）：`composition-control-flow-development-automation` 102 → 82。
    少掉的 20 条正是迁走的控制流；没有新增，余下的非 RFC-370 两条是 `evidenceStaging.ts` 与 `repositoryFactsScanner.ts` 的装配期选择。
  - 生产文件 4,117 → 4,121（backend 3,253 → 3,257：四个新文件）。
  - 跨 context import 7,506 → 7,508：取 digital-employee public types 的类型边随代码从 3 个组合文件移到 3 个新文件（都是
    `offered-consumption`，在 DAG 上）；参与者与类型包登记的两个类型组合文件的签名仍要用，于是多两条。`off-dag-offered-file-context-pairs`
    仍是 45。
  - public surface 1,195 不变；digital-employee 七个类型面上的使用记账随代码改记到新文件的边上，面的数目、方法、字段与签名都不变。
  - 模块符号归属 32,406 → 32,417、变更入口 2,374 → 2,379：新文件里的名字与五个新入口在 application。
  - 其余各节逐项相同。
- **旧位置全仓扫描**（工作树；对全部包、`e2e`、`scripts`、`.github`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，全部文件类型，已跟踪
  与未跟踪；按词边界）：
  - 新名字只出现在新位置、6 个组合文件、本 RFC 用例与本 RFC 的文档（含 RFC 索引）里。
  - 作业模板、类型包与选定内容核对的五条错误串除新位置外，只在按错误串断言的 `rfc396-mr-job`、本 RFC 用例与 design 里。
  - 6 个组合文件的路径与装配入口仍被 bootstrap、`composition.ts`、`graphDevelopment.ts` 与用例取用；它们取的名字不变，都不改。按路径读
    组合文件原文的锁只有上面那段 `rfc344`（已改）与 P0 的指纹清单。
- **收口文档**：plan、design、proposal 与 `STATE.md` 定稿后（含 RFC-508 的 CI 补记），在工作树（只有本会话的改动）里重跑读这几处文档与 RFC
  索引的 6 个用例（与 RFC-508 相同），全过（33 / 33）。

## CI（AC-4）

- 【待补：实现提交】
- 本 RFC 的落档提交 `afd425c00`（只改文档，与 RFC-508 转 Done 同一提交）：主 CI run 44555911052 共 70 个 job，第一次运行全部通过。没有重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：新文件由脚本按 HEAD 原行切片生成，再用脚本按词法单元比对（注释也比，只忽略换行与缩进）：20 段都在新位置连续出现，除下列替换外
  逐个相同：
  - 图交付生命周期：HEAD 第 16～51 行（251 个词法单元）、第 53 行、第 57～143 行（482 个）、第 146～152 行（87 个）、第 154～157 行与
    第 159～289 行（942 个）；替换 1 处：契约夹具校验的接收者 `developmentEmployeeTypePackage` → `development`。
  - 作业模板：HEAD 第 5～178 行（963 个），没有替换。
  - 案例详情投影：HEAD 第 17～161 行（737 个）与参与者第 165～176 行（54 个），没有替换。
  - 活动周期：worker 接口第 3～10 行（75 个）与周期第 30～45 行（156 个），没有替换；`application/activityOperations.ts` 原有的 54 行
    （411 个）原样在前。
  - 执行终态唤醒：接口第 9～12 行、依赖第 15～17 行与函数体第 19～39 行（121 个）；替换 2 处：`ulid()` → `deps.newId()`、`Date.now()` →
    `deps.now()`。
  - 选定内容核对：HEAD 第 39～43 行（39 个），没有替换；`application/evidenceStaging.ts` 原有的 38 行（190 个）原样在后。
  - 组合文件留下的部分（活动周期的装配说明与签名、终态唤醒装配入口的签名、本地内容分支）与 HEAD 相同。
- **接收者与时机**：契约夹具校验仍以开发员工类型包的登记对象为接收者调用（装配传入的就是它）。活动周期的 worker 仍在装配时交入、每个周期按原
  次序调用。终态唤醒的 id 与时钟在每次唤醒时调用，与原来读 `ulid()`、`Date.now()` 的位置相同；Mission 持久化仍在装配时创建。选定内容核对原来
  从装配入参读三次暂存、两次文档写入器，现在由组合文件读一次交入；唯一的调用方传对象字面量，读的次数不同不可观察。核对的先后（先暂存工厂、
  后文档写入器）与错误串不变。
- **装配入口与交出的对象**：6 个组合文件的装配入口名字、入参与返回类型不变（`RuntimeCodec` 的结构与原来相同，改由 application 交出的别名
  表达）；运行时导出面不变（`activityOperations.ts` 仍只导出装配入口，接口只作类型转出）；`graphDeliveryJob.ts` 与
  `employeeCaseDetailProjection.ts` 转出原有的名字，bootstrap、`graphDevelopment.ts` 与用例的 import 不改。模块加载：组合文件改为在运行时取
  application 的新位置，这些模块没有副作用，也不回取组合层，没有新的环。
- **账本、清单与锁**：`counts.json` 一项收紧到实测（与架构报告一致）；guard-manifest 登记新用例
  （1,300 行，`assertsAbsence: true`）；RFC-310 的 OS 架构清单改三增一删，与 import 的移动一致；`rfc344-operation-catalog` 读组合文件原文的
  一段改为同时读新文件、断言不变，P0 变异脚本的指纹清单增新文件（集中验证查出，见上文）。其余钉着这些文件与装配根的用例不改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-508 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-509 开发自动化组合层的非 RFC-370 余项迁出 composition（RFC-294 S10 第十六步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
