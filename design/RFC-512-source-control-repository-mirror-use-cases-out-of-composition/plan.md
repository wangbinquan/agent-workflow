# RFC-512 实施计划

依赖：RFC-511；与 S12 共用模块 composition 文件（本 RFC 只改 source-control `composition/repositoryMirrors.ts`；装配入口不变）。按 CLAUDE.md 文首
硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-512-T1 用例归 application**：新增 `application/repositoryMirrors.ts`（`readRegisteredRepository`、`createLocalRepositoryMirrors`、
  `createRemoteRepositoryMirrors`），端口文件增 `RepositoryDirectoryReads` 与 `RepositoryMirrorCache`（design D1）。
- **RFC-512-T2 composition 只装配**：`composeRepositoryMirrors` 只做选择并注入基础设施实现（design D2）。
- **RFC-512-T3 账本**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`）（design D3）。
- **RFC-512-T4 用例**：新增 RFC-512 用例（design §4）。
- **RFC-512-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend 分片。
- **RFC-512-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的位置声明；组合文件只剩一处选择；装配入口的名字、入参与返回形状不变
- [x] AC-2 同样输入下单机与托管两种装配的每个操作结果、错误与 effect 次序和此前一致
- [x] AC-3 新位置的依赖面是闭集、时钟由装配注入；public surface 不升；`composition-control-flow-source-control` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 29～42，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`f4a79d7ce`）的树相同。集中验证查出本 RFC 的一处缺陷，修正后复验了相关范围：

- **缺陷与修正**（候选 1 = `f4a79d7ce` 的树加本 RFC 的 6 个路径）：backend `tsc` 在本 RFC 用例里报一处类型错（TS2769）：刷新投影的替身返回
  `{ id, count }`，与 `toEqual` 按 `RepositoryRefresh` 推出的类型不符。只是类型层的问题（bun 不做类型检查，用例本身 14 / 14 通过），把实际值
  先赋给 `unknown` 再比较，并加一行说明。候选 2 只差这个用例文件与 guard-manifest 里它的行数（636 → 638），复验见下文。
- **静态**：候选 2 的 backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：3 个生产文件（另过 promises 配置）与本 RFC 用例无告
  警；prettier：改动的 TS、两个 JSON 账本与本 RFC 的三件套通过。
- **首批**（候选 1；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对照同时、同样跑法）：155 个文件。其中
  `tests/architecture/` 全部 140 个，另 15 个：按名字、路径与错误串扫出的用例
  （`rfc370-v4-repository-mirrors`、`rfc446`、`rfc447`、`rfc451`、`rfc370-v3-volume-repository-mirrors`、`repos` 等）、经性能装配辅助取用装
  配入口的两个用例、`repos-path-allowlist`、`rfc294-architecture-preflight` 与本 RFC 用例。
  - 两边都跑完：候选 1,523 条通过、13 条红，对照 1,505 条通过、17 条红；本 RFC 用例 14 / 14（只在候选一边）。逐文件比失败名，候选多出
    1 条：`repos`（PostgreSQL）的 `GET /api/repos/files` 一例在 `beforeEach` / `afterEach` 钩子处撞默认的 5 秒；对照多出 5 条，同样都是时限
    （`repos` 3 条钩子超时、`rfc359-w12-performance-http-conformance` 1 条 5 秒、`rfc400-collaboration-task-participants` 1 条自带的
    30 秒）。
  - 两边相同的红都是时限：`rfc317-transition-table-oracle` 3 条、`rfc359-w5-composition-root-route-surface` 与
    `rfc359-w7-task-insert-lineage-completeness` 各 1 条、`repos-path-allowlist` 2 条（默认 5 秒），`repos` 3 条（PostgreSQL 的钩
    子），`rfc359-w12-performance-http-conformance` 1 条（5 秒），`rfc376-report` 1 条（自带的 300 秒）。
  - 直接覆盖装配入口的用例两边全过：托管的 `rfc370-v4-repository-mirrors` 16 / 16、单机已登记目录的 `rfc446` 11 / 11、`rfc451`
    7 / 7、`rfc447` 11 / 11、`rfc370-v3-volume-repository-mirrors` 3 / 3、`rfc204-credential-sealing`
    34 / 34、`rfc287-t11-file-scheme-rejected` 11 / 11、`rfc394-deployment-profile` 9 / 9、`rfc433-explicit-presence-selections`
    3 / 3；`repos` 的 SQLite 一半两边全过；`rfc294-architecture-preflight` 两边 14 / 14。
- **复验**（候选 2；默认时限放宽到 60 秒、与对照同时，其余同首批）：本 RFC 用例 14 / 14；读 guard-manifest 与普查的
  `rfc317-guard-negative-fixture` 17 / 17、`rfc317-architecture-ledgers` 15 / 15 与 `rfc317-guard-corpus-floor` 24 / 24；首批里撞 5 秒或钩子
  时限的 6 个文件两边全过（`repos` 16 / 16、`repos-path-allowlist` 9 / 9、`rfc359-w12-performance-http-conformance` 12 / 12 与 3 个架构用
  例）。共 10 个文件，候选 128 条、对照 114 条全过（对照没有本 RFC 用例）。只在对照一边撞自带 30 秒的
  `rfc400-collaboration-task-participants` 与两边都撞自带 300 秒的 `rfc376-report` 交给 CI 的 backend 分片。
- **架构报告**（`scripts/architecture-report.ts`，候选 1 与对照各出一份）：
  - 60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的 `max`）：`composition-control-flow-source-control` 120 →
    110，`repositoryMirrors.ts` 的 11 条只剩一处选择；没有新增。
  - 生产文件 4,125 → 4,126（一个新文件）；跨 context import 7,508 不变（`@/util/errors` 与 `@/util/hash` 的 4 条随用例从组合文件移到新文
    件）；模块符号归属 32,434 → 32,440。
  - 报告的变更入口一节多了两条（2,379 → 2,381）：新文件里的两个工厂各记一条（组合文件里的装配入口原先不在这一节）；这一节只是报告，没有计数
    或门以它为据（`counts.json` 与 gates 除上面一项外都相同）。
  - public surface 与偏差不变；其余各节逐项相同。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，按词边界）：新名字只出现在新位
  置、组合文件（两个工厂）、本 RFC 用例与本 RFC 的文档（`RepositoryMirrorCache` 与 `readRegisteredRepository` 另在 STATE 的本 RFC 条目与 RFC
  索引的一行）；`cached-repo-not-found`、`repo-url-unavailable`、`repo-url-invalid` 三条错误串不再出现在 source-control 的 `composition/`
  里。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例（与 RFC-511 相同），全过（33 / 33）。

## CI（AC-4）

- 【待补：实现提交】
- 本 RFC 的落档提交 `f4a79d7ce`（只改文档）：主 CI run 44626872531 在本提交时仍在排队，结果补记于本 RFC 转 Done 的提交。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：用例由脚本按 HEAD 原行切片生成，再用脚本按词法单元比对（注释也比，只忽略换行与缩进）：12 段都在新位置连续出现、逐个相同，替
  换只有 design D1 列出的四处 effect 改走端口、`registered` 闭包与 `readRegisteredRepository` 的参数：
  - `application/repositoryMirrors.ts`：HEAD 第 37～39 行（16 个词法单元）、第 43～54 行（82 个，单机读与错误改写）、第 66～74 行（28 个）、
    第 75～77 行（42 个）、第 80～93 行（106 个）、第 103～111 行（73 个）与第 113～121 行（38 个）；
  - `composition/repositoryMirrors.ts`：装配入口的签名第 26～34 行（40 个）、已登记目录读取连同 RFC-446 的注释第 58～60 行（18 个）、时钟的
    选择第 63 行（10 个）与身份行的依赖对象第 95～102 行（56 个）；
  - 端口文件原有的内容原样保留（186 个）。
- **时机与次序**：时钟仍在装配时按 HEAD 原样取一次，同一个值交给核验记录与身份行；切面缓存作废仍以同一个仓库存储为键；单机仍先读已登记行、再
  在镜像目录上读，读失败的领域错误按 HEAD 原样改写；托管的登记仍先解析地址、再核验远端、查旧行、记身份行、记核验结果并作废缓存；刷新仍是读
  行、拆地址、核验、记结果、作废、重读、计数、投影。错误类型、错误码、文案、状态与详情不变。
- **装配入口与交出的对象**：`composeRepositoryMirrors` 的名字、入参与返回类型不变；单机交出 `refs` / `files` / `local`，托管交出
  `refs` / `files` / `remoteRegistration`，与 HEAD 相同；bootstrap、性能装配辅助与用例的 import 不改。
- **账本与锁**：`counts.json` 一项收紧到实测（与架构报告一致）；guard-manifest 登记新用例（638 行，`assertsAbsence: true`，“不存在”写成
  `toEqual([])` 的字面形态）。`rfc446` 钉的镜像目录读取的唯一取用方仍是这个组合文件。钉着这些文件的其余用例不改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-512 源码控制的已登记仓库读取与远端登记用例迁出 composition（RFC-294 S10 第十九步）`。走私有 index、按路径清单提交，在共
享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
