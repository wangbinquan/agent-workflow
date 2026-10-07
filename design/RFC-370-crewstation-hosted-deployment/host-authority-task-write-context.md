# RFC-370 Task 原事务中的宿主执行上下文 D1

本增量细化已批准 H7 的业务事务要求。当前只做设计；Task background 的 selected lifetime 不等于 Task 原业务事务已经接入执行权。仍按阶段 A／A-G → 各层独立 CS adapters → M0 首次部署 → M1～M4 推进，不提前关闭 RFC。

## 原机制与实际缺口

`modules/task-execution/infrastructure/taskOwnershipPersistence.ts` 的 `claimPendingIntent` 复用原 `databaseSessionFor(db).serializable`，检查 pending intent、Task 维护状态和原 owner 转移。`withOwnedTaskWrite` 在原事务中对 Task owner 做条件更新，再把原事务及 `OwnedTaskTx` 交给业务体。

`infrastructure/ownedTaskExecution.ts` 的 write／serializable 两个入口复用同一事务原语；`fenceTaskWrite` 保留显式上下文 → ambient 上下文 → 无主写入的原规则。`application/taskExecutionContext.ts` 已有贯穿 claim／runner 的真实对象身份和 AsyncLocalStorage；不能在新的异步派发中临时改取当前 generation 而冒充原任务的上下文。

`TaskExecutionModule.claim` 先持有原 claim-attach permit，再等待 durable claim，最后 bind／leave。现 SO 的 grant／admission lease 只有原 generation、opaque reference 和停止通知，没有 AW 持久 holder／revision／有效期。查询 `current()` 或另开检查事务都不能完成 H7 要求的原事务消费。

## 各层切面与数据所有权

SO 拥有 AW 数据库中的安装执行事实及其持久化 adapter；Task 继续拥有 intent、owner、epoch、effect journal、状态迁移和业务事务。新增事实用于判断同一安装本次执行是否仍被受理，不替换任何 Task 条件。CS 的 instance／lease DTO 和网络操作仍只进入后续 SO CS adapter。

SO application 新增独立持久执行上下文端口，提供具名的 prepare／activate／renew／retire 及原 grant 配对查询。其本地持久化实现使用现 ProviderNeutralDatabase 和原事务原语，一份实现覆盖两数据库；schema 和迁移沿原安装协议交付。该表每个 AW 数据库只有一个安装执行行，记录本地 holder、generation、revision、阶段及有效期。revision 在 holder／grant 世代切换时推进；renew 仅更新同一持有者的有效期，不能让已失权的旧上下文复活。

对外只给经过原 SO binding 登记的 immutable opaque write receipt。SO 内部解释本地行键和字段，Task 不读取平台 reference 的属性，不用相同字符串猜绑定。native 默认路径继续原单实例／Task owner 语义；显式 hosted 选择必须包含完整持久上下文，缺项拒绝，不能回退到 native。

Task application 新增本模块自己的宿主写上下文端口；claim／runner 捕获原 receipt，heartbeat 更新 Task token 时保留这个 receipt。bootstrap 将它与同一个 SO authority、provider、数据库和 generation 配对，所有实际子装配保持同一实例。原 Task execution context 的兼容字段、返回形状、错误优先级与 AsyncLocalStorage 规则保持。

## 原事务中的具名参与者

SO 在 exact public participants 出口提供一个具名持久执行事实参与者，由原 SO 数据库 binding 实例拥有。它只接受原 Task 已打开的事务、已登记 receipt 和本次操作种类，执行该事实的条件消费；不提供通用事务执行、SQL callback 或 provider client 新出口。Task infrastructure 的独立 adapter 调用该参与者，Task application 不接触 Drizzle／数据库句柄。

在原 claim／新 intent／新 effect 派发事务内，完整运行原 Task 条件与数据库业务体，保持原业务错误的裁决顺序。只有原体成功后，才在同一事务提交前条件消费同一 holder／generation／revision、可执行阶段和当前持久有效期；不提前用宿主资格错误盖过原 intent／owner／维护状态错误。该最终消费须为真实行锁／条件更新，不能用事务外 select；拒绝时包括原体暂存的全部数据库写入一起回滚，不返回 claim 成功，不提交新 intent／effect，不附着 runtime。原体不能发出事务外执行效果，远程派发仍等待原持久事务成功。事务体只等待数据库操作，保留原重入与 SERIALIZABLE 重放规则，不在事务里请求 CS。

