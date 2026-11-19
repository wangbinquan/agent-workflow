# RFC-506 实施计划

依赖：RFC-505（Done）；与 S12 共用模块 composition 文件（本 RFC 改 identity-access 的 `composition/userOperations.ts` 与 intent 的
`composition/resourceCatalog.ts`；两个装配入口不变）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与
格式的静态自查。

## 任务

- **RFC-506-T1 用例与用例状态归 application**：改密用例迁入 identity-access `application/commands/resetUserPassword.ts`（系统用户 id、
  认证运行时的两次凭据写、哈希与时钟传入），演员绑定迁入 intent `application/resourceCatalog.ts`（design D2）。
- **RFC-506-T2 composition 只装配**：两个组合文件的装配入口改为从新位置取实现（design D3）。
- **RFC-506-T3 账本与锁**：`counts.json` 两项收紧；T19b 账本销掉 intent 组合文件那一行；`rfc349-auth-caller-closure` 改钉新位置；
  guard-manifest 登记（design D4）。
- **RFC-506-T4 用例**：新增 RFC-506 用例（design §4）。
- **RFC-506-T5 集中验证**：backend `tsc`、eslint；RFC-506 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-506-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的新位置声明；两个组合文件没有控制流、从新位置取实现；装配入口不变
- [x] AC-2 同样输入下改密与演员绑定的结果、错误与端口调用和此前一致；时钟仍在调用时取、每次一次
- [x] AC-3 新位置的依赖面是闭集；public surface 不升；两项 `composition-control-flow-*` 收紧到实测；T19b 账本只减不增
- [x] AC-4 受影响用例全部通过；exact SHA CI：`88011e010` 主 CI run 44455094940 的 70 个 job 第 1 次全部通过（见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 45～118，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库
与 `6ba5d66c9` 的树相同。验证期间 HEAD 没有前进。集中验证查出本 RFC 的一处缺陷，修正后复验了相关范围：

- **缺陷与修正**：候选 1（`6ba5d66c9` 的树加 10 个代码、账本与 design 路径）里，identity-access 新文件的头注释写出了组合文件的路径
  `modules/identity-access/composition/userOperations.ts`。`rfc347-identity-access-runtime` 的 “runtime composition has one explicit root family”
  一例用 `importPaths('identity-access/composition')` 在原始源码（含注释）里找这段路径，于是把新文件算作取组合层的文件，全量与首批里都红。
  新文件并不取组合层，锁本身不该改：把注释改为不写出这条路径（design §5 补记这一失败模式）。候选 2 只差这几行注释；注释不改行为，所以
  只在候选 2 上重跑按源码读文件的用例与架构报告（见“复验”），行为用例的结果沿用候选 1 的，下文的复跑与放宽副本都在候选 2 上跑。
- **静态**：
  - backend `tsc` 退出码 0、无输出。
  - eslint `--max-warnings 0`：改动与新增的 7 个 TS 文件无告警，`eslint.promises.config.js` 的规则对其中 4 个生产文件同样无告警。
  - prettier：改动的 TS 与本 RFC 的三件套通过。`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md` 与 `design/plan.md` 按
    约定不跑。
