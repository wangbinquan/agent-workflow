# RFC-371 计划与设计交付

状态：In Progress；用户已批准完整实施两份 RFC、提交并推送及 CS 本机部署。设计原型、生产实现与实机验收分别记录，不互相替代。

## 1. 本次设计范围

- [x] 读取当前导航、NodeRun/Task 用量与计时、driver 累积规则、RFC-294 架构边界。
- [x] 查阅 Langfuse、LangSmith、Grafana、OpenTelemetry 官方资料。
- [x] 产品全景、统计口径、权限 / 缺失 / 重试 / 并发 / 子任务语义。
- [x] 技术合同、模块归属、可靠摄取、查询、分阶段落地方案。
- [x] 五视图交互原型，复用当前前端原语。
- [x] 浏览器检查和样本对账，记录演示边界。

## 2. 生产实施任务

| 任务  | 内容                                                         | 依赖     | 退出证据                                                  |
| ----- | ------------------------------------------------------------ | -------- | --------------------------------------------------------- |
| P0-T1 | 两个 driver 上游协议固定版本样本、能力矩阵、所有调用入口普查 | RFC 批准 | 逐字段 provenance，delegate / resume / final / crash 样本 |
| P0-T2 | usage/span/identity/coverage 合同与归一规则                  | T1       | 领域与协议 fixture 测试                                   |
| P0-T3 | run-observability context、owner public contracts、架构清单  | T2       | 无跨域私有表读取，required/offered 对账                   |
| P0-T4 | durable ingest、账本 / checkpoint、恢复与历史 legacy 回填    | T3       | SQLite/PG 幂等和故障注入                                  |
| P0-T5 | 任务可见性 port、查询 / 缓存 / 导出统一权限                  | T3       | 撤权与树状聚合负测                                        |
| P1-T1 | 概览 / 任务 / Agent 聚合 API、明确窗口口径                   | P0       | 对账用例与性能预算                                        |
| P1-T2 | 导航 / 总览 / 任务列表 / Agent 页面                          | P1-T1    | URL 筛选、双语、空/错误/部分状态                          |
| P1-T3 | 公共 ExecutionTimeline、尝试详情与 Agent 汇总                | P1-T1    | 六 Agent 八次运行全链路、键盘/窄屏                        |
| P1-T4 | CSV/异步导出、数据质量与新鲜度                               | T2/T3    | 服务端过滤、下载重新鉴权                                  |
| P2-T1 | 模型 / 工具 / runtime 内部 Agent spans                       | P0-T1    | 每个 driver 单独能力证据                                  |
| P2-T2 | 运行时人民币单价/价格版本、模型成本归因、未定价              | P1       | 修订和历史重算对账                                        |
| P2-T3 | 关键路径、执行对比、性能分布                                 | P2-T1    | DAG 正确性、缺依赖降级                                    |
| P2-T4 | 异常提醒、窗口/样本/抑制/恢复规则                            | P1/P2    | 无隐式执行中止，授权通知                                  |
| P3    | SLO / 交付质量 / OTel / 长期报表                             | 独立细化 | 另列可验收合同                                            |

本仓按用户要求直接共享 main 工作，不创建分支或 worktree。每一阶段以小提交交付，Git 操作在短发布临界区内按明确文件清单进行。候选验证不追逐无关 HEAD，不启动重复全仓 gate。最终结论来自 exact-SHA hosted CI。

## 3. 原型验收记录

2026-09-28，在 Codex 内置浏览器对 loopback 静态原型完成检查：

| 范围       | 结果                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- |
| 五个视图   | 总览、任务追踪、Agent 分析、Token 与成本、性能与异常均可切换，统计由同一 fixture 派生。           |
| 任务下钻   | 从任务表进入详情；展开 Backend Engineer，查看失败尝试、重试和模型 / 工具片段；Esc 关闭详情弹窗。  |
| 时间轴     | 六 Agent 的并行执行、人工等待、失败与重试可见；关键路径强调与 2x 横向缩放有效。                   |
| 分层对账   | 6 个 Agent、8 次执行；86,000 + 89,000 + 8,500 + 22,500 = 206,000 Token；Agent 累计占用 2,147s。   |
| 时间对账   | 活动区间并集 1,107s + 排队 15s + 人工等待 120s = 墙钟 1,242s。                                    |
| 跨任务分析 | Backend Engineer 跨任务汇总可下钻到三个任务、四次执行，主任务保留失败 25K 与重试 47K。            |
| 筛选与状态 | 仓库筛选和七天窗口更新任务、用量与覆盖率；缺失 / 部分用量保留 `—` / `≥`，不补零。                 |
| 布局与键盘 | 390px 深色、1440px 浅色无页面级水平溢出；任务入口、详情页签和弹窗可键盘操作。                     |
| CSV 边界   | 单任务导出入口显示导出 1 条合成任务的反馈；浏览器下载事件未返回，文件落盘及内容未做浏览器端验收。 |
| 构建       | 独立 Bun bundle 成功；未修改依赖与锁文件，未启动真实任务或生产服务，未运行全仓门禁。              |

