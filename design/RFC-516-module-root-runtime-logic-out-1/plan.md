# RFC-516 实施计划

依赖：RFC-515。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-516-T1 归 application**：新增 `event-center/application/unavailableObserverProgram.ts` 与 `identity-access/application/runtimePresenceConnections.ts`；
  `source-control` 的两个 application 文件各增一个名字（design D1）。
- **RFC-516-T2 模块根只装配**：三个模块根 `composition.ts` 改为取新位置（design D2）。
- **RFC-516-T3 门与账本**：RFC-515 门的例外清单删 3 条；guard-manifest 登记新用例（design D3）。
- **RFC-516-T4 用例**：新增 RFC-516 用例（design §4）。
- **RFC-516-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部 `tests/architecture/`，按 CI 的跑法与
  HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-516-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的位置声明；三个模块根不再有循环、`try` 与 `throw`；门的例外清单删去它们后仍绿
- [x] AC-2 缺省观察者、登记表、收敛与核对的行为、错误与次序和此前一致
- [x] AC-3 新位置的依赖面是闭集；public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 24～42，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`c5a6c2aeb`）的树相同。集中验证没有查出本 RFC 的缺陷：

- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：7 个生产文件（另过 promises 配置）与本 RFC 用例无告警；prettier：改动
  的 TS、guard-manifest 与本 RFC 的三件套通过。
- **首批**（候选 = `c5a6c2aeb` 的树加本 RFC 的 10 个路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对
  照同时、同样跑法）：171 个文件。其中 `tests/architecture/` 全部 142 个，另 29 个：按名字、路径与错误串扫出的用例（经三个模块根取用的事件中
  心、在线状态、仓库发布与员工案例工作区用例）、`rfc294-architecture-preflight` 与本 RFC 用例。同样扫出的 `rfc396-mr-bridge`（单文件约 13 分
  钟、两边都撞同样的 5 秒）与两个 RFC-310 系统 mock E2E（两边都撞自带的 180 秒）交给 CI 的 backend 分片。
  - 两边都跑完：候选 1,692 条通过、27 条红，对照 1,683 条通过、25 条红；本 RFC 用例 11 / 11（只在候选一边）。逐文件比失败名，候选多出的红都
    是时限（`rfc310-event-center` 与 `rfc310-type-package-auto-upgrade` 的 PostgreSQL 一半、`rfc371-v2-observation-boundaries` 撞默认的
    5 秒，`rfc400-collaboration-task-participants` 撞自带的 30 秒），对照多出的同样都是时限。
  - 直接覆盖三个模块根的用例两边全过：`rfc347-identity-access-runtime`（在线状态登记表）、`rfc321-repository-publication-ratchet` 与
    `rfc349-source-control-promise-contract`（读组合文件原文）、`rfc370-employee-case-workspace-effects` 与
    `rfc370-v3-coarse-employee-case`（按错误串断言）等。
- **复验**（默认时限放宽到 60 秒、与对照同时，其余同首批）：候选多出的红所在的 3 个文件与对照多出的 1 个两边各 69 / 69 全过
  （`rfc310-event-center` 26 / 26 经装配入口跑缺省观察者、`rfc310-type-package-auto-upgrade` 34 / 34）。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测与对照逐项相同（F13 不计模块根，本 RFC 不改控制流计数）；跨
  context import 7,507 不变（bootstrap 对收敛函数的那条随转出改指 application）；模块符号归属 32,450 → 32,454；public surface 与偏差不变；其
  余各节逐项相同。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，按词边界，含正则里转义的写法）：
  迁走的三段原文只在新位置与按错误串断言的用例里；新名字只出现在新位置、三个模块根、本 RFC 用例与本 RFC 的文档里。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例（与 RFC-515 相同），全过（33 / 33）。

## CI（AC-4）

- 【待补：实现提交】
- 本 RFC 的落档提交 `c5a6c2aeb`（只改文档，同一提交记下 RFC-511、RFC-512 转 Done）：主 CI run 44653491871 在本提交时仍在运行，结果补记于本
  RFC 转 Done 的提交。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：由脚本按 HEAD 原行切片生成，再用脚本按词法单元比对（注释也比，只忽略换行与缩进）：3 段都在新位置连续出现、逐个相同：HEAD
  `event-center/composition.ts` 第 255～259 行（缺省观察者的 `run`）、`identity-access/composition.ts` 第 65～93 行（登记表类，改为导
  出）、`source-control/composition.ts` 第 155～172 行（收敛函数）与第 231～237 行（员工案例操作宿主的核对，`selected` 收窄为形参）。
- **时机与次序**：缺省观察者仍在每次装配、未给观察者时新建；登记表仍由装配入口用同一个直接认证运行时与在线状态记录器构造一次；收敛仍逐行同
  步、再移除缺失的提供方；核对仍在每次取员工案例工作区操作时、选中托管宿主后调用。错误类型、错误串与次序不变。
- **装配入口与交出的对象**：三个模块根的装配入口名字、入参与返回类型不变；source-control 仍转出
  `reconcileRepositoryTransportConnectionProjections`，bootstrap 的 import 不改。
- **账本与锁**：RFC-515 门的例外清单删 3 个模块根（33 → 30），guard-manifest 登记新用例（`assertsAbsence: true`，“不存在”写成 `toEqual([])`
  的字面形态）；`counts.json` 不变。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-516 模块根装配文件的运行期逻辑迁出（一）（RFC-294 S10 第二十三步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff /
push。推送后按 exact SHA 跟 CI。