- **首批**（候选 1；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：318 个文件。其中
  `tests/architecture/` 全部 140 个，另 178 个相关用例：
  - 直接或经用例侧的辅助与夹具取到两个组合文件、新文件或扩充的 `application/resourceCatalog.ts` 的用例；
  - 按名字、路径与 `reset-password`、`system-user-immutable`、`not-bound` 错误串扫出的用例；
  - 直接取 bootstrap 的 `commandBootstraps.ts`、`daemonHttpComposition.ts` 或 `daemonModules/intent.ts` 的用例，以及取它们的用例侧辅助的
    用例；
  - 本 RFC 用例。

  结果：候选 4,178 条通过、815 条红（111 个文件）；对照（少本 RFC 用例）4,171 条通过、820 条红（108 个文件）。
  - 本 RFC 用例 11 / 11。走迁出代码的用例两边相同：
    - 改密：`users-service` 36 / 36、`users-cli` 6 / 6；`users-http` 与 `rfc221-account-auth-policy` 的 SQLite 一段全过，PostgreSQL 一段
      两边同样撞时限（钩子与默认的 5 秒），见下文复跑；
    - 演员绑定：`rfc349-intent-boot-resume-authority` 8 / 8、`intent-mcp-oauth` 8 / 8；`rfc384-daemon-intent-bundle` 两边同样红两例
      （自带的 15 秒与默认的 5 秒）；
    - 锁与装配面：`rfc349-auth-caller-closure` 5 / 5、`rfc305-architecture-lock` 15 / 15、`architecture/rfc380-daemon-module-bundles` 9 / 9、
      `architecture/rfc390-neutral-http-binding` 5 / 5、`architecture/rfc359-w5-t19b-composition-root-complete` 3 / 3。
  - 逐文件比失败名，候选多出 14 条：
    - `rfc347` 1 条（上面的缺陷）；
    - 撞默认的 5 秒 7 条：`change-narrative` 3 条、`rfc257-webhook-dispatch` 2 条、`rfc234-turn-engine` 与 `rfc268-webhook-scratch-launch`
      各 1 条；
    - 撞用例自带的时限 4 条：`rfc370-selected-task-root-configuration` 2 条与 `rfc396-http` 1 条（各 30 秒）、
      `architecture/rfc400-collaboration-task-participants` 的负对照 1 条（30 秒）；
    - `rfc349-rest-launch-ownership` 的 PostgreSQL 一段 2 条：`beforeEach` 钩子撞时限，随后日志里有库的世代围栏拒写与连接已关闭（钩子
      超时后的连带）；对照同一段是 `beforeAll` 钩子撞 60 秒，两例都没跑。

    对照多出 19 条，同样是这几类（撞默认 5 秒 17 条，钩子撞时限 2 条）。

- **全量 SQLite**（候选 1；导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的
  时限照旧；清单按耗时从慢到快排，3 个 worker；与首批同时）：2,951 个文件，2,938 个通过（24,008 条通过、127 条按环境跳过），其余 13 个
  文件 14 条红：
  - `rfc347` 一条（上面的缺陷）；
  - 两个报告类用例撞自带时限：`rfc294-architecture-preflight` 两例（60 秒与 180 秒）、`rfc376-report`（300 秒），见下文放宽副本；
  - 发布账本 `rfc321-repository-publication-ratchet`：账本记的提交不在导出仓库的历史里；
  - `rfc167-dynamic-workflow-engine` 的 approve 一条：`settleTask` 等满 5 秒时任务仍是 running；
  - `clarify-review-combination-scenarios` 的 S-RFC074 一条：用例自带的 20 秒流程看门狗取消了任务，读到的状态是 canceled；
  - 撞自带时限的 7 条：`rfc300-webhook-workspace-cleanup-e2e`、`rfc321-repository-publication-system-mock-e2e`、`rfc354-nested-frames-closure`、
    `rfc363-workspace-content` 与 `rfc395-v3-content-inventory` 的六万五千行一例（各 30 秒）；`rfc354-nested-loop-frames`（20 秒）；
    `rfc395-v1-source-readers` 的备份一例（40 秒）。

  静态 import 闭包（含按路径起的夹具）取到本 RFC 改动的生产文件的有 321 个文件，其中 318 个通过。按改动文件分：
  - identity-access 的新文件：299 / 296；组合文件 `userOperations.ts`：298 / 295；
  - intent 的 `application/resourceCatalog.ts`：285 / 283；组合文件 `resourceCatalog.ts`：255 / 253。

  红的 3 个（`rfc300`、`rfc167`、`rfc321-repository-publication-system-mock-e2e`）都撞时限，进下文的复跑与放宽副本。

- **复验**（候选 2，修正之后；注释不改行为，只重跑按源码读文件的用例）：源码扫描 348 个，即 `tests/architecture/` 全部 140 个、按源码读
  生产文件而不经 import 的根目录扫描 207 个（含 `rfc347` 与本 RFC 用例），以及 `rfc349-auth-caller-closure`（SQLite，单条 60 秒，3 个
  worker）。344 个通过（3,651 条通过、12 条跳过）：`rfc347-identity-access-runtime` 8 / 8、本 RFC 用例 11 / 11、`rfc349-auth-caller-closure`
  3 / 3，按路径或名字钉两个组合文件的 `architecture/rfc359-w5-t19b-composition-root-complete` 3 / 3、`architecture/rfc380-daemon-module-bundles`
  9 / 9、`architecture/rfc390-neutral-http-binding` 5 / 5、`rfc305-architecture-lock` 15 / 15。红的 4 个（5 条）：
  - 撞自带时限：`rfc376-report`（300 秒，用了 590 秒）、`rfc294-architecture-preflight` 的 public surface 一例（60 秒，160 秒）与能力归属
    一例（180 秒，738 秒）、`rfc370-committed-architecture-source`（150 秒，265 秒），见放宽副本；
  - 发布账本 `rfc321-repository-publication-ratchet`：同上，导出仓库的历史。
