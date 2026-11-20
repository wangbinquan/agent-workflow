# RFC-517 实施计划

依赖：RFC-516。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-517-T1 归位**：新增 digital-employee 的 `application/platformInventoryParticipant.ts` 与
  `application/employeeDefinitionView.ts`，system-operations 的
  `infrastructure/local/fileDatabaseProviderBoot.ts`、`application/schemaPlanAdmission.ts` 与
  `application/stageRestoreArtifactRelease.ts`，task-execution 的 `infrastructure/taskExecutionModule.ts`（design D1）。
- **RFC-517-T2 模块根只装配**：三个模块根 `composition.ts` 改为取新位置并照旧导出；`childTaskLifecycleParticipant.ts` 的类型 import 改指新位
  置（design D2）。
- **RFC-517-T3 门与账本**：RFC-515 门的例外清单删 3 条；`rfc328-architecture-guards` 与 `rfc305-architecture-lock` 改钉新位
  置；guard-manifest 登记新用例（design D3）。
- **RFC-517-T4 用例**：新增 RFC-517 用例（design §4）。
- **RFC-517-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部
  `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-517-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的位置声明；三个模块根不再有循环、`try` 与 `throw`；门的例外清单删去它们后仍绿（只剩 RFC-370 的 27 个）
- [x] AC-2 清单参与者、员工视图、启动准备、schema 计划核对、暂存还原后的释放、任务执行模块与关停控制器的行为、错误与次序和此前一致
- [x] AC-3 新文件的依赖面是闭集并服从层次；public surface 与计数不升
- [x] AC-4 受影响用例全部通过；exact SHA CI 除外部服务的链接检查外全绿（逐格归因见 §CI）

## 集中验证

本机全程高负载（10 核；1 分钟负载大多在 20 以上，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`eb72bb67e`）的树相同。集中验证查出本 RFC 两处缺陷，都已修正并复验：

- **缺陷一（只在用例的类型上）**：本 RFC 用例里两处 `toEqual` 的期望对象按收到值的类型受检，backend `tsc` 报 6 处 TS2769；收到值先记为
  `unknown` 再断言后 `tsc` 退出码 0、无输出。bun 运行时不做类型检查，这条用例在首批里本就 14 / 14，断言内容未改。
- **缺陷二（schema 计划核对的落位）**：初稿把核对放进 `application/postgresqlSchemaPlanAdmission.ts`、取 platform 的 `PostgresqlSchemaPlan`
  类型，首批里三条架构账本因此红：RFC-359 W5-T17（`platform/persistence/` 之外多了一个方言命名文件）、RFC-349 provider cutover（application
  多了一条方言依赖）、RFC-359 W5-T19d（本 RFC 用例提到方言侧的模块名与符号，postgresql 一侧的引用数 33 → 34）。改为方言中立的
  `application/schemaPlanAdmission.ts` 的 `requireSchemaPlanForContract`：参数只按结构取计划的 `contractDigest` 与契约的 `digest`，函数体仍
  是 HEAD 原文、错误串不变；用例与三件套随改。复验时三条账本两边全过。
- **静态**：backend `tsc` 退出码 0、无输出（改定后）；eslint `--max-warnings 0`：10 个生产文件与 4 个用例无告警；prettier：改动的
  TS、guard-manifest 与本 RFC 的三件套通过。
- **首批**（候选 = `eb72bb67e` 的树加本 RFC 初稿的 15 个路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；
  与对照同时、同样跑法）：198 个文件。其中 `tests/architecture/` 全部 142 个，另 56 个：按新旧名字、三个模块根的路径与错误串扫出的用例，各段
  迁移代码的行为样本（暂存还原、平台清单、员工定义、关停、删任务等）与本 RFC 用例。
  - 两边都跑完：候选 2,078 条通过、72 条红，对照 2,086 条通过、70 条红；本 RFC 用例 14 / 14（只在候选一边）。逐文件比失败名，候选多出的红除
    缺陷二的三条账本外都是时限：`commit-push-runner`、`rfc359-w8` 的两个对拍、`rfc386` 与 `rfc400` 撞 5 秒或自带的
    30 秒，`rfc359-w5-composition-root-route-surface` 与 `retry-cascade-kind-matrix` 的 PostgreSQL 一半撞 60 秒的钩
    子，`rfc294-architecture-preflight` 撞 5 秒与自带的 60 秒；对照多出的（`rfc385`、`rfc398`）同样都是时限。
- **复验**（改定后；默认时限放宽到 60 秒、与对照同时，各 2 个 worker）：19 个文件——三条账本、本 RFC 与 RFC-515 的用例、首批里任一边多出时限
  红的文件、`rfc349-postgresql-system-operations-composition`（经装配入口按错误串断言 schema 计划核对）与 3 个守卫普查。候选 336 条通
  过、2 条红；对照 321 条通过、3 条红（对照没有本 RFC 用例，多出的一条是 `rfc400` 的时限）。两边都红的 2 条是
  `rfc294-architecture-preflight` 里自带 60 秒与 180 秒时限的两条（公共面偏差 158 秒对 246 秒、能力归属 1,035 秒对 926 秒），本机两边都跑不
  进时限，交给 CI；另按源码读了它们的判据：公共面偏差只沿 `public/*` 可达的类型走，没有 `public/*` 文件取到本 RFC 迁走的名字；能力归属的规则
  不分层，三个模块根在 HEAD 上就受检、账本里没有它们的条目，迁走的代码逐字相同。
- **架构报告**（`scripts/architecture-report.ts`，改定后的候选与对照各出一份）：60 项实测与对照逐项相同（F13 不计模块根）；生产文件 4,131 →
  4,137（6 个新文件）；跨 context import 7,507 → 7,509：digital-employee 对 identity-access 的类型边、system-operations 对 `@/util/lock` 与
  `databaseProviderRuntime` 的两条值边随代码挪到新文件，新增的两条是任务执行模块文件对 `PersistenceDb` 的类型边（模块根仍自己取）与文件库启
  动文件对本模块必需端口 `DatabaseConfigurationPort` 的类型边（记为 required-implementation）；public surface 1,195 不变
  （`DirectAuthenticatedAuthority` 的消费方随清单参与者挪到 application；`EventCenterParticipant` 与 `ExecutionContractParticipant` 的字段取
  用记录少了 digital-employee 模块根那条边——按属性名的统计随迁走的 `typeId`、`zh-CN` 一起离开模块根，没有字段失去最后一个消费方）；required
  ports 66 不变；mutation 入口 2,385 → 2,386（新导出的员工视图工厂被计入，另两条随代码挪位）；模块符号归属 32,454 → 32,464。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，按词边界，跳过 `node_modules`）：
  初稿的名字只剩 design 里对它的说明；新名字只出现在新位置、三个模块根、本 RFC 用例与三件套（任务执行模块的路径另见于
  `rfc328-architecture-guards` 的白名单）；改钉的三条锁各自通过。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例，全过（33 / 33）。

## CI（AC-4）

- `dd2d1b24a`（实现，父提交是 `eb72bb67e`）：exact SHA 主 CI run 44674339750 的 70 个 job 第 1 次运行 68 个通过；红的是 design/ 的链接检查遇
  GitHub 503（`design/RFC-371-run-observability/native-real-validation-20261007.md` 第 7 行的提交链接，外部服务暂时不可用，该文件不在本提交
  里），`CI required` 只因它红；backend 分片全过（含本机跑不进时限、交给 CI 的 `rfc294-architecture-preflight` 两条），未重跑。
- 本 RFC 的落档提交 `eb72bb67e`（只改文档，同一提交记下 RFC-513 转 Done）：主 CI run 44661446598 的 70 个 job 第 1 次运行 68 个通过；红的是
  design/ 的链接检查遇 GitHub 503（`design/RFC-371-run-observability/native-real-validation-20261007.md` 第 7 行的提交链接，外部服务暂时不可
  用，该文件不在本提交里），`CI required` 只因它红；backend 分片全过，未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：由脚本按 HEAD 原行切片生成，再用脚本按词法单元比对（注释也比，只忽略换行与缩进）：9 段都在新位置连续出现、逐个相
  同——digital-employee 第 302～406 行（清单参与者）与第 594～633 行（员工视图）；system-operations 第 211～219 行（两个类型，改为导出）、第
  238～252 行（持锁段）、第 355～357 行（schema 计划核对）与第 587～596 行（暂存还原，`application.commands.stageRestore` 与
  `deps.artifacts` 换成参数）；task-execution 第 35～185 行（两个常量、结果类型与两个类）与第 215～247 行（关停控制器）。
- **时机与次序**：员工视图仍在每次装配时按同一个 authoring store 建好，读版本 → 工作范围 → 岗位版本；清单参与者的过滤、投影与排序次序不变；
  文件库启动仍先 epoch 准入、再迁库恢复、再准备运行时，升级锁只在需要时取、无论成败都释放；schema 计划仍在缺省计划之后、构造还原协调器之前核
  对；暂存还原仍在命令返回或抛错之后释放工件；任务执行模块的认领、暂停、销毁与关停控制器逐字未动，进程级单例仍在模块根构造一次。错误类型、错
  误串与次序不变。
- **装配入口与交出的对象**：三个模块根的装配入口名字、入参与返回类型不变；digital-employee 照旧转出清单参与者与授权面类型，task-execution 照
  旧转出六个名字（bootstrap、`composition/` 下的文件与用例的 import 不改）；`childTaskLifecycleParticipant.ts` 的类型 import 改指新位置。
- **账本与锁**：RFC-515 门的例外清单删 3 个模块根（30 → 27，只剩 RFC-370 的文件）；`rfc328-architecture-guards` 的 `createWorkerIdentity` 白
  名单与 `rfc305-architecture-lock` 的 identity-access 导入清单改钉新位置；guard-manifest 登记新用例（`assertsAbsence: true`），改动过的条目
  行数按实测随改（`rfc098-write-lock-registry` 改回实测 491）；`counts.json` 不变。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-517 模块根装配文件的运行期逻辑迁出（二）（RFC-294 S10 第二十四步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