截图保存在本次会话的 visualization 目录，并随设计交付展示。未接入真实采集；本原型不证明生产性能、后台权限、通知投递、复杂树形虚拟化或 hosted CI 已通过。完整实施仍按第 2 节分阶段验收。

## 4. AW运行时人民币配置补充（2026-09-28）

用户追问AW如何配置，沿用此前人民币要求补全设计与原型。新增设置→运行时→Token成本入口及成本页快捷入口，按runtime注册项/provider/model区分；独立价格保存不调用现有runtime编辑和模型测试。源码仅改RFC原型，生产RuntimeList/route/后端不变。

- 所有总览、任务、Agent、片段、模型与价格版本金额改人民币；六Agent主任务仍206,000 Token，按新人民币示例单价估算¥1.030125；24小时已知估算¥1.717100。新价不代表真实厂商报价。
- 独立静态bundle构建通过。真实浏览器从成本入口打开价目表，末行opencode-review打开嵌套Dialog；负数单价与过去生效时间明确拒绝，Esc只关闭内层并回到“配置单价”，重新打开保留1.2草稿。
- 保存CNY-v2、2026-09-29 10:00生效，价目表显示待生效版本并保留历史；当前观测费用沿用CNY-v1。刷新恢复示例版本是原型边界。
- 价目表费用合并为四项摘要，避免桌面把运行时列挤出；390px表单宽366、x=12，内容/页脚处于视口内，body宽390/390无横向溢出；恢复正常视口，浏览器warning/error为0。
- 截图：`~/.codex/visualizations/2026/09/28/01a0e5cc-0ad5-74e0-b68d-e46d7f19754d/aw-cny-runtime-pricing.png`。

上述原型验收阶段未运行全仓测试/门禁，也未提交推送、切换真实身份、运行模型或修改CrewStation/RFC370并行实现。CS托管费用回传目前只是设计合同，不宣称已存在。

## 5. 设计发布范围（2026-09-28）

用户已要求将 AW 与 CrewStation 两份设计提交上库。本 RFC 发布范围为三件套、可重建的独立 Demo 源码及 RFC 索引/状态记录，包含人民币显示与运行时 Token 单价配置。生成 bundle 不纳入版本控制；生产采集、计费、路由和配置保持未实施，RFC 继续 Draft。发布验证以本次提交的 GitHub Actions 终态为准，不能把设计发布视为生产功能验收。

## 6. 实施批次 1：计量基础与人民币价格配置

用户随后批准完整实施、提交远端与 CS 本机部署，RFC 进入 In Progress。独立 AW 与 CS 托管 AW 均为必验路径；下面只记录本批已经实现的部分，不把价格配置视为完整观测能力。

- 新增 run-observability context，四桶 nullable 十进制 Token、pico 元运算与执行区间并集；Runtime Management 提供注册 ID／配置修订的只读公开目录。
- AW 设置→运行时增加 Token 成本，人民币每百万 Token 四桶独立价格；未知单价保留 null，零价显式保存。价格版本按注册 ID／配置修订／协议／provider／实际模型／条件选择，历史不覆盖。价格选择接口供下一批执行受理冻结，尚未接入执行链。
- SQLite／PostgreSQL 共用持久层与价格事务；同注册项串行修订、原键原内容幂等回执、未来生效与分页历史。生成新的双数据库迁移并校验 PG 不可变迁移链；数据库 owner 明确 run-observability。
- UI 保留关闭后的草稿与原请求回执，生效时间已过仍可重放未确认成功的原请求；配置冲突需显式采用新修订，保留用户填写的实际模型与单价。离开设置页使用现有未保存保护。
- 独立功能门最终 PASS：关闭并发保存误报 500、非法时区日期、迁移 owner、自占 PostgreSQL 连接四项问题；UI 功能门 PASS。新增真实双 provider 单连接池回归，执行交给 hosted CI。
- 本地仅对本批文件做格式／lint 和迁移生成检查，没有运行 AW 本地全量门禁、测试或服务；最终验证以发布 SHA 的 GitHub Actions 为准。