- **红文件放宽默认时限复跑**（候选 2；按首批的跑法，默认时限放宽到 60 秒、看门狗 3,000 秒，各 2 个 worker，与对照同时）：119 个文件，即首批
  任一边红过的 113 个与全量里红的 13 个合起来（121 个），去掉 `rfc347`（已在扫描里复验）与报告类的 `rfc376-report`。候选 2,236 条通过、
  19 条红（14 个文件）；对照 2,235 条通过、20 条红（13 个文件）。
  - 首批候选多出的 14 条：`rfc347` 一条已在扫描里通过；其余 13 条里 12 条这一轮在候选上通过，所在的 7 个文件在候选上全过：
    `change-narrative` 31 / 31、`rfc257-webhook-dispatch` 51 / 51、`rfc234-turn-engine` 62 / 62、`rfc268-webhook-scratch-launch` 1 / 1、
    `rfc349-rest-launch-ownership` 4 / 4、`rfc396-http` 2 / 2 两边全过，`rfc370-selected-task-root-configuration` 14 / 14（对照红一例，撞自带的
    30 秒）。余下一条是 `architecture/rfc400-collaboration-task-participants` 的负对照，这一轮两边都撞自带的 30 秒（49 / 50 秒；扫描里候选
    6 / 6），进放宽副本。
  - 首批里 PostgreSQL 一段两边同样撞时限的改密用例 `users-http` 36 / 36、`rfc221-account-auth-policy` 2 / 2 两边全过；`rfc384-daemon-intent-bundle`
    两边同样红一例（维护增量的 PostgreSQL 版，自带 15 秒），进放宽副本。
  - 这一轮只红在候选的 2 条都撞自带时限：`clarify-review-combination-scenarios` 的 S-RFC074（20 秒的流程看门狗取消了任务，读到 `canceled`；
    对照 20.0 秒过）与 `rfc363-workspace-content` 的全量排序分页一例（30 秒；30.5 秒，对照 29.4 秒过）。两者都不取本 RFC 的代码，也进放宽
    副本。
  - 只红在对照的 3 条：`rfc310-digital-employee-system-mock-e2e` 的 SQLite 一例（连接被重置）、`rfc395-v1-source-readers` 的备份一例（自带
    40 秒）、`rfc370-selected-task-root-configuration` 的 Fusion 一例（自带 30 秒）。
  - 两边同样红的：报告类 `rfc294-architecture-preflight` 两例；`rfc310` 的 PostgreSQL 两例（自带 180 秒）；`rfc167` 的 approve 一例
    （`settleTask` 等 5 秒）；`rfc300`、`rfc321-repository-publication-system-mock-e2e` 两例、`rfc354-nested-frames-closure`、
    `rfc354-nested-loop-frames` 与 `rfc395-v3` 的六万五千行一例（自带 30 或 20 秒）；`rfc395-v1` 与 `rfc395-v3` 的 PostgreSQL 一段的钩子（辅助
    的 90 秒预算）；发布账本。
  - 这一轮红的 15 个文件里，6 个取到本 RFC 的代码；在候选上红的 5 个（`rfc167`、`rfc300`、`rfc310`、
    `rfc321-repository-publication-system-mock-e2e`、`rfc384`）都带自带时限，全部进放宽副本；另一个 `rfc370-selected-task-root-configuration`
    只在对照上红。
