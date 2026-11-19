# RFC-510 实施计划

依赖：RFC-509；与 S12 共用模块 composition 文件（本 RFC 只改 task-execution `composition/` 下的 7 个文件；装配入口不变）。按 CLAUDE.md 文首硬
规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-510-T1 核对归 application**：7 组核对迁入 task-execution 的 application（4 个既有文件增名字、2 个新文件），3 个运行选择接口挪到
  `application/ports/taskRunSelection.ts`（design D1、D2）。
- **RFC-510-T2 composition 只装配**：7 个组合文件改为从新位置取核对，转出原有的名字（design D3）。
- **RFC-510-T3 账本与随代码改的锁**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`）；`rfc423-composition-assembly-only`
  的 throw 账本随核对迁走收紧（design D4）。
- **RFC-510-T4 用例**：新增 RFC-510 用例（design §4）。
- **RFC-510-T5 集中验证**：backend `tsc`、eslint、prettier；按名字、路径与静态 import 闭包取到改动文件的用例与全部 `tests/architecture/`，按 CI 的
  跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend 分片。验证前重建三天以上的导出仓库
  （RFC-509 的教训）。
- **RFC-510-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的位置声明；7 个组合文件不再有这 26 行核对；装配入口与转出的名字不变
- [x] AC-2 同样输入下每个核对接受与拒绝的输入、错误与时机和此前一致
- [x] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-task-execution` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`90c631993` 主 CI run 44605266287 的 70 个 job 第 1 次全部通过（见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 30～67，主要是本机其他进程）。导出仓库 11-19 08:05 重建过（RFC-509 的教训），验证在候选导出仓库
里跑，核对与工作树逐字相同；对照导出仓库与 HEAD 的树相同。集中验证查出本 RFC 的两处缺陷，修正后复验了相关范围：

- **缺陷与修正**（候选 1 = `0bf3116d2` 的树加本 RFC 的 17 个路径）：
  - `architecture/rfc423-composition-assembly-only` 扫语料后逐文件数 task-execution 组合层的 `throw`，与它的 `THROW_LEDGER` 精确相等。核对迁
    走后 7 个文件的数变了，这一例只在候选一边红。它不按路径读组合文件，迁移前按路径扫 `readFileSync` 的预查找没有找到它（design §5 补记）。
    账本随代码收紧为 3 个文件各 1 条，说明与负对照改用仍在账本里的 `localTaskRunSelection.ts`，guard-manifest 里它的行数改为 212。
  - `architecture/rfc317-guard-negative-fixture` 按语法认“断言不存在”，只认 `toEqual([])` 这类字面形态；本 RFC 用例把“不存在”写成
    `toEqual([location, []])`，不被认出，与账本里的 `assertsAbsence: true` 不符，这一例只在候选一边红。改为
    `expect(x, location).toEqual([])`。

  候选 2 只差这两个用例文件与 guard-manifest 的一行；它们不改生产代码，复验见下文。

- **静态**：backend `tsc` 退出码 0、无输出（修正后再跑仍为 0）；eslint `--max-warnings 0`：改动与新增的 16 个 TS 文件（14 个生产文件与两个用
  例）无告警；prettier：改动的 TS 与本 RFC 的三件套通过。
- **首批**（候选 1；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对照同时、同样跑法）：194 个文件。其中
  `tests/architecture/` 全部 140 个，另 54 个：直接取 7 个组合文件或 7 个新位置的用例、按名字、路径与错误串扫出的用例（含读组合文件原文的
  `envelope-prefix-swap-source`）与本 RFC 用例。经共享用例辅助取到这些文件的用例有 600 多个，交给 CI 的 backend 分片。
  - 两边都跑完的 191 / 190 个文件：候选 1,953 条通过、54 条红，对照 1,953 条通过、54 条红；本 RFC 用例 22 / 22（只在候选一边）。逐文件比失败
    名，候选多出 7 条：上面的两处缺陷，另 5 条撞时限（默认的 5 秒
    4 条：`rfc317-registry-reverse-completeness`、`rfc193-force-include`、`rfc359-w12-collaboration-composition` 与
    `rfc395-run-write-atomicity`；`rfc370-selected-task-root-configuration` 自带的 30 秒 1 条），对照同一条在时限附近通过。对照多出 7 条，都
    撞时限。
  - `single-nonroot-member-workspace` 两边都跑了 28 分钟以上没有结束，为加快推进停掉；`scheduler`、`scheduler-clarify-dispatch` 与
    `scheduler-cross-clarify-dispatch` 两边都红（重负载下的时限），留给 CI。
