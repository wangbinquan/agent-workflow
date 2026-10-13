## 2026-10-13 后续候选：MCP、入口和工作区

原 MCP 结算/显式恢复、更多请求与界面入口、runtime 模型库存的隐藏执行，以及融合 FS/Git 的完整工作区 port/local adapter 均已续写。原主干和并发内容保留；累计 123 份 TS/TSX 仅语法及格式/diff 静态自查，所有新增用例仍未执行。完整三根/十九 owner、全阶段 A 和 A-G 开放，不代签 CS 部署或 RFC 完成。详见 [后续源码与剩余工作](mcp-recovery-and-execution-entrypoints.md)。以下是前一候选的历史记录。

# H7：启动激活、维护子 Worker 与执行状态候选

本页记录 2026-10-13 的在制实现，不是 A-G、CI 或 CS 部署回执。完整阶段 A 及用例仍未写齐，遵守先全部开发和用例编写、再集中功能验证的规则。

SQLite 与 PostgreSQL daemon 已在真实 composition 中选择十九个 owner；嵌入式 HTTP 已增加独立宿主入口，使用同一 Task module、persistence、driver lifecycle 及冷 MCP。嵌入式入口只拥有其原请求式执行，以及明确传入的 webhook/report；没有伪造 daemon 定时器、PID 证明或全局孤儿恢复。daemon 分支复用原四步 boot recovery 和原按序 owner 初始化；durable-intent 根要求完整 recovery factory。

全局控制 context 现在分别提供控制存续、执行准入及真实激活通知。只有实际 recovery、写入上下文、authority activation 和全部 owner start ACK 完成，才发布激活信号。轮询循环、Task 自动续跑、MCP、webhook、报告/增量统计、intent、after-commit 和维护服务均消费这一信号。普通 pause 先关闭新准入、使原写入行进入 draining，再沿原取消政策排空和退役；preparation 中 pause 则取消尚未发布的激活。失权仍不能以业务取消、强杀或空 ACK 冒充收据排空。

维护子 Worker 原握手后会立即轮询持久队列，主线程冷构造并不足以挡住已存 pending job。两 daemon 根现明确传入 `dispatchPaused`，Worker 在原资源初始化/握手后保持队列关闭，统一激活时由同一 supervisor 发 activate；普通 wake 不能越过这一边界。native init 帧和原自动启动分支保持。已激活 Worker 的故障重启保留激活状态，暂停/失权关闭重新派发。新增真实 Worker 回归将预存 job 的 pending/attempt=0 保持与实际 activate 后领取、原效果完成、真实 drained 回执分开断言。

嵌入式入口的构造失败现清理已经创建的 identity、Task/MCP 与完整 session；Task 关闭等待原 tickets 与 finalization，借用数据库仍由调用者持有。PostgreSQL webhook source termination 已显式使用本根 Task module 的 runtime registry。

`GET /api/execution/status` 读取根的同一 SO 查询，不访问执行 worker、不领取任务或执行恢复。native 返回明确 native 模式及空的宿主状态，不制造宿主授权回执。所选模式返回实际 phase/generation/readyGroups/reason。响应通过 shared schema；HTTP 和 bound operation 的分组边界同时绑定本根原查询及 SO admission。已受理请求持有真实 SO lease，直到原请求/受理回执 promise 结束；这不能替代 Task/MCP 等业务 owner 的效果、收据或清理 ACK。暂停期间同 grant 的续租只维持原结算，不重新开放派发；新观察的 grant 不得重新激活后台工作。

已登记工作流/Agent/工作组 launch、续跑/节点重试、人工确认/追问/回答、计划立即执行、MCP 新会话/消息/probe、runtime probe、报告、记忆重试，以及首批 mission、数字员工、intent、事件手动派发与备份。operation-descriptor 的 HTTP 投影也转交分组字段，避免只在传统 registerRoute 中生效。资源修改和取消/原收据入口不加新执行门；未盘点的变体及 direct descriptor 调用仍在 A-T7 继续收口。

前端沿实际认证应用根安装分组状态，复用原 query、NoticeBanner、ErrorBanner 及中英文文案；resource-only/部分就绪提示保持原资源表单。任务创建、详情续跑/准备重试、评审决定和 MCP 测试的新启动受状态限制，保存计划、编辑及已有会话读取保留；状态未知时关闭新执行按钮，状态变化不卸载已有资源输入。clarify 的 defer=true 保留原纯 seal 语义，quick 自动继续才获取 Task 请求租约；stop 不借执行门阻断原停止语义。该界面是候选，尚无浏览器验收。

补齐启动期间配置变化的子模块刷新接线：准备中的更新不派发镜像刷新，实际激活后再读取当前配置；启动时 disabled、准备中改为 enabled 的情况不会永久丢失通知。等待激活的观察者也归原 ticker 的 stop/drain 所有，原 native 分支与周期保持。

新增/扩展用例已编写，尚未执行：

- `rfc370-host-activation-barrier`：真实双 provider 写入行、实际轮询 handle、延迟 start、preparing 中 pause、失败与新 revision、错误 scope。
- 同一真实 SO request lease 对原请求的排空，以及暂停期间新的 authority observation；仍只写入用例，没有执行结果。
- `rfc370-embedded-host-root`：实际 HTTP 工作流耐久保存/重建回读、resource-only 零 claim、实际 Task/MCP 激活与退役、构造失败清理、状态读取及执行请求提前拒绝。
- maintenance 原冷服务、supervisor、消息路由和真实 Worker：握手 ACK 与派发激活分开，真实持久队列和原收据。
- shared 状态合同、HTTP 多 root 查询与 receiver、frontend 提示/输入保留、原完整任务 wizard 与 MCP Dialog 回归。

本轮 67 份 TS/TSX 仅完成语法解析零错误，以及指定文件格式和 diff 自查；未运行 AW 本机 tests/typecheck/build/services/E2E、实现门或新 CI，也未发布或部署。本页不以测试文本、静态检查或 peer 后继提交代签功能。

接下来仍须完成：三根整体/十九 owner 的完整合同与 native 回归用例；全部新执行、人工继续、系统测试及业务适配器请求的分组登记；其余界面入口接线；未确定运行时/结算的恢复；其它阶段 A 待项、A-T7 清单/架构配套、A-G 与精确 SHA CI。随后独立 CS adapters 按 M0 首次实际部署、M1 执行闭环、M2 完整运行、M3 事件/运维、M4 迁移回退的批准策略实施。RFC 仍未完成，AW 尚未部署 CS。

本轮最近 fetch 后 `main` 与 `origin/main` 同为 `2a39095f4c67a6393f0049829bddd1ce4500623e`，差异 0/0，index 空。所有并发源码、观测统计和文档完整保留，没有跨 session 信息。