- **放宽副本**（候选与对照同时，按首批的跑法、各 3 个 worker；默认时限放宽到 1,500 秒，用例自带的时限改在副本里，其余逐字）：11 个文件。
  - 收的是：报告类三个（`rfc376-report`、`rfc294-architecture-preflight`、`rfc370-committed-architecture-source`）；取到本 RFC 代码、在候选上
    红过的 5 个（全量里的 `rfc300`、`rfc167`、`rfc321-repository-publication-system-mock-e2e`，复跑里另有 `rfc384`、`rfc310`）；不取本 RFC
    代码而只红在候选的 3 个（`clarify-review-combination-scenarios`、`rfc363-workspace-content`、`architecture/rfc400-collaboration-task-participants`）。
  - 副本里的改动：用例与钩子的自带时限放宽到 1,500 秒；另有 `rfc167` 的 `settleTask` 等待 5 → 50 秒、`rfc300` 的轮询 15 → 150 秒、
    `clarify-review-combination-scenarios` 的流程看门狗 20 → 600 秒（git 与节点 10 → 100 秒）。
  - 结果：两边都是 109 条通过、0 条红，11 个文件全过。
    - 报告类与扫描：`rfc376-report` 16 / 16（byte-identical 那一例候选与对照 568 / 725 秒，超出自带的 300 秒）；
      `rfc294-architecture-preflight` 14 / 14（public surface 一例 180 / 199 秒、能力归属一例 748 / 728 秒，超出自带的 60 秒与 180 秒）；
      `rfc370-committed-architecture-source` 2 / 2（那一例 203 / 242 秒，超出自带的 150 秒）；`rfc400` 6 / 6（负对照一例 31 / 47 秒，超出
      自带的 30 秒）。
    - 取到本 RFC 代码的：`rfc310-digital-employee-system-mock-e2e` 4 / 4（PostgreSQL 两例 455 / 361 秒与 396 / 393 秒，超出自带的 180 秒）、
      `rfc384-daemon-intent-bundle` 12 / 12（维护增量一例的 PostgreSQL 版 31 / 29 秒）、`rfc167` 29 / 29（approve 一例 15 / 12 秒）、
      `rfc300` 2 / 2（46 / 38 秒）、`rfc321-repository-publication-system-mock-e2e` 2 / 2（SQLite 33 / 35 秒、PostgreSQL 36 / 39 秒）。
    - 只红在候选的：`clarify-review-combination-scenarios` 18 / 18（S-RFC074 一例 35 / 31 秒）、`rfc363-workspace-content` 4 / 4（全量
      排序分页一例 49 / 44 秒）。
  - 跑完删除副本，两个导出仓库恢复干净（候选 `d655a2f`、对照 `257aa62`，工作区无改动）。
- **架构报告**（`scripts/architecture-report.ts`，候选 2 与对照各出一份；候选 1 的那份除生成时间与源提交外与候选 2 相同）：
  - 60 项实测都在 `counts.json` 的 `max` 内，与对照只差两项（= 新的 `max`）：
    - `composition-control-flow-identity-access` 2 → 0；
    - `composition-control-flow-intent` 5 → 4。

    少掉的 3 条正是迁走的控制流（对照的 `userOperations.ts` 第 31 行的分支与第 32 行的 `throw`，intent `resourceCatalog.ts` 第 33 行的
    分支），没有新增。

  - 生产文件 4,112 → 4,113（backend 3,248 → 3,249：identity-access 的新文件）。
  - 跨 context import 7,504 不变：identity-access 取 `@/util/errors` 的 `ValidationError` 的那条值边（`legacy-outbound`，W9 移除）从组合文件
    移到新文件。
  - public surface 不变。
  - 模块符号归属 32,387 → 32,391：新文件 3 项（文件本身、`ResetUserPasswordDependencies`、`createResetUserPassword`）与
    `createIntentCatalogActorBinding` 1 项，都在 application。
  - 变更入口 2,367 → 2,369：`createResetUserPassword` 与 `createIntentCatalogActorBinding` 在 application 记为入口，组合层此前不计。
  - 其余各节逐项相同。