- **复验**（候选 2）：
  - `tests/architecture/` 全部 140 个、本 RFC 用例与 `envelope-prefix-swap-source`（按首批的跑法，只跑候
    选）：`rfc423-composition-assembly-only`、`rfc317-guard-negative-fixture` 与 `rfc317-registry-reverse-completeness` 通过，本 RFC 用例
    22 / 22；红的 5 个都撞时限，首批里对照同样红在这里（`rfc317-transition-table-oracle`、`rfc359-w5-composition-root-route-surface` 与
    `rfc359-w7-task-insert-lineage-completeness` 撞默认的 5 秒，`rfc376-report` 撞 300 秒，`rfc400-collaboration-task-participants` 的负对照
    撞 30 秒）。
  - 默认时限放宽到 60 秒、与对照同时：首批里候选多出的三个 5 秒红
    （`rfc193-force-include`、`rfc359-w12-collaboration-composition`、`rfc395-run-write-atomicity`）与上面三个 5 秒红
    （`rfc317-transition-table-oracle` 13 / 13、`rfc359-w5-composition-root-route-surface`
    2 / 2、`rfc359-w7-task-insert-lineage-completeness` 6 / 6）两边全过。
  - 放宽副本：`rfc370-selected-task-root-configuration`（七处 30 秒放宽到 1,500 秒，断言不动，跑完删掉）两边都 14 / 14。
- **架构报告**（`scripts/architecture-report.ts`，候选 1 与对照各出一份）：
  - 60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的 `max`）：`composition-control-flow-task-execution` 43 → 17，少掉的 26 条
    正是迁走的核对（余下 4 条只是行号随之移动）；没有新增。
  - 生产文件 4,121 → 4,123（两个新文件）；跨 context import 7,508 不变；模块符号归属 32,417 → 32,425；变更入口 2,379 不变。
  - public surface 1,195 不变；task-execution public participants 转出的 `selectPortArtifactReader` 的 `$call` 摘要按函数全文计，函数体改为
    调用核对后随之变，签名与面的预算不变（仓里没有钉住这个摘要的账本）。
  - 其余各节逐项相同。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/`、`design/` 与 `STATE.md`，全部文件类型；按词边界）：新名字只出现在新
  位置、7 个组合文件、本 RFC 用例与 design 里（另有 git 忽略的本机产物）；七条错误串除新位置外只在按错误串断言的
  `rfc370-port-output-validation`、`rfc370-task-launch-configuration-closure` 与本 RFC 用例里。
- **收口文档**：plan、design、proposal 与 `STATE.md` 定稿后（含 RFC-509 的 CI 补记），在工作树（只有本会话的改动）里重跑读这几处文档与 RFC
  索引的 6 个用例（与 RFC-508 相同），全过（33 / 33）。

## CI（AC-4）

- `90c631993`（实现，父提交是 `d8ff84650`）：exact SHA 主 CI run 44605266287 的 70 个 job 第 1 次全部通过（含「Static scans」与
  `CI required`），未重跑。
- 本 RFC 的落档提交 `d8ff84650`（只改文档，同一提交记下 RFC-509 转 Done 提交 `0bf3116d2` 的 CI 当时仍在运行）：主 CI run 44593469586 共
  70 个 job，第一次运行全部通过。没有重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：迁出的核对由脚本按 HEAD 原行切片生成，再用脚本按词法单元比对（注释也比，只忽略换行与缩进）：18 段都在新位置连续出现、逐个相
  同，没有替换（只有缩进与 D1 列出的入参名）：
  - 产物端口：HEAD `portArtifacts.ts` 第 22～45 行（91 个词法单元）、第 47～58 行（57 个）与读取器的核对第 94～96 行（26 个）；
  - 删除效果：HEAD `taskDeletionEffects.ts` 第 8～19 行（57 个）与第 31～42 行（62 个）；
  - 提示词端口：HEAD `nodeRunPrompts.ts` 第 13～25 行（68 个）与第 27～38 行（57 个）；
  - 输出校验：HEAD `portOutputValidation.ts` 第 23～30 行（33 个）；
  - 运行选择：三个接口 HEAD `taskRunSelection.ts` 第 14～31 行（58 个）、根选择的核对第 38～58 行（127 个，改为导出）、配置引用的核对第
    70～76 行（29 个）与 `localTaskRunSelection.ts` 第 148～150 行（26 个）；
  - 启动配置：HEAD `launchConfiguration.ts` 第 25～32 行（45 个）；
  - 四个既有 application 文件与端口文件原有的内容原样保留（import 只增端口类型）。
- **时机与次序**：装配时的核对仍在装配时调用（选择之后、交出之前），`bind` 里的配置核对仍在每次驱动时、取到配置后调用；删除效果仍先核对效果
  对象、再核对内容收发、最后核对仓库参与者；短路次序与错误类型、错误串不变。
- **装配入口与交出的对象**：7 个组合文件的装配入口名字、入参与返回类型不变；原来从组合文件导出的 5 个 `require*` 与 3 个接口照旧可从原位置
  取，bootstrap、路由、基础设施与用例的 import 不改。`selectPortArtifactReader` 经 task-execution 的 public participants 转出，函数体改为调
  用核对，签名不变。
- **账本与锁**：`counts.json` 一项收紧到实测（与架构报告一致）；guard-manifest 登记新用例
  （700 行，`assertsAbsence: true`）；`rfc423-composition-assembly-only` 的 throw 账本随核对迁走收紧为 3 个文件各 1 条（集中验证查出，见上
  文），它在 guard-manifest 里的行数改为 212。钉着这些文件的其余用例不改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-509 转 Done 提交 `0bf3116d2` 的 CI）；实现与验证后再提交
`refactor(backend): RFC-510 任务执行组合层的端口完整性核对迁出 composition（RFC-294 S10 第十七步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
