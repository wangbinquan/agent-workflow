# H7：SO 持久写上下文的生命周期控制

本片是已批准 H7 的下一项平台中立接线，配套 [真实根实施图](host-execution-root-assembly.md)。它补齐已有 Task 消费侧所需的 SO 控制时序；不提前宣告三个生产根、十九个 owner、A-G 或 CS 部署通过。独立功能设计门通过后实现，正式运行证据仍取精确 SHA 的 GitHub。

## 实际问题与落位

当前 `system-operations/application/hostExecutionAuthority.ts` 先 preparation、driver activate、runtime start，再打开 execution admission。已有 `HostExecutionWriteContext` 单独提供 prepare／activate／renew／drain／retire；Task adapter 只负责捕获并在原事务消费 receipt。目前没有生产生命周期把这两条链组合起来。

旧 retirement 的顺序是 driver quiesce、runtime／recovery quiesce 与 drain、等待全部 admission 的 complete、driver release。尤其 recovery drain 发生在 admitted ACK 等待之前，不能在 recovery family 的 drain 内退役写上下文。否则 Task 在途结果已经收到、原业务收尾尚未提交时，receipt 会先变 closed。

新增 SO-owned `HostExecutionWriteLifecycle` 闭合视图，五个方法为 prepare、activate、renew、quiesce、retire，入参为同一 `HostExecutionGrantContext`；不返回 DB 或 CS DTO。它是 lifecycle 的一个可选**完整选择**：未提供时，原 native 调用时点与顺序保持；一旦提供，五个方法必须在 claim／subscribe 前全部存在，不补部分默认实现。后续实际 selected 根将此完整选择与其 Task write adapter 一起装配，不能省略控制侧后仍宣称 selected 写入就绪。

SO composition 新增 `composeHostExecutionWriteLifecycle`，消费原 `HostExecutionWriteContext` 和中立 `HostExecutionWriteLeaseFacts`。后者 `forGrant(context)` 返回该实际宿主 grant 的 holder／expiresAt，可以异步；这是宿主 adapter 读取自己实际控制收据的切面。共同层不从 reference 解析 wire 字段，不用 PID／CS_SLOT 推导 holder，也不使用固定时长、无限到期或 `Date.now() + timeout` 猜出远程租约。

composition 捕获原 context、facts、五个原控制 callback 及 receiver，按原 context 对象保存 prepare 进度和 receipt。它不创建第二份 Task 事务、第二条 authority 状态机或自行续租 timer；所有调用仍由原 SO lifecycle 串行队列拥有。

## 明确的 ACK 顺序

| 阶段                | 接线与就绪判据                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 构造／resource-only | 校验完整选择，零 claim、subscribe、write prepare、boot recovery 和 runtime start；query 保持 resource-only 原因                                                                                           |
| 首次 grant          | 同一 context 的 facts ACK → 原 write context prepare ACK → 原 recovery prepare ACK → 原 driver activate ACK且 reference 不变 → 原 write context activate ACK → 原 runtime start ACK → readyGroups／active |
| 显式续租            | 原 driver renew ACK且同一 reference仍 current → 读取实际新 facts ACK → 原 write context renew ACK；任何一步失败关闭新 admission，并退役原 grant                                                           |
| 订阅续租            | 对当前同一 reference 的 granted observation，排入原 lifecycle 队列执行 write renew；不重新 preparation／activate／start，不创建新 grant，不忽略 durable expiry 的更新                                     |
| 替换／失权／关闭    | 原 invalidate 立即关闭新 admission → 原 driver quiesce → write quiesce即原 drain → 原 runtime／recovery quiesce与 drain → 等同一 grant全部 admitted ACK → write retire ACK → 原 driver release ACK        |

control prepare 必须早于 Task 的 boot preparing 消费；control activate 必须早于 runtime start，周期工作才可消费 active receipt。prepare、activate 和 renew 的每个异步 ACK 后仍沿原 context 的 current 判定继续；丢失后不把就绪组打开。为旧 admitted work 写回结果的职责保留，不能用失权代替用户 cancel。

同 reference 的订阅更新只能续已有 prepared／active 写上下文；preparing 期间的 observation 在同一队列中等 preparation，不单独插队。若更新时已 invalidated，则交由原 retirement 排空，不发起写 renew。原 driver 会维护实际到期事实；lease facts 不承担 claim、平台 activate 或自动续租职责。

## 进度、失败与可重试边界

在调用每个实际控制动作前，原 grant 记录 attempted；仅原动作返回 ACK 后记录完成。新增 write quiesce／retire 与既有 driver／runtime／recovery 使用相同的逐项进度模型。一个动作失败不阻止尝试停止其他 owner，但未完成的步骤仍留在原 grant；后续 close／settled 可报告错误，重试只做未 ACK 的步骤。写 retire 失败时绝不先 driver release，旧 grant 也不能从 ownedGrants 删除。

composition 区分“facts 失败且从未调用 prepare”和“原 prepare 已调用但返回拒绝”。前者没有写 receipt，cleanup 可以无写动作；后者可能是提交回执未知，不能把没有 WeakMap receipt 当作无 durable 写入。保存该失败和未结算状态，quiesce／retire 明确失败，阻止下一代执行；不伪造 closed、重复 prepare 或主动重发 boot。这条合同由真实 DB 行和故障 fixture 检验。