- **旧位置全仓扫描**（工作树，候选 2；对全部包、`e2e`、`scripts`、`.github`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，全部文件类型，
  已跟踪与未跟踪）：
  - 新名字（`createResetUserPassword`、`ResetUserPasswordDependencies`、`createIntentCatalogActorBinding`）只出现在各自的新位置、两个组合文件、
    本 RFC 用例、T19b 的销账注释与本 RFC 的文档（含 RFC 索引）里。
  - 表名 `intentCatalogActors` 只在 intent 的新函数里（逐字沿用）与 RFC-359 plan 的历史记述里。
  - 错误串 `intent-resource-catalog-context-not-bound` 除新位置与本 RFC 用例外，只在 T19b 的注释（历史记述第 94、164、183 行，新加的销账
    注释第 151 行）、`rfc349-intent-boot-resume-authority` 自带的同款绑定（第 95 行，不取组合文件）与 RFC-359 plan 的历史记述里。
  - 按路径或名字钉两个组合文件与装配入口的锁里，只有 T19b 的账本与 `rfc349-auth-caller-closure` 按设计改；`rfc347-identity-access-runtime`、
    `architecture/rfc380-daemon-module-bundles`、`architecture/rfc390-neutral-http-binding` 与 `rfc305-architecture-lock` 不改，都通过（见
    复验）。经装配入口取实现的 `users-cli`、用例侧辅助 `helpers/userFixture.ts` 与 `rfc384-daemon-intent-bundle` 不改。
  - e2e `identity-credentials.spec.ts:15` 与 `rfc319-iam-oidc-and-acl.spec.ts:69` 的注释指向旧的 `services/users.ts`，早于本 RFC，不改。
- **收口文档**：plan 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `6ba5d66c9` 的树加本 RFC 的 13 个路径（10 个代码、账本与 design 路径，
  以及 plan、`STATE.md` 与 RFC-505 的 plan）。读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、`docs-runbook-command-guard`、
  `rfc-index-status-drift`、`rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `88011e010`（实现，父提交是 `6ba5d66c9`）：exact SHA 主 CI run 44455094940 的 70 个 job 第 1 次全部通过（含「Static scans」与
  `CI required`），未重跑。
- 本 RFC 的落档提交 `6ba5d66c9`（只改文档，同一提交记下 RFC-505 转 Done 提交 `7f0e056c3` 的 CI 当时仍排队）：主 CI run 44393041030
  共 70 个 job，第一次运行全部通过。没有重跑。
- 补记（RFC-507 的落档提交）：转 Done 的 `0e8d143b9`（只改文档）：主 CI run 44459197814 在本提交时仍排队，结果补记于 RFC-507 的实现提交。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **改密**：`createResetUserPassword` 交出的 `resetPassword` 的函数体是 HEAD `composition/userOperations.ts` 第 31～42 行，只做四处替换：
  `SYSTEM_USER_ID` → `deps.systemUserId`，`Date.now()` → `deps.now()`，`input.auth` → `deps.credentials`（两处），`hashPassword` →
  `deps.hashPassword`。参数解构、返回类型、错误类型、错误码与文案不变；先判系统用户，再取一次时刻，哈希在写之前，写与撤销用同一时刻，
  `force` 缺省 false。组合入口交入的是 `SYSTEM_USER_ID`、`input.auth` 本身（两次调用的接收者仍是认证运行时）、同一个 `hashPassword` 与调用时
  才取的 `() => Date.now()`。`input` 是只读的装配入参，在装配时取 `input.auth` 与每次调用时取没有区别；没有用例替换 `@/auth/passwords`。
  其余成员（含 `afterDisabled`）不变，入口的签名不变。
- **演员绑定**：`createIntentCatalogActorBinding` 的表是 HEAD `composition/resourceCatalog.ts` 第 28 行的 `WeakMap<object, Actor>`，
  `resolveActor` 是第 32～34 行逐字，`bind` 是第 42 行。每次装配建一个绑定，与原来每次装配一张表相同；`resolveActor` 作为函数值交给
  `createQuery`，只用闭包里的表、不用 `this`；交出的对象冻结，没有使用方改它。`contextFor` 的铸上下文、`authorityFor` 与 `catalogs` 不变。
- **账本与锁**：`counts.json` 两项收紧到实测（与架构报告一致）；T19b 账本只删 intent 组合文件那一行，留销账注释；`rfc349-auth-caller-closure`
  改钉新文件，仍要求两次写都是 `await`，组合文件仍钉 `afterDisabled` 的撤销；guard-manifest 登记新用例（637 行）。`rfc347` 的锁不改：新文件的
  注释不再写出组合文件的路径（见上文“缺陷与修正”）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-505 转 Done 提交 `7f0e056c3` 的 CI 当时仍排队，
结果补记于实现提交）；实现与验证后再提交 `refactor(backend): RFC-506 身份访问的改密用例与意图目录的演员绑定迁出 composition（RFC-294
S10 第十三步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
