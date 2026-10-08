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

## 未完成判据

当前系统 owner/独立事实来源尚未实现，不能声称这三处用量已补入正式统计。完成必须包括双 provider 的原来源/ACK/回滚/重试/进程失败/全部 EOF 回归，三启动根绑定、独立与 CS 托管选定实现，再分别真实运行记忆、意图、变更说明、探测、技能融合、动态编排、commit/merge 和当前八个数字员工 Agent。

每个入口都核对原生 part ID、各分类 Token、冻结人民币估值、任务与 Agent 汇总及正式页面。以前失败及已记录漏量保留；不能把费用验证配置当默认供应商配置，也不能把成功启动、数据页 ready 或某一个 CI job 通过当整体验收完成。