下一批为受理价格快照、持久用量账本、source cursor／checkpoint、协议归一与两种部署的数据适配，再接正式统计页与泳道。CS 联动、性能、浏览器与真实运行验收仍未完成。

## 7. 实施批次 2：可重放用量账本与首批 CI 修复

- 新增 source cursor、原始 measurement 事件和当前投影三表；同事务提交回执、投影与水位。按 source / invocation / record / revision 去重，同修订不同内容整页回滚，游标不倒退。
- cumulative 保留恢复基线，未知值不当零；无效终态和未解释下降保留已知贡献并标记质量。迟到修订按原始证据的修订顺序重建，覆盖 invalid-final、null、下降、显式 correction 四组正反到达顺序对拍。
- 账本基础独立功能复审最终 PASS；协议采集、受理冻结、任务汇总、CS 数据读取、正式观测界面仍待接入，本批不宣告端到端完成。
- a9fa45ed 首轮 hosted CI 暴露价格测试类型、目录 fixture 未播种、路由/弹窗登记、数据库表与迁移计数、schema artifacts、设置卡片数和装配摘要遗漏；本批按实际新增合同更新，内部价格接口移至 ports，未添加无消费者 public 债。继承的 RFC370 ZIP fixture 补齐既有 encoding:base64 合同，未改其并行实现。
- SQLite / PostgreSQL 账本迁移与 RFC349 schema artifacts 已生成。未在本地运行 AW 测试；本批功能回归及整体状态须由提交后的 exact-SHA CI 验证。

## 8. 实施批次 3：协议计量覆盖与第二轮 CI 修复

- OpenCode 固定 step_finish/part.id，Claude 按 message.id 去重并保留实际模型；不把 assistant 输出占位值计为最终输出，不读厂商美元估值。
- 原生会话的完整祖先路径由执行 owner 提供。汇总按模型、四个 Token 类别和原生轮次水位判断覆盖，缺中间 Agent 记录仍可去重；旧汇总不会覆盖后续轮次，部分模型恢复基线不阻挡其他模型明细。部分交叠不能确定差值时保留已知量并标记部分。
- 水位随账本 JSON 原子持久化；null 类别保留未知，不能提升该类别的覆盖水位，也不能伪装成测得零值。新增以上反例回归，执行仍交 hosted CI。
- 78e3e9cca 精确 CI 36392089671 已结束：39 success、5 failure、2 cancelled。功能失败对应两类架构守卫：单步哈希未复用公共函数、尚未接入执行源的模块缺临时 public 空面登记；本批修复。Static scans 作业失败，本任务未读取或分析其安全检查日志；整体 CI 不记通过。
- 本批仍是协议归一基础，尚未接入真实调用源。两种部署均为完整实施必验路径，未以协议领域测试代替端到端验收。

## 9. 实施批次 4：冻结运行时观测身份

- RM 在一次选择读取中给出注册 ID 与配置修订；Task Execution 与既有 runtime_params_json 同事务保存 __observation，执行参数白名单不携带该元数据。
- 普通派发、恢复、继承、自动提交与合并冲突处理均保持这个身份。档位编辑/删除不会重写已接受执行的归因；未注册 fallback 与旧快照保持身份未知，不借用当前同名注册项。
- 新增双 provider 真实冻结、事务回滚、删除后继承与旧快照回归；内部两类任务的字面量转交用 AST 锁防漏。独立静态功能复审 PASS，AW 本地未运行测试。
- 这一步只固定执行使用的注册身份；受理时刻、实际模型证据、价格快照、source 摄取、正式查询/界面与两种部署实机验收仍未完成。

- CI 暴露的协议旁路已改为 RuntimeDriver 可选 normalizeUsage 能力：解析位于各驱动目录，中立校验复用共享计量 schema；未知 driver 保留 unsupported，不退回其他协议。同步 scheduler AST 用例清单与临时空 public 面的历史账本计数。

