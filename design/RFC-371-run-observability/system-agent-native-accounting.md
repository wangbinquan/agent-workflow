# RFC-371 系统 Agent 原执行用量接入

真实验收已证明：两个 memory-distiller 作业消耗 23,251 Token，intent-builder 消耗 106,801，runtime smoke 消耗 8,581，原用量账本没有相应调用。本补充属于已批准的 RFC-371 全入口采集范围；这些入口不能用主任务成功替代验收。

## 身份与归属

系统执行保留自己的原始身份：记忆的 job/attempt/round，意图的 session/turn，变更说明的请求，探测的原 probe 操作。一次真实模型进程对应一个 invocation，重试和原生 resume 不合并为一次。执行 Agent、执行目的和实际选定运行时版本在 spawn 前冻结。记忆执行关联原 job.task_id；独立意图和探测保留自己的系统执行，不伪造 Task claim 或把空父任务塞到 Task 引擎。

数字用量仍只进入现有唯一 usage ledger。来源证明与执行生命周期属于 TaskExecution 的系统执行适配器；RuntimeManagement 只解析原始模型事件和完整原生页；RunObservability 做校验、去重、费用和完整报告。三个实际启动根均装配选定实现。CS 托管时由平台执行权参与者提供同一需求合同，不能依据网络状态切换到本地计费。

## 原生采集

为 System 原执行建立独立的持久 source/owner 身份，与 Task claim 严格分开。保留现有 Task 原事务、lease、nodeRun 与失权围栏；不复用过期父任务的执行上下文。系统 owner 在模型启动前持久化调用受理、冻结费率版本和原生 before-spawn 收据，然后读取全部 resume baseline 到实际 EOF。

沿用原分页 Worker 的冻结读事务和逐页 ACK，System 自己的持久 owner 只在原页成功提交后返回 ACK。原根、子会话、step ID、generation、链路、页摘要及实际 EOF 必须可从原始 source 复核。进程 reap/drain 后收集全部实际根并完成 final pass；失败仍保留已提交数字和真实缺口，不生成零值完整证明。不能使用默认限制 128 会话、5,000 step、20,000 part 的旧快照读取器。

全量报告合并 Task 与 System 的原始事实来源。关联任务的系统尝试与调用纳入该任务，独立系统执行通过自己的 ACL 可见；所有列表和来源沿稳定 cursor 读到实际 EOF，分页大小不是统计人口上限。项目、Agent、目的、算力、模型及人民币费用由同一数字账本派生，原生全局 step ID 不得重复计数。缓存读/写、非缓存输入与输出分别保留，reasoning 只在输出中合计一次。

## 费用与页面

费用采用真实选定运行时的 registrationId/configurationRevision 与 spawn 前冻结的 priceBookRevision；没有注册身份或费率时显示已知 Token 与明确未定价状态。不能在执行后从当前默认运行时猜配置或用美元换算替代人民币费率。验收价格继续明确标记，仅作对账，不代表供应商账单。

总览展示包括系统调用的完整原始人口和各分类 Token；任务追踪保留父任务及独立系统执行身份；泳道展示系统尝试的真实起止、排队、澄清和执行时间。完整性提示只描述来源缺口，不遮住已有数字。记忆 job、intent turn 和 probe 的展示名称必须可读，原始 ID 用于追溯。

## 验收发现的续接运行时问题

技能融合首次执行选择 `obs-native-20261007`，但澄清后八次执行选择 boot 时的 `opencode`。当时默认设置仍是验收运行时，不是配置被恢复造成。实际本机 `cli/start.ts` 的 gateContinuationDeps 在 local-sync 分支只保存 boot 的 resolveLaunchRuntimeConfig 投影；长驻人工续接 worker 后来再次创建短命协调器时，已经没有当前配置 reader。

修复保留原配置来源对象为 continuationQueries，并把它交给该 worker。selected 模式继续使用同一个真实 reader，local-sync 模式也在每次原 continuation drive 时读取当前设置；其原方法/receiver、三段配置解析、零值预算与删除配置语义不变。原 Task 意图、准入、失权和 ACK 均不改变。回归同时覆盖同步与异步来源、原 receiver、删除旧预算、真实根绑定；实际融合随后继续同一个澄清任务，不再重复创建任务绕过问题。

## 系统执行接入候选

新增独立的 System group、原始 invocation owner 和来源队列，复用原生采集的十三张证据表结构，并通过新增 0243 迁移建立 System 自己的物理表。原 Task 表、claim、lease、原生证明算法及唯一用量账本保留。来源确认带命名空间，Task 与 System 数字来源即使整数 ID 相同也不会交叉确认。

CLI SQLite、PostgreSQL daemon 和 HTTP SQLite 启动根分别绑定实际选定运行时和原始调用身份。记忆按 job/attempt/round，意图按 session/turn，变更叙述按 task/digest，运行时探测按原 probe，MCP 测试台按 session/turn 接入。MCP 原有续接、spawn 回执、事件 sink 和人工取消流程保持；验收用替身 runFn 不产生虚构模型消耗。