已有 durable 行为是 `prepare` 仅接续 closed 的上一行。此次保持这一事实：遇到上一代 active／preparing／draining 行返回未就绪，并保留资源查询与编辑；不增加“到期即等于所有旧执行已结算”的推断。阶段 B 的实际崩溃接管必须由 durable-intent recovery 和真实执行收据对账形成前代结算事实，再由 SO adapter 闭合／接续原写上下文；M1 重启验收前完成，不能用本片 PASS 代签该能力。正常失权／关闭已有 receipt 的闭合路径属于本片，完整跨进程接管不在此片实施范围。

drain 与 retire 幂等由原 context 承担；composition 只保留原 receipt 和已确认进度，不重建 receipt 身份，不改变原业务 consumeNewWork／consumeRecovery／consumeIssuedAck 的 phase、expiry 或事务规则。

## 功能回归与后续接线

保留原 native lifecycle 案例和断言，增加以下真实行为回归：resource-only 零控制调用；完整选择缺方法在效果前拒绝；prepare／activate／start 的实际屏障；同 grant事实与 receiver 捕获；显式和订阅续租延长实际 durable expiry；持有旧 admission ACK 时不 retire／release；quiesce和 retire拒绝后的原步骤重试；held prepare在失权后返回仍闭合原 receipt；prepare拒绝保留未结算；旧 durable未闭合行不被当成新安装；下一 grant在全部原 ACK前不能启动。

双数据库用现真实 provider fixture 和原 `composeHostExecutionWriteContext`，Task 消费继续经已发布的独立 adapter；既有 HumanGate／生命周期／资源恢复的源代码预言和预算保持。原 SO core 全文若因新增选择适配文本预言，以有限逆向还原证明原 native分支，不降低包含条件或删除旧用例。

此片实现门与精确 SHA CI通过后，继续 Task provider完整配对、冷 owner构造、十九个实际 binding、三根及 API／UI接线。所有生产 selected根必须消费本片完整控制选择及同一 SO／Task实例；缺项不得开启执行。A-G通过后仍按 M0首先部署，然后逐步M1～M4。

## 2026-10-11 实施候选

在 `3ed6040c` 主 CI／完整 Windows 总绿的前置门实际消费后，实施上述有限设计。原 SO authority 队列新增可选完整 `writeLifecycle`，构造时捕获五个原 callback 与 receiver；先 write prepare、再原 recovery、driver activate ACK、write activate ACK、原 runtime start，显式与同 reference observation 续租消费实际 facts。退役沿原进度模型，write quiesce 后排空原 owner，等待全部旧 admission ACK，再 write retire／driver release；失败不删旧 grant。异步 factory 保留同一原选择，缺方法在 factory／claim／subscribe／写入效果前拒绝。

独立 SO composition 捕获原 write context、facts 和全部原控制 receiver。facts 失败且从未调用 prepare 可无写动作清理；实际 prepare 已调用却拒绝时保存原错误与未结算状态，即使真实 DB 已提交也不能假造 closed 或允许下一 grant。真实 facts 的 holder 改变不续旧 receipt，失权发生于 facts ACK 后则跳过新控制写入。原 durable context 和 Task adapter／事务代码保持。

新增 W01～W25 双 provider 行为注册与 W26 五份原 SO 源码的有限 UTF-16 inverse：预期 Ubuntu 51／macOS 26／Windows 26，共 103 次 hosted 执行，当前仅是登记人口。所有原 native authority、failure values、binding、H／L／R／boot 用例与预算完整保持；五份原生产源码共 36 个有限片段可逐字还原原完整字节，未弱化旧判据。只做限定格式／lint与纯语法／JSON／字节检查，无本机 AW 执行。独立 SOURCE 实现门、唯一本候选原 scoped census／MATCHING、精确发布、新 SHA 总绿和实际行为分别另验。

本候选仍不闭合三根／十九 owner、完整 H7／A-T7／A-G、跨进程 predecessor 接管、CS adapters、M0～M4 或 RFC；AW 尚未部署 CS。原设计全文、原失败、全部并行输出保持。

## 2026-10-11 SOURCE R1 功能问题与 R2 修复候选

独立 SOURCE R1 正式 FAIL，唯一功能问题 F01 是 authority composition 只在异步 factory 前保存 writeLifecycle 对象，五个函数延迟到 factory ACK 后才捕获；合法可变输入可改变已选回调。根已实际消费 S1～S9、26 项用例分析及全部 52 项 EOF 身份；正式回执为 193752 bytes／SHA256 `2eac00b3422614a5455833946afdf81282892532caa3c30ef793faae523ea2d5`，原冻结 fingerprint `906354df3b6d7ef1020d6b167a7325ec2b57b29d8624f71e309fc295681f77c9`。该 FAIL 与原正文保持，不改写成 PASS。S2～S9 未发现其他功能阻塞。

R2 在 factory.create 前固定五个原函数并绑定原对象 receiver，后续 core 消费同一完整快照。W21 改用可变完整视图，在 factory pending 期间替换五方法、删除 renew 并替换选择指针；之后真实 start／renew／close 断言五个原函数、原 this、实际 expiry 增长及 closed 行。注册名、顺序、默认预算、其余 25 个 callback 和原 native／Task 源码保持；五份原 SO 源码仍由 36 个有限 UTF-16 片段恢复完整原字节。限定格式与 lint 通过，仅纯语法／字节保持检查，不运行本机 AW。R2 SOURCE 复核、唯一原 scoped census／MATCHING、精确发布与新 SHA 总绿及 103 次实际 SO 执行继续分别验收；完整根／H7／A-G／CS 部署／RFC仍开放。