## 10. 实施批次 5：受理价目表与执行 authority

- observation_invocations 保留不可变受理时间、Agent 归因、独立/托管执行 authority；本地冻结价目表 head，CS 按 project/executionResource/generation 固定唯一调用映射。
- 本地估值按冻结注册身份、配置修订、实际 provider/model/条件、生效边界和已接受 head 共同选择；空目录 revision=0 保持未定价。CS authority 的本地估值入口只返回平台管理，永不读 AW 价格。平台授权估值导入仍待实现。独立功能复核修正 CS generation=0 合同不一致后 PASS。
- 新增双 provider 回归：并发幂等、重新打开后回执、档位删除、迟到价格/新模型、未知身份、CS 重复映射与代次、零值/部分估算；SQLite 0233 与 PostgreSQL 0009 迁移及 schema artifacts 已生成，未在本地运行 AW 测试。
- ff924c1 精确 CI 36394863489 最终 40 success / 4 failure / 2 cancelled；功能失败为协议归属与空 public 面账本，已由 4ffa5c160 修复。4ffa5c160 的 Lint/Typecheck 作业指出新增冻结用例缺少 deleteRuntime refs 参数，本批补齐并播种非删除档位；PG 事务内修订对拍改读同一事务句柄，保留修订 +1 与整笔回滚双向断言。Static scans 不在本任务检查范围，整体 CI 未记通过。
- 受理与估值基础尚未接入生产 runner、CS 同步或正式查询/页面；这一步不记真实调用采集或双部署验收完成。

## 11. 实施批次 6：生产启动前受理接线

- 通过正式 public participant 接通 TaskExecution 与 run-observability，删除临时空 public 面登记。三个 standalone 启动根与双数据库 fixture 显式装配，BoundRunTaskOptions 和 runner 依赖必填，不静默丢观测。
- 六个 runNode 调用点传递冻结注册身份；每次进程调用生成独立 invocationId，在实际 spawn 前等待持久接受。自动提交、合并处理归 system，普通任务保持 task。
- 新增双 provider 真实 mock 进程回归：相同 NodeRun 的不同进程有不同调用 ID、受理失败不启动子进程、注入 CS participant 保留平台 authority。AST 断言覆盖六个调用点和三个本地 bootstrap；这条 CS 测试不等于集群托管验收。
- 上批 389ccb5c0 已推送，exact-SHA CI 36399799590 仍在运行；本批未执行 AW 本地测试，独立静态功能复核 PASS。用量源写入、平台同步、正式查询/页面和部署验收仍待完成。


## 12. 实施批次 7：无效初值与受理接线回归

- 独立复核发现首条 invalid-final 或基线超限证据可能成为后续缺失桶的继承来源，导致未知被记为零或错误已知量。首次诊断现仅保留身份，四桶可复用量均为 null；已有合法量仍保留。对应 CS 反例先红后绿，AW 增加同类领域回归及 SQLite/PostgreSQL 重开 store、倒序交付对拍，独立静态功能复核 PASS。
- 05b6b8dac 的 hosted CI 指出 RunTaskOptions 子任务继承清单漏了必填 observationInvocations、commit/merge 旧源码锁的 2,000 字符窗口截断了仍存在的 signal，以及 RFC-294 设计 DAG 未同步公开参与者依赖。分别登记为 dropped-registered（bootstrap 重新注入）、按完整 AST 调用检查信号和补齐 TE → RO，未缩小原功能断言。
- 本地仅执行本批文件格式与 lint、canonical artifacts 生成；未运行 AW 测试或服务。上一批 CI 尚未整体通过，Static scans 不在本任务检查范围，未读取其日志。真实用量摄取、CS 同步、正式查询/页面和双部署验收继续实施。


### 批次 7 的 canonical provenance 补正

6aeb271f6 的 hosted CI 中，Lint/Typecheck 与已结束的架构 exact-projection 断言通过；macOS 6/6 分片指出四份治理产物沿用了生成前的 contentDigest。现仅按现有 withArtifactProvenance 重新生成四份内容摘要，并将对照祖先设为 6aeb271f6。后续 canonical 生成必须同时传 `--write --snapshot-sha HEAD`，不能只更新投影而保留旧摘要。没有修改业务代码或放宽测试，AW 本地仍未运行测试。


## 14. CI 配置登记补正（2026-09-28）