System 与 Task 共用原始完成函数，按 final read、已提交数字投影、history 到实际 EOF、封存、再次投影的顺序执行。文字保留上限不控制数字采集；失败保留已知数字与来源缺口。全量任务事实合并独立系统执行和关联任务下的系统调用；重试保留每次原 invocation，估值绑定启动前冻结的人民币费率版本。

新增双 provider 回归覆盖两根、深度 42 的子会话、超过 128 个会话、422 个原生 step、四类 Token、reasoning 只合入输出一次、原生续接只增量计费、缺字段仍保留全部实际记录、冻结费率，以及 42 个独立 System 作业跨页到实际 EOF。回归由 GitHub CI 执行；测试子进程和真实模型验收分开记载。

四处启动根的变更必须登记逐语句精确 SHA 和原语句，保留原 Task/RFC-370 的完整正文断言、旧映射、continuation `61e0831e` 摘要及原 statement 人口；不得通过归一化、跳过断言或删除并行改动获得通过。

## 未完成判据

系统接入已发布到 `6af844d76d42cdacbbc168e236bf7cf25dfb755d`；hosted CI 与真实模型对账尚未完成，不能声称历史漏量已经补入正式统计。完成必须包括双 provider 的原来源/ACK/回滚/重试/进程失败/全部 EOF 回归、实际启动根绑定，再分别真实运行记忆、意图、变更说明、探测、MCP 测试台、技能融合、动态编排、commit/merge 和当前八个数字员工 Agent。CS 托管选定实现另行验收，不能用独立部署通过替代。

每个入口都核对原生 part ID、各分类 Token、冻结人民币估值、任务与 Agent 汇总及正式页面。以前失败及已记录漏量保留；不能把费用验证配置当默认供应商配置，也不能把成功启动、数据页 ready 或某一个 CI job 通过当整体验收完成。

## 启动与正式 CI 发现的迁移登记遗漏

原提交仅加入 SQLite 0243，未加入 PostgreSQL 的 append-only 历史。实际后端启动及 exact-SHA 维护 CI `37730364510` 均被 schema history head 检查拒绝，原失败保留。随后使用原 `db:rfc349-postgresql-schema --append 0019_rfc371_system_agent_native_usage` 生成两份不可变产物；39 份旧 PostgreSQL 历史与原提交逐字一致，只新增 16 张 System 表。原错误不是模型或任务成功，也不能把静态生成成功记作 CI 通过。

后继同时退役本次已消费的四条实际增长声明；129 个有序账本、所有 why、实际统计分母、原生页与完整人口规则保留，仅按原 provenance 函数更新内容摘要。没有重复源码 census，没有本机 AW tests/typecheck/build/E2E。原库已作只读备份，原后端恢复和真实任务验证继续。

## Windows 原生续接与原开发启动接续

Windows exact-SHA run `37730364448` 的原 957 pass / 2 fail 保留：全量 422 step 与缺输出字段两项通过，System 原生 resume 在 baseline 对账处读取了 Task 证据表；另一个原驱动中立守卫识别出 System 根持久化中的 protocol 常量分支。续接修复让 before/final members、parents 和历史 meter 的 scope 均选择各自的原 Task/System 存储；历史 meter 根据其真实 sourceId 选择，不能根据当前调用猜归属。完整页、原历史唯一记录和 EOF 校验保持。根持久化改为保存并比较原 factory 已选定的 `request.protocol`，不新增驱动分支、守卫豁免或测试白名单。

原双 provider 回归保留全部 422/3 条、深度 42、四桶、价格版本及 120 秒预算；追加原协议与 resume baseline 211 examined / 211 resolved / 0 unresolved 断言。没有本机 AW tests/typecheck/build/E2E，新 hosted CI 与真实入口验收继续。

原库 SQLite 迁移已应用，但此前直接 `bun run --watch src/main.ts start` 的启动复现未带仓库 `bun dev` 固有的 `AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS=35000` 与 `AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY=1`，因此被既存 development@10 摘要差异拒绝。只读核对确认 13 个员工定义依赖该登记；不删除、不追改其原行。恢复采用仓库原开发命令及原草稿层，保持版本登记的不可变约束，不能以本机开发启动通过宣称发布二进制的历史数字员工兼容性已验收。

## Narrative 已选定运行时身份的类型接续

后继 exact-SHA `4efba2f9a4c2ff753d5cf17c193b204d2d084b97` 的 Windows run `37733093248` 中，原平台功能套件 959 pass / 0 fail，原 System 全量 422、resume baseline 211 与缺字段回归通过；随后 typecheck 在 `changeNarrative.ts:407–408` 报 TS2339。实际 runtime owner 已返回 observationIdentity，Narrative 的显式 resolver 结果类型却漏掉了这个可选字段。补回原 System request 合同的选定身份类型，并在原双 provider Narrative 用例追加同一个不可变身份对象透传断言，原 opaque material、正文解析、生命周期和其余断言保持。

这次只是类型与原功能回归的配套修复，不把 959 项部分成功写成总 CI 通过。另一个真实入口发现的 System 完整报告资格查询遗漏继续修复；真实全类型对账、正式页面和 CS 部署仍未完成。原文与共享并行输出完整保留。