完整选择必须区分三种写入：新执行工作、已发出工作的 durable ACK、恢复准备。新工作需要 active receipt；恢复准备需要同 grant 的 preparing receipt，并由 Task 所选 recovery family 授权；已经实际发出的 ACK 继续经过原 Task owner／effect receipt 的精确条件，允许在 draining 收取原结果，不能因此派发新工作。资源编辑和纯读取维持原独立路径。不得给所有 Task 写入套 active 判断而切断失权后的真实收据接收。

分类落在原具名持久化操作中，不能由 HTTP 调用者传任意字符串升级写能力。原普通取消／终止／重试及其回执按实际动作逐条分类；authority-loss 不调用普通批量取消，也不能改写为全量 interrupted。旧 Task owner 条件始终先按原实际语义保持，新的执行事实错误不得把业务冲突伪装成成功。

## 生命周期与原受理工作

SO 收到 loss 后同步关闭新 admission，并停止本 receipt 的新业务事务受理；durable retire 等待实际已经受理的事务与 ACK 水位，再更新准确的持久阶段。原事务已经取得的条件消费和 Task 写入为同一原子，不能被另一事务中的 holder 更新拆开。过期 receipt 在之后的 claim／新派发事务中明确拒绝；旧异步 runner 不能偷用新 grant receipt。

claim → Task recovery → 平台 activate ACK → AW 本地 activate 持久 ACK → 开放 admission／ready groups 的顺序不得调整。renew 更新只能来自原完整 driver 的实际结果；失败／过期先关新派发。close／handoff／新 grant 等待旧事务及已发出工作的真实退场进度。SO 的 AW 行更新与 CS 的远程 lease 不是一个原子；远程效果仍沿 Task intent、稳定 requestKey、所选 grant 和真实 durable receipt 对账。

native 原路径不增加一次新的 PID claim，不提早 release 原 startup lease，也不收缩任何旧 Task 控制面能力。selected 分支新增完整合同和持久参与者后才开放相关 group，暂未接线的入口保持 deferred。原本允许的业务行为由 native 回归全文保持；完整 selected 准入必须在工作区物化及 intent 创建之前另行完成，不能依靠晚到的 claim 拒绝兜底。

## 分批实施与验收

先交付 SO 中立端口、实际持久化／迁移和完整 native 配对；再交付 Task 本模块端口、独立 adapter 及原事务参与；然后把 claim、launch、继续／node／effect 的真实调用者和 receipt／恢复写分类完整接线。每批均在 main 保留并行输出，独立功能门、精确路径上库、hosted exact-SHA CI 分别记录。

回归必须使用两数据库的真实原事务，证明 holder／revision 切换、有效期到达、同名 generation 不同 binding、旧 runner 与新 grant、失败回滚及原 SERIALIZABLE 重放；原 owner CAS／错误／返回形状全文保持。分别覆盖 preparing 恢复、active 新工作、draining 原 ACK、resource-only 零 claim／零 intent／零 effect，及原正常取消。首轮失败和修正证据保留，不修改旧案例／断言／预算来配合新实现。

本片的设计门不能签 Task 整体完成；schema／源码／所有调用者、实际启动根、19 owner、UI、完整 H7/A-G 与 CS M0～M4 均须后续实际验收。本机不跑 AW tests／typecheck／build／service／E2E，格式／lint、静态 AST／字节及不同候选的一次原 scoped census 与 hosted 功能证据分开。

## D2 保留原业务错误优先级

首轮独立设计门有效稳定 FAIL，唯一 P2 `H7-TASK-WRITE-CONTEXT-DESIGN1-F01`：原 intent 非 pending 与宿主 receipt 同时过期时，原先的前置宿主拒绝会遮住 `task-execution-owner-conflict`。首轮设计、完整回执和 root 对 FAIL 的实际绑定均保留，未据此编写生产。

D2 明确以原 Task 事务体裁决全部既有业务错误；原体成功后、COMMIT 之前才最终消费宿主执行事实。原体抛错则原错误原样传播，不调用最终消费；原体成功而最终资格失败则整笔回滚，不开放 Task attach／派发或返回成功。所有 Task 原子统一保持 Task 原行条件／业务体 → SO 最终条件消费的顺序，SO 自己的持久行转换不在同一事务反向等待或更新 Task 行；driver、恢复／drain ACK 在事务外由原生命周期等待。

回归同时过期与原业务冲突、成功原体后过期／holder切换的完整回滚、原错误对象身份、零 attach／零提交效果、嵌套事务复用及原 SERIALIZABLE 重放。入口准入在物化前拒绝的职责仍保持，并先保留原输入／业务校验顺序；它不能代替本节真实原事务的最终条件消费。