- 包含 ca21efbc 的后继提交 15b66b6d 的 CI 36404992960 已取消，42 项 success，三组后端测试未完成，整体不能视为通过。读取功能作业日志发现两项本 RFC 引入的明确失败：PG 活跃表断言仍为 186（实际新增六表后为 192），三个人民币价格配置路由未进入 MCP 逐叶登记。
- 本批更新严格的 192 表数量断言并逐名锁定六张 observation 表；价目表路由沿用运行时配置入口的登记方式，明确只限三条精确路径。MCP 叶子基线 392→395，按 RFC-371 写明增长理由并刷新内容摘要；未新增宽泛前缀、未放宽测试。
- 取消作业还停留在并行 RFC370 的 skill creation 测试及其他后端分片；本批不覆盖或回退这些并行改动，也不将未终态用例当作成功。没有运行 AW 本地测试或服务，需本批发布后的精确 SHA CI 重新验证。

本批独立只读功能门 PASS；精确路由规范化、六张新增表与叶子增量均已核对。定向格式与 lint 通过，未运行本地测试。

### CI 证据引用补正

93f360dec 的 CI 36408910757 中，macOS 3/6 功能分片报两项登记错误：RFC349 功能证据索引的用例名仍含 186，已发布 9a591ff3a 的 Ubuntu 16 分片配置仍被严格的旧 12 分片断言拦截。本批同步为现有 192 表用例和 16 分片，未删除任何断言，未运行 AW 本地测试。完整 CI 尚未终态，不把其他已成功作业当作全绿。


## 15. 实施批次 8：根进程数字源与可恢复投影

- 上批 8a509ffbc1ddd7693e7e788d3dd84653a9d982ec 的精确 CI 36411046837 终态 success，50 项全部通过；这是此前批次的证据，不代替本批运行验证。
- 新增 TaskExecution-owned numeric outbox，与 stdout 原始事件共享 owner fence、nodeRun 行锁和事务；既有 raw event 表不改列。SQLite 0234、PostgreSQL 0010 与 schema 合同已生成，193 active / 6 archive-only。
- 生产根 stdout 经 driver 归一后保存 immutable invocation/sequence/time 证据。账本/cursor 同事务，源确认随后执行；确认丢失、重复页、多个消费者及重启可收敛。投影错误保持源 pending，进程结果不受影响；stdout pump 不等待统计投影，provider 生命周期管理后台恢复。
- 独立复核发现空 resume ID 被误判为恢复，已让 capture 消费实际有效 resume ID，并覆盖 fresh 空字符串。复核也发现定时退避可能轮流饿死健康节点；已改按节点标识公平轮转，新增五个坏节点各 100 行、健康节点连续两轮可推进的反例。最终独立功能门 PASS。
- 新增双 provider 原子回滚、源提交后重开、ledger commit 后 ack 丢失、并发、身份不匹配、CS 排除与真实 mock runner 回归；AW 本地未运行测试/服务，执行交给本批 exact-SHA hosted CI。
- 实际 provider/model 后补、原生子会话、CS 平台 usage/valuation 同步、正式观测页、双部署及 CS 本机部署验收仍未完成。本批不把 unknown 模型归因伪装成已定价，不把 CS 被排除于本地采集当作 hosted 路径完成。


## 16. 持久来源 CI 回归修复（2026-09-28）

- `74b00a256` 的 CI `36414771134` 捕获：来源表缺少归档、identity 列清单与 1 秒后台 cadence 清单未登记、装配图摘要未更新，以及接线断言错误依赖格式化后的文本。
- 数值来源现在通过现有任务归档管线导出到独立 JSONL，pending/consumed 状态与原始 evidenceJson 保留；双 provider 用例通过生产归档参与者验证整树导出与删库后证据可读。
- 保留精确表/周期清单与整图摘要约束；bootstrap 源参与者改用 AST 调用名、参数个数和数据库身份逐项验证，避免空白换行影响判据。
- 该批不替代整套 RFC 验收；按仓库规定未运行本地 AW 测试或服务。

- 后续 `8b1461ae3` / CI `36417065267` 类型检查指出二维数组推断出的 `database` 可能 undefined；固定三条二元组为 const，保留全部 AST 约束并移除 path 的非空断言。定向 lint/format 与独立功能复核 PASS，测试交后续精确 SHA CI。
