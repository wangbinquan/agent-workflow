# RFC-396 实现候选验收记录

日期：2026-10-21。状态：实现候选已发布，首轮 exact-SHA CI 失败已归因并修复中；真实模型及实际部署验收未闭环。用户批准完整实现与远端交付；此记录分别说明已证实内容和尚未证实内容，不以单个通过结果宣称 RFC Done。

## 候选与环境

- 在现有主 checkout 的 `main` 开发，保留并发 RFC-395 和任务执行修复；未创建开发分支或工作树。
- 本地 Bun `1.3.13`，仓库声明 `>=1.4.3`；最终全仓结论由 hosted exact-SHA CI 给出。
- 双库验证使用 SQLite 与本会话专用真实 PostgreSQL 库；未将 SQLite 结果代替 PostgreSQL。
- Playwright 旅程使用真实 daemon、Case、原生 clarify/review、Git 和浏览器，仅模型协议和代码托管服务使用夹具。
- 实现阶段未运行完整本地 gate。下列集中验证及缺陷修复后的针对性复验分别留痕，数目不重复累计。

## 当前验证证据

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

## 真实模型验收边界

使用 `opencode-go/deepseek-v4.1-flash` 与专用虚构预约需求、测试仓库。当前 Case `01M5GTZ28ESS39E82ET3CK0TKZ`，Task `01M5GTZ3AVPRH3T9306DCMXRM7`，原生澄清节点 `01M5GVC6NP67VH6CR6049YVFMP`。模型完成初始设计并提出优先级、并发表达和验证证据问题；这仅证明到达原生澄清门，尚不证明完整澄清→实现→验证→交付。

继续真实模型验收时，自动审批要求用户明确许可将这些验收材料发送到该外部模型服务。已在当前会话请求许可，尚未收到批准；因此暂停新增真实模型调用，继续其余不依赖该许可的验证工作。这是当前验收执行限制，不是产品能力结论。异步通知与已有模块两条真实模型旅程尚未完成。

## AC 证据归属

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
| 22 个图 HTTP 路由未登记、两种错误缺少 HTTP 断言                      | 完整端点登记；真实应用中验证 404/400 错误码；MCP 逐叶登记当前 Case/UI 范围，未凭空声称新增外部模型工具                                          |
| 公开类型直接派生整套装配；领域文件包含跨域适配/资源模板              | 明确 SourceControl DTO/参与者；HTTP 挂载不进入公共 DTO；类型注册/codec/内置资源移入 application，HTTP 归 infrastructure，组合根只构造完整参与者 |
| 能力台账、模式清单和 POSIX 夹具跳过项未同步                          | 配套既有机器清单，保留范围解释；不增加宽泛排除，不删除原用例                                                                                    |
| Windows 真实启动报 `ENAMETOOLONG`                                    | 完整图模型/schema 通过既有 `seedFiles` 物化到 invocation 工作区；命令行仅含材料路径，不截断材料；夹具读取同一文件                               |
| Windows 图旅程保存固定视图未完成即发起下一步，出现 revision conflict | 等待保存后的 `Unpin` 按钮可用，再提交绑定新 revision 的请求，不重试绕过版本检查                                                                 |

手工浏览器走查发现图类型总览仍显示旧研发类型的“工作区未准备”和 MR 承诺，已改为真实说明：目标仓库、冻结依据、候选和交付位于设计工作区。提案和短调用列表显示顺序/时间/用途，操作继续使用稳定 ID。新增总览回归后，本地三个完整旅程同一次执行 **3 passed（1.3m）**，日志 `rfc396-e2e-overview-final.txt`；这是后续 Windows 材料文件修复之前的候选证据。

视觉基线按仓库 README 的人工检查流程更新：Darwin 由精确目录用例生成并再次零差异通过，Linux 取自上述 exact-SHA artifact。已查看 actual/expected/diff，仅接受新增图类型卡片及随之发生的双列布局；已有的运行观测导航来自已提交旧功能，也保留在基线中。没有改变阈值或其他页面基线。日志 `rfc396-visual-darwin-update.txt`、`rfc396-visual-darwin-verify.txt`。

本轮早期修复验证：后端 58/0（5 files，含双库）、迁移针对性 2/0（261 assertions）、工厂接线 4/0、前端向导/弹窗清单 55 passed、总览与工作区 UI 16 passed，后端完整类型检查曾 exit 0。日志分别为 `rfc396-ci-backend-repair.txt`、`rfc396-ci-journal-repair.txt`、`rfc396-ci-verification-wiring.txt`、`rfc396-ci-frontend-repair.txt`、`rfc396-ui-overview-tests.txt`、`rfc396-ci-backend-type-repair.txt`。

随后 RFC-395 在共享树迁移 schema contribution，导致本轮复验出现 `RFC349_DEFER_TABLES` 导出不存在、schema 类型字段暂失、历史迁移接口在修改中的错误。保留 `rfc396-ci-repair-behavior-2.txt`（37 pass / 9 errors）及 `rfc396-ci-repair-contracts-2.txt`（62 pass / 5 fail，其中三项加载错误）原记录；这些不是本 RFC 新发布 SHA 的 CI，也不是可宣称的整套通过。图领域/HTTP 层次、公开面合同、组合根 holder、API 源码登记、skip 清单和能力账本在该轮对应检查通过。SourceControl 新 DTO 的错误导入另行归因并自行修正，未把它归到并发工作。

大请求和实际运行时选择的独立回归已通过，见 `rfc396-design-assist-transport.test.ts`、`rfc396-assist-transport-test.txt`。本次后端确切修复路径 lint 通过；最终修复候选仍须消费新的 hosted exact-SHA CI。共享 schema 清单测试的并发导入与本 RFC 五表断言完整保留，生成的 schema 报告与最终复验待共享依赖形成可运行候选后完成；不临时撤走他人产物制造绿树。
