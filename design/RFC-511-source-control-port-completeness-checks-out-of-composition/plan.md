# RFC-511 实施计划

依赖：RFC-510；与 S12 共用模块 composition 文件（本 RFC 只改 source-control `composition/` 下的 7 个文件；装配入口不变）。按 CLAUDE.md 文首硬
规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-511-T1 核对归 application**：5 组工作区端口核对迁入新的 `application/workspacePorts.ts`，候选效果工厂的核对迁入新的
  `application/repositoryCandidateEffects.ts`，冲突合并效果的核对并入 `application/conflictMerge.ts`（design D1）。
- **RFC-511-T2 composition 只装配**：7 个组合文件改为调用新位置的核对，转出原有的名字（design D2）。
- **RFC-511-T3 账本与锁**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`）；`rfc294-architecture-preflight` 的允许清单随声明
  位置更新（design D3）。
- **RFC-511-T4 用例**：新增 RFC-511 用例（design §4）。
- **RFC-511-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字与错误串扫出的用例与全部 `tests/architecture/`，按 CI 的跑法
  与 HEAD 同时 A/B；红的按时限放宽复核；`rfc294-architecture-preflight` 的放宽副本；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend
  分片。
- **RFC-511-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的位置声明；7 个组合文件不再有这 28 行核对；装配入口、选择函数与转出的名字不变
- [x] AC-2 同样输入下每个核对接受与拒绝的输入、错误与时机和此前一致
- [x] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-source-control` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI 除外部服务的链接检查外全绿（逐格归因见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 30～41，主要是本机其他进程）。导出仓库 11-19 08:05 重建过，验证在候选导出仓库里跑，核对与工作树
逐字相同；对照导出仓库与 HEAD（`036df2e8c`）的树相同。集中验证没有查出本 RFC 的缺陷：

- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动与新增的 12 个 TS 文件（10 个生产文件与两个用例）无告警，10 个生
  产文件另过 promises 配置；prettier：改动的 TS、两个 JSON 账本与本 RFC 的三件套通过。
- **首批**（候选 1 = `036df2e8c` 的树加本 RFC 的 14 个路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与
  对照同时、同样跑法）：179 个文件。其中 `tests/architecture/` 全部 140 个，另 39 个：直接取 7 个组合文件或 3 个新位置的用例、按名字、路径与
  错误串扫出的用例、`rfc294-architecture-preflight` 与本 RFC 用例。同样扫出的 `single-nonroot-member-workspace`（RFC-510 时两边都跑了 28 分
  钟以上没有结束）交给 CI 的 backend 分片。
  - 两边都跑完：候选 1,748 条通过、72 条红，对照 1,736 条通过、71 条红；本 RFC 用例 13 / 13（只在候选一边）。逐文件比失败名，候选多出 3 条、
    对照多出 2 条，都撞默认的 5 秒：候选是 `rfc310-mission-driver`（PostgreSQL）1 条与 `rfc396-verification`（SQLite）2 条，对照是
    `rfc371-v2-observation-boundaries` 1 条与 `rfc370-workspace-exclude-selected`（PostgreSQL）1 条。
  - 两边相同的红都是时限：默认 5 秒（`rfc396-mr-bridge` 28 条、`rfc396-verification` 25 条、`rfc317-transition-table-oracle` 3 条等）；自带
    时限的 6 条（`rfc294-architecture-preflight` 的能力归属一例 180 秒、`rfc376-report` 300 秒、`rfc310-digital-employee-system-mock-e2e` 两
    条 180 秒、`rfc321-repository-publication-system-mock-e2e` 两条 30 秒）；`rfc359-w14-legacy-mission-execution`（PostgreSQL）一条在用例自
    己等待终态回调处超时（约 41 秒，“legacy mission terminal callback timed out”）。
  - 直接覆盖 7 组核对的用例在候选一边全过：`rfc370-isolation-workspace-scope` 5 / 5、`rfc370-repository-git-workspace`
    8 / 8、`rfc370-workspace-upload-content` 13 / 13、`rfc370-task-workspace-read-queries` 19 / 19、`rfc370-conflict-workspace-effects`
    26 / 26 与 `rfc370-conflict-workspace-bindings` 7 / 7、`rfc370-candidate-publication-effects` 11 / 11 与
    `rfc370-candidate-publication-bindings` 3 / 3、`rfc370-repository-candidate-effects` 10 / 10、`rfc370-v3-coarse-candidate`
    5 / 5；`rfc294-architecture-preflight` 里核对允许清单的一例在候选一边通过。
- **复验**（默认时限放宽到 60 秒、与对照同时，其余同首批）：首批里候选与对照各自多出的红所在的 4 个文件、两边同样撞 5 秒的
  `rfc310-employee-workspace-repository-freshness` 与 3 个架构用例
  （`rfc317-transition-table-oracle`、`rfc359-w5-composition-root-route-surface`、`rfc359-w7-task-insert-lineage-completeness`），共 8 个文
  件两边各 98 / 98 全过（`rfc396-verification` 54 / 54、`rfc370-workspace-exclude-selected` 10 / 10、`rfc310-mission-driver` 3 / 3）。
