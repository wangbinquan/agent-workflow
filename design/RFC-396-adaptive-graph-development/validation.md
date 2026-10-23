# RFC-396 实现候选验收记录

## 2026-10-22 MR 能力补齐与全面回顾：当前候选

本轮生产和用例已完成，已以 `ba7b8c6c4a03f0ab952dfd52fee291332dda74f5` 发布到 `origin/main`，集中验证正在收口，RFC 仍 In Progress。旧版内部交付证据在下方保留，不外推为新的 MR 能力通过。

| 范围 | 本轮结果与证据界限 |
| --- | --- |
| PostgreSQL，全部 `rfc396-*.test.ts` | **156 pass / 0 fail，909 expect，24 files，168.47s**；真实专用 PostgreSQL，不是 SQLite 推断。日志 `/tmp/rfc396-mr-postgresql-central.log` |
| SQLite，首轮 24 files | **147 pass / 8 fail，862 expect**；原失败如实保留。2 个 runtime 新断言形状、4 个局部 fixture 非法修改来源、1 个旧人工验收 fixture 不可读、1 个应用装配缺共享 MR 修复工具初始化 |
| SQLite，失败范围复验 | runtime/jobs/intake **17/0**；local-planning/review-regressions **17/0**；verification **13/0**；HTTP/registration 通过。未重跑未变化的整个集合，不将重叠结果重复累计 |
| 既有装配回归 | RFC-383 guard 分别追踪 graph@1 / graph@2，保留 former-wiring 对照；修后 **12/0，57 expect**。默认 MR 工具在 load 时先确保共享内置 agents，真实 HTTP 应用启动通过 |
| 前端交互 | 终止态 **6/0**；人工验收候选/范围变化 **11/0**；工作区修后 **26/0**（含实现门发现的两条恢复旅程）；合计覆盖 **43 个独立用例**，三文件结果分别记录 |
| 独立实现门 | **PASS**；两处 UI 旅程回归修复后定向复核通过，详见 [implementation-gate](./implementation-gate.md) |
| 静态 | backend / frontend 初轮修后 `tsc --noEmit` 通过；backend 默认 Node 4 GiB heap OOM，8 GiB 完成。末次共享树前端检查又出现 3 处并发错误：非本任务 `shared/src/schemas/task.ts` 的 `taskExecutionKind` 新增 `digital-employee`，而 `TaskSubjectLink.tsx` / `tasks.new.tsx` 尚未覆盖。实际 diff 已核实，未代改或纳入提交；本任务新增测试的参数类型已修。任务路径 ESLint 通过，最终整仓结论以本次 exact-SHA CI 为准 |
| MR E2E | 三个既有图旅程已适配 graph@2，保留主要图/审核/证据断言，并增加同 Case MR 创建、缺 CI 不误绿、外部 merged/closed 观测终结；模型与 code host 是受控 fixture。本次托管 CI 的浏览器任务已启动，尚无通过结论；数字员工启动模型的发布依赖缺口单列于下方 |
| 真人浏览器 | 当前 CUA inventory 为 apps=[] / browsers=[]，创建 iab 返回 `Browser is not available: iab`；不宣称本轮真人界面验收通过 |
| 发布与 hosted CI | `ba7b8c6c4a03f0ab952dfd52fee291332dda74f5` 已推送，推送后本地/远端差异 `0/0`，共享 index 为空；71 个准确路径包含本任务内并行 Codex 产出，其他在制内容保留未提交。[主 CI 39914131430](https://github.com/wangbinquan/agent-workflow/actions/runs/39914131430) 与 [视觉回归 39914131342](https://github.com/wangbinquan/agent-workflow/actions/runs/39914131342) 执行中；此前 `67795ed462` 的结果不能证明新代码 |

新增实现与恢复边界见 [全面回顾](./review-and-mr-parity.md)，岗位与 CI 连接使用方式见 [usage](./usage.md)。本轮未修改旧托管实例或其镜像。

### 本轮发布后的 CI 归因与共享文件依赖缺口

`ba7b8c6c4a03` 的 [CI 39914131430](https://github.com/wangbinquan/agent-workflow/actions/runs/39914131430) 已报告失败；本地共享树中的通过结果不能替代这个实际发布快照。独立功能复核只能说明其审阅的候选内容，不能据此认为发布依赖已完整。

| 失败范围 | 已核实原因与处置 |
| --- | --- |
| 类型检查、backend 10/24 的 hostWorkflow 四项、backend 20/24 的真实数字员工执行四项，以及 backend 14/24 的人工审核 E2E | `digitalEmployeeExecution.ts` 整文件除本任务的材料说明前缀/env，还提交了 RFC-395 II-a 的 `TaskStartOptions`、新 `subject` 和移除旧宿主播种的改动；所依赖的共享 schema、启动 kernel、任务主体/创建、审核投影及测试仍只在本地在制。远端旧 kernel 仍读取 `input.subject.workflowId`，类型和实际启动均不成立。**这是本次发布选择的依赖闭包遗漏，不能仅称为外部旧测试问题。** 保留全部迁移产出，不还原新模型、不删旧断言，也不擅自扫入尚未完成集中验证的迁移文件。完整迁移闭包可提交之前，此项阻塞整仓通过 |
| backend 15/24，OS 架构两项 | 新 MR 界面包含开发员工业务语义却位于通用数字员工组件目录；两个类型包组合层依赖未登记。修复将图功能归位至 development-automation feature，并精确补齐已审阅依赖，既有禁止规则保持不变 |
| backend 6/24，测试跳过登记 | 新 MR bridge 测试因 POSIX shebang/chmod 夹具跳过 Windows；业务断言本身无需该限制。改为生产仓库脚本解析器定位脚本、显式 Bun 执行，保留全部 17 项用例和真实执行证据，不增加跳过豁免 |
| backend 1/24，能力证据索引 | 两个 graph E2E 标题更新后索引仍是旧名称；只重接精确标题，保留原有覆盖断言 |
| Static scans | 只读取状态元数据：该 job 失败。未读取该类 findings 或日志，未对此开展分析 |

依赖缺口的具体边界：`packages/shared/src/schemas/task.ts`、Task Execution 的 `taskRouteLaunchOperations.ts` / `taskSubject` / `taskCreation` / repository codecs、Collaboration 的 `review.ts` 与任务主体查询合同、`actionExecutionEnvironment.ts` 及对应历史回归。当前 `public/queries`、`services/task` 和新增测试 helper 又与迁移其他部分耦合，不能把这些路径当作已确认可独立发布的 allowlist。对应 II-a 计划要求整组集中验证后提交；本任务继续处理独立缺陷，未替代迁移责任范围。

本任务独立修复已完成集中复验：SQLite 的 OS 架构、测试跳过策略、能力索引与 MR bridge 四文件 **58 pass / 0 fail，189 expect**；迁移后图工作区/人工验收/终态与 overlay inventory 四文件 **46 pass / 0 fail**；14 个相关 TS/TSX 路径 ESLint 通过。日志分别为 `/tmp/rfc396-ci-repair-backend.log`、`/tmp/rfc396-ci-repair-frontend.log`、`/tmp/rfc396-ci-repair-lint.log`。8 个 UI 文件迁移前后内容 SHA256 一致；没有改动 OS 禁止规则或测试跳过允许清单。以上不覆盖未闭合的 Task 主体发布依赖，也不是 Windows bridge 实跑或新提交的 hosted CI 通过证明。


**2026-10-22 全面回顾后的当前裁决：需要修改后再验收。** 以下“功能验收完成”是前一轮范围的历史记录。本轮确认 R01～R10 功能/可用性缺口，以及 MR 提交和持续看护未接入；新增范围见 [review-and-mr-parity.md](./review-and-mr-parity.md)。原浏览器旅程含 API 建立工作和提交澄清，不能当成全程 UI 可用性证明。新的 MR 生命周期、修复和 UI 验收尚未完成。

2026-10-22 当前功能验收已完成：三个真实模型旅程已交付（预约 24/0、通知 44/0、已有模块 13/0）；实际托管 Case 已 terminal / graph-development.delivered，独立测试 1/0、6 assertions，原始证据和产品入口均已读回。最新修复源码 `67795ed462` 的主 CI 39814553963 为 49/49 success；共享 main 后继整体 CI 尚有失败，RFC 保持 In Progress，功能验收与最终仓库 CI 分列。精确版本见 [真实模型汇总](./real-model-summary.json)、[托管完整回执](./hosted-completion-evidence.json) 和 [失败及恢复历史](./real-model-acceptance.md)。

以下为 2026-10-21 首轮候选及后续修复的历史验证记录；最新状态见上方和真实验收文档。用户批准完整实现与远端交付；此记录分别说明已证实内容和尚未证实内容，不以单个通过结果宣称 RFC Done。

## 候选与环境

- 在现有主 checkout 的 `main` 开发，保留并发 RFC-395 和任务执行修复；未创建开发分支或工作树。
- 本地 Bun `1.3.13`，仓库声明 `>=1.4.3`；最终全仓结论由 hosted exact-SHA CI 给出。
- 双库验证使用 SQLite 与本会话专用真实 PostgreSQL 库；未将 SQLite 结果代替 PostgreSQL。
- Playwright 旅程使用真实 daemon、Case、原生 clarify/review、Git 和浏览器，仅模型协议和代码托管服务使用夹具。
- 实现阶段未运行完整本地 gate。下列集中验证及缺陷修复后的针对性复验分别留痕，数目不重复累计。

## 首轮验证证据（历史快照）

本地日志位于本次会话 `/tmp/rfc396-*.txt`；可复跑测试源码在仓库。日志不是远端 CI 或部署证明。

| 范围                                               | 结果                                                                                                   | 记录                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 架构与装配规则                                     | 230 pass / 0 fail，1001 assertions                                                                     | `rfc396-architecture-repair-1.txt`                                                                                       |
| 既有后端合同、问答/review、数字员工兼容；双库      | 135 pass / 0 fail，8 files                                                                             | `rfc396-compatibility-backend.txt`                                                                                       |
| 既有前端兼容                                       | 21 passed，4 files                                                                                     | `rfc396-compatibility-frontend.txt`                                                                                      |
| 共享合同兼容                                       | 96 pass / 0 fail，7 files                                                                              | `rfc396-compatibility-shared.txt`                                                                                        |
| 提案删除、真实 Git 上传、候选、发布和接口修复集合  | 首轮 44 pass / 6 fail；6 项来自重复 advanced control key                                               | `rfc396-backend-gate-repairs.txt`                                                                                        |
| 注册/HTTP/Case intake 修复复验                     | 11 pass / 0 fail，3 files                                                                              | `rfc396-intake-control-repair.txt`                                                                                       |
| 原始报告、候选/人工验收/发布/响应丢失重放；双库    | 16 pass / 0 fail                                                                                       | `rfc396-report-execution-tests.txt`                                                                                      |
| 工作区、证据和报告 UI                              | 8 passed                                                                                               | `rfc396-report-ui-tests.txt`                                                                                             |
| 原生等待态产物和人工回答导入；双库                 | 16 pass / 0 fail，44 assertions                                                                        | `rfc396-human-import-repair-2.txt`                                                                                       |
| 默认运行时配置与取消后立即重试竞争；含双库         | 9 pass / 0 fail                                                                                        | `rfc396-runtime-repair.txt`                                                                                              |
| 审核材料相对路径、恢复、上传；双库 × 单机/托管端口 | 4 pass / 0 fail，40 assertions                                                                         | `rfc396-relative-material-repair.txt`                                                                                    |
| 审核回执脚本使用生产 Node ESM 启动规则             | 1 pass / 0 fail                                                                                        | `rfc396-native-review-script-2.txt`                                                                                      |
| 审核证据重复消费与并发导入；双库                   | 16 pass / 0 fail，66 assertions                                                                        | `rfc396-review-replay-repair.txt`                                                                                        |
| 真实结构证据落库后崩溃恢复；双库                   | 2 pass / 0 fail，16 filtered                                                                           | `rfc396-verification-recovery-repair.txt`                                                                                |
| 类型、本次文件 lint 与构建                         | 前端类型、受影响文件 lint 和最新单二进制构建通过；后端最新检查有 16 条并发 WIP 诊断，本 RFC 路径无诊断 | `rfc396-frontend-type-report.txt`、`rfc396-backend-type-runtime.txt`、`rfc396-lint-replay.txt`、`rfc396-build-final.txt` |
| 独立功能实现门                                     | 首轮 5 P2 关闭；后续原生链路、运行时和证据恢复修复限定复核均通过                                       | [实现门记录](./implementation-gate.md)                                                                                   |
| 三条确定性浏览器旅程                               | 预约 1 passed（34.8s）；通知与已有模块 2 passed（48.8s），分别运行并保留结果                           | `rfc396-e2e-16.txt`、`rfc396-e2e-final-remaining.txt`；源码 `e2e/rfc396-graph-development.spec.ts`                       |
| 三条真实模型完整旅程                               | 未完成；预约已到原生人工澄清门                                                                         | 下节                                                                                                                     |
| 实现提交、hosted exact-SHA CI                      | `5f11d185754398c8d2aaa9307866a6b8643428ff` 已推送；首轮 CI 红，见下节                                  | [CI 39721967331](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967331)                                 |

三个浏览器旅程覆盖原生人工回答、动态视图变化、短调用取消/重试、固定视图、320/390px 布局、冻结依据预览/导出、独立审核、代码候选、原始证据查看/下载、人工验收和终态后的后续工作。它们使用模型协议夹具，不能替代 AC17 的真实模型质量与完整旅程。最终构建包含后续证据恢复修复；该恢复分支另有双库针对性回归。

## 集中验收发现与修复

保留真实失败，不以重复运行碰绿：

1. 原生 Workflow 的模板变量不能使用 `design-model`；边的目标端口改用 `design_model`，输出端口保持业务合同名。
2. 平台 work item 曾重复包裹执行合同 envelope，修为业务原始 `{summary,result}`，由既有合同 owner 包裹一次。
3. 等待人工门时终态 Task 查询不返回已完成节点输出，改由 TaskExecution owner 查询已提交且 active 的 done node outputs。
4. 导入去重原来只看模型输出，模型不改设计时会跳过后续人工回答；导入标识现包含 Collaboration 的权威回答。保留未知责任与暂定判断，重复消费不产生新版本。
5. 浏览器夹具补齐现有澄清 API 的 `questionSetKey` 与每项 `confirmedBasis`；没有放宽产品校验。
6. 命令行第一次回答导入复验误用 PostgreSQL 环境变量，记录为 `8 pass / 1 fail`；改用既有 `AW_TEST_POSTGRESQL_URL` 后双库 `16 pass / 0 fail`。
7. 短调用原来使用 `resolveRuntimeByName(undefined)`，绕过已登记运行时，导致第 12 次本地夹具复验错误启动系统默认真实 `opencode`。按测试目录确认并停止该调用；现改为每次读取默认运行时并经 `resolveAgentRuntime` 选择登记的 binary/model。该失败运行不计为确定性夹具通过，也不计为真实模型验收。
8. 已取消调用的延迟清理可能删除立即重试的新控制器；清理现核对控制器身份，双库覆盖旧清理之后新调用仍可取消。
9. 审核材料合同原来带 Case 工作区绝对路径，进入 Workflow 节点隔离目录后不可读；材料目录和审核文档改为平台材料相对路径，单机/托管、双库真实文件读取与恢复回归通过。
10. 审核回执脚本原用 CommonJS require，而生产 Node 脚本执行器使用 ESM；修为 import，并用实际 INTERPRETER_SPEC 的扩展名与 argv 运行回归，不再使用会掩盖差异的 node -e。

`rfc396-backend-type-import.txt` 的后端类型检查未通过：诊断仅位于并发会话在制的 `iso-single-nonroot-member-replay.test.ts` 和 `single-nonroot-member-workspace.test.ts`（未定义 `db`、不匹配的测试 fixture 字段等）。本 RFC 没有修改或移除这些内容。该结果不记为全仓类型通过，后续 exact-SHA CI 仍须归因。后续 `rfc396-backend-type-runtime.txt` 有 16 条诊断，均位于并发 workspace/rollback 演进的测试及消费方，本 RFC 发布路径没有类型诊断。未代改、撤掉或提交这些在制文件。

11. 原生进度和终态消费重复保存相同审核证据时，真实 artifact owner 会分配不同引用，导致 identity conflict；现在复用首次保存的绑定，并检验并发落库的证据内容一致。结构证据的半完成恢复采用相同原则，保留原始产物而不重新生成冲突链接。

其余独立审查修复见实现门表，不隐藏初次失败记录。

## 首轮真实模型验收边界（历史快照）

使用 `opencode-go/deepseek-v4.1-flash` 与专用虚构预约需求、测试仓库。当前 Case `01M5GTZ28ESS39E82ET3CK0TKZ`，Task `01M5GTZ3AVPRH3T9306DCMXRM7`，原生澄清节点 `01M5GVC6NP67VH6CR6049YVFMP`。模型完成初始设计并提出优先级、并发表达和验证证据问题；这仅证明到达原生澄清门，尚不证明完整澄清→实现→验证→交付。

继续真实模型验收时，自动审批要求用户明确许可将这些验收材料发送到该外部模型服务。当时在当前会话请求许可并暂停新增真实模型调用；用户随后明确回复“1.这个不阻塞你 2.允许”，许可条件已解除，继续记录见 real-model-acceptance.md。这是当前验收执行限制，不是产品能力结论。异步通知与已有模块两条真实模型旅程尚未完成。

## 首轮 AC 证据归属（历史快照）

| 验收点           | 主要证据                                                                          | 尚缺的最终确认                       |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| AC01、08、13、18 | 注册/intake/消费、原生 review、兼容与恢复测试、三个完整确定性浏览器旅程           | exact-SHA CI                         |
| AC02～07、12、15 | graph-domain、graph-planning、design-application、工作区 UI、原型与三个浏览器旅程 | 完整真实模型旅程                     |
| AC09～11         | implementation basis、真实 candidate/profile、有限行为执行、人工验收              | 真实模型实现结果与完整验收           |
| AC14             | 双库迁移/存储/应用测试，单机与托管执行端口 fixture                                | 实际部署旅程的证据边界需逐项收齐     |
| AC16             | 原始证据导出、真实 Git 发布与冲突/重放、浏览器完整交付                            | exact-SHA CI；未声称远端业务生产部署 |
| AC17             | 预约模型已到原生澄清门                                                            | 三个完整真实模型旅程                 |

未声称生产部署、远端业务仓库发布、长期认知效果或通用设计最优。所有未完成项关闭且 CI 结论明确之后才更新 RFC 最终状态。

## 首轮发布与 CI 修复（2026-10-21 本地 / 2026-10-22 UTC）

实现提交 `5f11d185754398c8d2aaa9307866a6b8643428ff` 已提交远端，142 个确切路径。发布后与远端同步；随后共享 main 正常包含 `ab9dcc36e` 与 `93332d3ea`。这些后继提交没有替代本 RFC 的 exact-SHA CI。

- 主 CI [39721967331](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967331)：48 个工作 job 中 27 成功、21 失败；汇总 `CI required` 在取证时排队，不能宣称整体通过。全部 Linux/macOS 浏览器分片通过，Windows shard 3/4 的三个新增图旅程失败，其余 Windows 分片通过。
- [windows-platform 39721967315](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967315)：验证命令工厂新增第二个消费者后，旧单消费者结构断言失败。
- [visual-regression-nightly 39721967294](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967294)：58 通过，数字人类型目录 1 张基线变化。
- [git-protocols-e2e 39721967433](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967433)、[integration-opencode 39721967290](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967290)、[maintenance-soak-nightly 39721967287](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967287) 成功。

| 首轮失败归因                                                         | 本轮处理与保留的断言                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 审核先解析坏快照盖过终态错误；新返回决定入口抛原始 JSON 错误         | 先做既有终态检查；与重跑路径共用 `workflow-snapshot-corrupt` 读取器，保留回放、准入及事务原逻辑                                                 |
| PostgreSQL 默认 NULL 排序不同                                        | 权威人工输入查询使用既有 `descNullsLast` 合同                                                                                                   |
| 新增五张内容表/迁移造成旧精确计数及最后一步切片过期                  | 明确 222 源表/216 active、261 迁移；逐一锁定五张图表；RFC-374 前缀定位 `0036_rfc374_node_run_seq`，继续证明真实历史升级                         |
| 新类型、图弹窗和第二个验证命令消费者未登记                           | 两种类型各初始化一次；原重复装配负面对照仍各两次；登记七个实际 Dialog 实例与确切工厂转发点                                                      |
| 22 个图 HTTP 路由未登记、两种错误缺少 HTTP 断言                      | 完整端点登记；真实应用中验证 404/422 错误码（422 断言纠正见下文）；MCP 逐叶登记当前 Case/UI 范围，未凭空声称新增外部模型工具                                          |
| 公开类型直接派生整套装配；领域文件包含跨域适配/资源模板              | 明确 SourceControl DTO/参与者；HTTP 挂载不进入公共 DTO；类型注册/codec/内置资源移入 application，HTTP 归 infrastructure，组合根只构造完整参与者 |
| 能力台账、模式清单和 POSIX 夹具跳过项未同步                          | 配套既有机器清单，保留范围解释；不增加宽泛排除，不删除原用例                                                                                    |
| Windows 真实启动报 `ENAMETOOLONG`                                    | 完整图模型/schema 通过既有 `seedFiles` 物化到 invocation 工作区；命令行仅含材料路径，不截断材料；夹具读取同一文件                               |
| Windows 图旅程保存固定视图未完成即发起下一步，出现 revision conflict | 等待保存后的 `Unpin` 按钮可用，再提交绑定新 revision 的请求，不重试绕过版本检查                                                                 |

手工浏览器走查发现图类型总览仍显示旧研发类型的“工作区未准备”和 MR 承诺，已改为真实说明：目标仓库、冻结依据、候选和交付位于设计工作区。提案和短调用列表显示顺序/时间/用途，操作继续使用稳定 ID。新增总览回归后，本地三个完整旅程同一次执行 **3 passed（1.3m）**，日志 `rfc396-e2e-overview-final.txt`；这是后续 Windows 材料文件修复之前的候选证据。

视觉基线按仓库 README 的人工检查流程更新：Darwin 由精确目录用例生成并再次零差异通过，Linux 取自上述 exact-SHA artifact。已查看 actual/expected/diff，仅接受新增图类型卡片及随之发生的双列布局；已有的运行观测导航来自已提交旧功能，也保留在基线中。没有改变阈值或其他页面基线。日志 `rfc396-visual-darwin-update.txt`、`rfc396-visual-darwin-verify.txt`。

本轮早期修复验证：后端 58/0（5 files，含双库）、迁移针对性 2/0（261 assertions）、工厂接线 4/0、前端向导/弹窗清单 55 passed、总览与工作区 UI 16 passed，后端完整类型检查曾 exit 0。日志分别为 `rfc396-ci-backend-repair.txt`、`rfc396-ci-journal-repair.txt`、`rfc396-ci-verification-wiring.txt`、`rfc396-ci-frontend-repair.txt`、`rfc396-ui-overview-tests.txt`、`rfc396-ci-backend-type-repair.txt`。

随后 RFC-395 在共享树迁移 schema contribution，导致本轮复验出现 `RFC349_DEFER_TABLES` 导出不存在、schema 类型字段暂失、历史迁移接口在修改中的错误。保留 `rfc396-ci-repair-behavior-2.txt`（37 pass / 9 errors）及 `rfc396-ci-repair-contracts-2.txt`（62 pass / 5 fail，其中三项加载错误）原记录；这些不是本 RFC 新发布 SHA 的 CI，也不是可宣称的整套通过。图领域/HTTP 层次、公开面合同、组合根 holder、API 源码登记、skip 清单和能力账本在该轮对应检查通过。SourceControl 新 DTO 的错误导入另行归因并自行修正，未把它归到并发工作。

大请求和实际运行时选择的独立回归已通过，见 `rfc396-design-assist-transport.test.ts`、`rfc396-assist-transport-test.txt`。本次后端确切修复路径 lint 通过；最终修复候选仍须消费新的 hosted exact-SHA CI。共享 schema 清单测试的并发导入与本 RFC 五表断言完整保留，生成的 schema 报告与最终复验待共享依赖形成可运行候选后完成；不临时撤走他人产物制造绿树。


## 第二轮发布与 schema 报告补齐

修复提交 `b8d1f9fcc7f695655cb8112f2d4b103c5c5cdd6a` 已推送；推送后 `main == origin/main`、差异 `0/0`、共享 index 为空。此次仅提交明确的 64 个新旧路径名，未带入 RFC-395 的在制迁移。

该提交的 [主 CI 39725052164](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052164)、[Windows 平台 39725052080](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052080)、[视觉回归 39725052043](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052043) 在本段取证时执行中；[integration-opencode 39725052079](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052079) 成功。尚未宣称本轮整仓通过。

schema contribution 的导出修复后，重新生成 canonical JSON/Markdown。逐表比较确认原有 217 张表的全部合同字段不变，新增恰好为 `development_designs`、`development_design_revisions`、`development_design_proposals`、`development_design_baselines`、`development_design_links`。总数为 222 source / 216 active / 6 archive-only，digest 为 `sha256:3f8b275e388697cc6d9f5005dc3c9cf9acd70fe97c1bb00407223dfcf4d39743`。生成器读取当前共享 contribution，但此次报告不包含其他 schema 语义变化。

HTTP 适配器迁到 `infrastructure/http` 后，错误码覆盖扫描现继续显式包含其确切路径，避免移动文件使原有检查消失。该文件的四项检查全部通过。schema 联合检查首轮为 `10 pass / 2 fail`（`rfc396-schema-final-check.txt`）：本 RFC 五表名称断言遗漏排序，已修正；另一个失败为 RFC-395 新 schema 声明入口被原归档表 consumer 扫描识别，不改动其在制迁移。随后限定计数与生成报告两项复验 `2 pass / 0 fail`、26 assertions，见 `rfc396-schema-final-targeted.txt`。

共享 `tests/architecture/rfc349-schema-contract.test.ts` 同时包含本 RFC 的计数/五表断言与 RFC-395 的新 bootstrap 导入。完整保留这些改动；在其依赖仍未提交时，不单独发布这个共享文件制造缺依赖提交。canonical 报告和路由覆盖修复可独立发布；共享断言的发布及其 CI 仍需后续收齐。未重复运行全量本地 gate。


## Windows 旅程闭环与 HTTP 断言纠正

schema 报告与原路由覆盖扫描已经以 `baf4ac29317b67bc7ef9ebc0c32ffeb450882f9b` 推送；推送后 `main == origin/main`、差异 `0/0`、共享 index 为空。该提交的 [主 CI 39725816019](https://github.com/wangbinquan/agent-workflow/actions/runs/39725816019) 尚在执行。

生产修复候选 `b8d1f9fcc` 的 hosted 结果截至本段取证：

- [Windows 平台 39725052080](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052080)、[视觉回归 39725052043](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052043)（59 passed）及 [integration-opencode 39725052079](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052079) 全部成功。
- 主 CI 的类型/lint/格式/shared/system mock、全部六个前端分片、真实 PostgreSQL、三种 OS 的生产二进制构建、三个 macOS 浏览器分片与四个 Windows 浏览器分片通过。
- [Windows shard 3/4，job 119653946843](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052164/job/119653946843) 为 **138 passed**，明确包含预约 39.8s、通知 1.2m、已有模块 43.5s 三条完整 RFC-396 旅程。该结果验证了材料文件传递及 Pin 保存等待的实际 Windows 路径；仍是确定性 system mock，不能替代 AC17 的真实模型。
- 主 CI 当时为 43 个 job 成功、2 个失败、3 个 Linux 浏览器分片排队；不是整体绿。失败逐项如下。

| 失败 job | 已确认根因 | 处理 |
| --- | --- | --- |
| [119646933434，backend 12/24](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052164/job/119646933434) | 217/211 的旧计数断言及旧 canonical 报告；1131 pass / 2 fail | 报告已由 `baf4ac293` 更新；计数/五表断言在共享文件中完成，仍依赖 RFC-395 未提交导入，保留全部共同产出 |
| [119646933476，backend 16/24](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052164/job/119646933476) | 本 RFC 新增 HTTP 断言误写 400；既有 `ValidationError` 一直定义为 422；1005 pass / 2 fail / 1 skip | 改正断言为 422，继续精确断言 `graph-request-invalid`；不改生产错误合同 |

`baf4ac293` 的 [backend 16/24，job 119649325233](https://github.com/wangbinquan/agent-workflow/actions/runs/39725816019/job/119649325233) 是同一个尚未包含修复的 400/422 断言失败，未认领为其他原因。修复后的完整 HTTP 用例在本地 SQLite 与真实 PostgreSQL 同次复验 **2 pass / 0 fail，42 assertions**，日志 `rfc396-http-status-repair.txt`。复验包含读取、深链、原始证据导出、编辑、版本冲突、独立展示状态、历史版本与冻结依据导出，未缩成只检查状态码。后续 hosted exact-SHA 结果仍需收齐。


## 实现候选 CI 终态与剩余阻塞

实现修复提交 `fe835ab435b86e814ce48aafe9197dd2e08a4181` 的 [主 CI 39729036993](https://github.com/wangbinquan/agent-workflow/actions/runs/39729036993) 已结束：**47 个 job 成功、2 个 job 失败**。失败为 [backend 12/24，119659567973](https://github.com/wangbinquan/agent-workflow/actions/runs/39729036993/job/119659567973) 的一项旧表计数断言，以及据此失败的 `CI required` 汇总门；不是两个独立根因，也不是整体通过。

- [backend 16/24，119659568129](https://github.com/wangbinquan/agent-workflow/actions/runs/39729036993/job/119659568129)：**1007 pass / 0 fail / 1 skip**，包含 SQLite、PostgreSQL 两条完整 RFC-396 HTTP 用例，已证明 422 断言修复。
- 最新提交的类型/lint/格式/shared/system mock、全部前端分片、真实 PostgreSQL、三种 OS 二进制构建及 **Linux 3 + macOS 3 + Windows 4 个浏览器分片全部通过**。
- 同一失败 backend 分片内，canonical JSON/Markdown 与运行时合同一致性、表归属、digest、归档表边界与变异负面对照均通过；唯一失败仍为已提交旧测试的 `Expected length: 217 / Received length: 222`。日志为 `rfc396-ci-http-job-119659567973.txt`，完整 job 状态快照为 `rfc396-ci-final-fe835.json`。
- 前序 `b8d1f9fcc` 的主 CI 终态为 46 success / 3 failure（schema 与 HTTP 两个失败 job，加汇总门），其后真实缺陷和报告问题均已分别处置，未抹去历史失败。

以下是该候选终态时的三个未关闭事项；2026-10-22 用户已解除模型许可条件，并明确共享 schema 不阻止继续工作：

1. **共享 schema 断言发布**：工作区的 `packages/backend/tests/architecture/rfc349-schema-contract.test.ts` 已含 222/216 与精确五表断言；同时含 RFC-395 对未提交 `bootstrap/persistenceSchema.ts` 的新导入及其整组 contribution 依赖。需要依赖形成可发布状态后，再保留全部共同产出发布该文件并消费新 CI。此项仍是整仓 CI 的未关闭失败，用户明确不阻止本任务继续；不撤走、改回或单独提交会缺依赖的共享中间态。
2. **真实模型三场景**：材料发送许可现已获得，三个场景已实际调用配置的模型。首轮语义失败、8 分钟超时，以及实际调用揭示的最终端口取值缺陷均有原始记录；完整旅程与固定组合效果对照仍在执行，见 [真实验收](./real-model-acceptance.md)。
3. **实际托管执行证据**：AC14 要求真实接线和执行，并不要求自动部署业务应用。当前 `rfc396-workspace.test.ts` 真实执行双库、工作区/Git、材料和恢复路径，但 hosted helper 在测试进程内转发到 `executeWorkspaceTaskImageOperation`，不能替代实际托管传输与执行环境证据。因此保留该验收项，不以静态接线或该 fixture 冒签。

本次后续记录提交只更新 RFC 状态和证据，不改变 `fe835ab43` 的生产与测试候选。继续保持 **In Progress**；后继记录提交的 CI 与上述实现候选证据分别看待。


## 2026-10-22 真实调用揭示的结果收取修复

通知案例的 designer 和澄清后的 output 都发布 `agent-result`；原宿主按原始输出行顺序取首个同名端口，错误地重复消费首稿，导致 Task 已 done 而 Case 卡在 running。修复复用已有 `projectExecutionOutcome`，按工作流 output 节点和最新 settled run 取结果，保留 inactive/skipped/缺失端口语义。另将设计导入的 `ValidationError` 归为 semantic 失败回执；真实存储错误仍传播，避免吞掉基础设施问题。冻结材料补充 decision 人工来源、决策表规则引用、预算单位和验收义务规则，不修改已发布内置资源版本，也不放宽领域校验。

完成上述代码和用例后集中复验：同一 5 文件集合在 SQLite 与独立真实 PostgreSQL 分别 **20 pass / 0 fail / 116 assertions**，涵盖最终端口选择、两部署材料/恢复、原生人工来源导入、组合规划，以及既有 agent/workflow 真实子进程执行；相关架构 3 文件 **45 pass / 0 fail / 146 assertions**；backend typecheck、目标文件 ESLint 和格式检查通过。日志为 `rfc396-result-repair-{tests,postgresql,architecture,types,lint}.log`。本地测试使用保留 RFC-395 并发内容的共享工作区；其结果不是新候选 exact-SHA CI 或真实模型恢复验收。

### 大冻结依据提示传输修复（2026-10-22）

真实审核的 322 KB 提示触发 OpenCode 单参数限制。大提示改走已有 SpawnPlan stdin，完整材料不截断，小提示 argv 与直接 buildCommand 的有界校验保持原语义。真实子进程检验 CJK、多行、末尾哨兵，业务与系统装配均检验 stdin 和续跑 session 标识；对应两文件集中验证 **21 pass / 0 fail / 61 assertions**，目标 lint/格式通过。这是传输和装配范围的证据，不替代真实模型审核成功或全仓 CI。


## 2026-10-22 当前功能矩阵与剩余退出条件

| 验收点 | 当前证据与结果 |
| --- | --- |
| AC01、08、13、18 | 注册、原生协作门、执行合同、版本兼容及恢复用例通过；生产源码 67795ed462 的 exact-SHA CI 49/49 success。托管实际原文批准、重复请求身份、续跑和终态完整记录。实际恢复含有限运维配置操作，不宣称默认自动恢复已覆盖全部租约故障。 |
| AC02～07、12 | 领域、组合规划、过期读集、语义与布局分离、差异审阅、固定视图、原始人工来源测试和三条完整真实模型旅程通过；组合与有边界的固定对照见 adaptive-comparison.md。 |
| AC09～11 | 三个真实模型候选及托管候选分别有实际代码/测试、独立 profile 回执、basis/tree/profile/environment 绑定与原始日志；托管 transient unknown 与最终 current 均保留，未执行或读取失败未冒充通过。 |
| AC14 | SQLite/PostgreSQL 的实际回归、单机完整执行，以及托管 PostgreSQL/服务/任务传输/原生 review/profile/交付均有实际证据；本轮关闭，见 hosted-completion-evidence.json。 |
| AC15 | 原三个确定性浏览器旅程覆盖桌面、320/390px、键盘和图/列表定位；托管实际页面完成原始证据读取。后者不替代此前窄屏和交互覆盖。 |
| AC16 | 实际 Case 页面可找到交付 commit 与原始报告；任务工作区普通 API 可读取代码/测试/脚本，clamp.ts blob 与候选 trace 一致。已有配置发布/冲突/重放测试保留；本托管案例 publication=null，没有声称业务远端发布或部署。 |
| AC17 | 三条实际 DeepSeek 完整旅程已交付，分别 24/0、44/0、13/0，原始失败及代理针对虚构案例作出的 provisional 判断保留。托管受控夹具不额外计入真实模型案例数量。 |

当前剩余项是 T15/T16 的共享 main CI 与最终状态收尾。前继 42611df21 的 CI 39848361400 为 47 success / 2 failure，所有功能 job 成功，整体 required 失败；407fb491 的 CI 39858220290 于 22:02:18 UTC completed / failure，同为 47 success / 2 failure：静态检查 job 120101856514 与 CI required 120114469860，所有功能 job success；静态项仅读取状态元数据，未读取 findings 或日志。本次收尾提交仍须消费自身 exact-SHA CI。未因文档收尾重复本地全量门禁、重跑业务测试或改动其他会话代码。功能证据完整不代表共享 CI 总绿，因此此记录仍不将 RFC 标为 Done。