- **放宽副本**：`rfc294-architecture-preflight` 的能力归属一例（180 秒放宽到 1,800 秒，断言不动，只跑这一例，与对照同时，跑完删掉）两边都通
  过（各约 935 秒）。`rfc396-mr-bridge` 两边都是同样的 28 条 5 秒红（单文件约 13 分钟），与 `rfc376-report`、两个系统 mock E2E 的自带时限红
  一起交给 CI 的 backend 分片。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：
  - 60 项实测都在 `counts.json` 的 `max` 内（都等于 `max`），与对照只差一项（= 新的 `max`）：`composition-control-flow-source-control` 148 →
    120，少掉的 28 条正是迁走的核对，另 4 条只是行号随之移动；没有新增。
  - 生产文件 4,123 → 4,125（两个新文件）；跨 context import 7,508 不变；模块符号归属 32,425 → 32,434（组合层少 4 个、新位置多 13 个）。
  - public surface 1,195 不变；public surface 偏差 56 不变，经 public participants 转出的两个 `require*` 的条目随声明位置改到
    `application/workspacePorts.ts`（开放类型的种类不变）。public 转出的 6 个选择 / 绑定函数的 `$call` 摘要按函数全文计，函数体改为调用核对
    后随之变，签名与面的预算不变（仓里没有钉住这个摘要的账本）。
  - 其余各节逐项相同。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，全部文件类型；按词边界）：新名字
  只出现在新位置、7 个组合文件、本 RFC 用例与 design 里（`requireConflictMergeWorkspaceEffects` 另在 RFC 索引的一行）；`validateFactory` 只
  剩 design 对 HEAD 的记述；十一条错误串除新位置外只在按错误串断言的 rfc370 用例与本 RFC 用例里。
- **账本**：guard-manifest 的 `lines` 不被任何用例核对（321 项里 275 项与文件的换行数不等），本 RFC 新登记的一项按换行数记
  664 行，`rfc294-architecture-preflight` 原有的一项不改。
- **收口文档**：plan 与 `STATE.md` 定稿后（含 RFC-510 转 Done 提交的 CI 补记），在工作树里重跑读这几处文档与 RFC 索引的 6 个用例（与
  RFC-510 相同），全过（33 / 33）。

## CI（AC-4）

- `6006cf70a`（实现，父提交是 `4353e15ee`）：exact SHA 主 CI run 44626593875 的 70 个 job 第 1 次运行 68 个通过；design/ 的链接检查
  红：GitHub 对 `design/RFC-371-run-observability/native-real-validation-20261007.md` 第 7 行的提交链接重试 5 次后仍回 503（外部服务暂时不可
  用，该文件不在本提交里），`CI required` 只因它红；未重跑。后继 RFC-512 实现提交 `b0fa6513a` 的 run 44630588862 里同一项链接检查通过（70 个
  job 全部通过）。
- 本 RFC 的落档提交 `4353e15ee`（只改文档，同一提交记下 RFC-510 转 Done 提交 `036df2e8c` 的 CI 当时仍在运行）：主 CI run 44616049713 共
  70 个 job，第一次运行全部通过（含 design/ 的链接检查）。没有重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：迁出的核对由脚本按 HEAD 原行切片生成，再用脚本按词法单元比对（注释也比，只忽略换行与缩进）：12 段都在新位置连续出现、逐个相
  同，没有替换（只有缩进与 D1 列出的函数头）：
  - 工作区端口（`workspacePorts.ts`）：HEAD `isolationWorkspaces.ts` 第 7～33 行（97 个词法单元）与第 40～42 行
    （26 个）、`repositoryGitWorkspaces.ts` 第 9～27 行（90 个）与第 36～38 行（26 个）、`workspaceUploads.ts` 第 7～25 行（81 个）与第
    32～34 行（26 个）、`workspaceExcludeProfiles.ts` 第 23～25 行（26 个）与第 41～47 行（26 个）、`repositoryWorkspaceReadQueries.ts` 第
    9～22 行（59 个）；
  - 冲突合并效果：HEAD `conflictMerge.ts` 第 25～39 行（55 个），`application/conflictMerge.ts` 原有的内容原样保留（1,553 个）；
  - 候选效果工厂：HEAD `repositoryCandidate.ts` 第 27～47 行（109 个，`validateFactory` 的函数体）。
- **时机与次序**：工厂、选定效果与只读查询的核对仍在选择或装配时、选定之后交出之前调用；作用域与参与者的核对仍在每次绑定
  时、`bind` / `subrepository` 返回之后调用；候选效果工厂的核对仍在两个装配入口的开头各调一次。短路次序与错误类型、错误串不变。
- **装配入口与交出的对象**：7 个组合文件的装配入口、选择与绑定函数的名字、入参与返回类型不变；原来从组合文件导出的 3 个 `require*` 照旧从原
  位置转出，public participants、`repositoryCommit.ts`、`workspaceChangePublication.ts`、task-execution 的基础设施与用例的 import 不改。
- **账本与锁**：`counts.json` 一项收紧到实测（与架构报告一致）；guard-manifest 登记新用例（664 行，`assertsAbsence: true`，“不存在”写成
  `toEqual([])` 的字面形态）；`rfc294-architecture-preflight` 的允许清单里两条随声明位置改到新文件、按字母序归位并加一行说明。钉着这些文件的
  其余用例不改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-510 转 Done 提交 `036df2e8c` 的 CI）；实现与验证后再提交
`refactor(backend): RFC-511 源码控制组合层的端口完整性核对迁出 composition（RFC-294 S10 第十八步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
