# RFC-370 Task 原 receipt 传递与具名原事务消费 C1

本增量细化已批准 H7 与 Task write-context D2。SO 持久参与者的有限 SOURCE18-R2 已通过独立复核，实际 Task 调用者接线仍开放。本片先定义 Task 自有的原 receipt 传递及具名事务消费机制，后续 C2 按业务操作接全部调用者。没有 CS 生产 adapter；不关闭 H7、A-G 或部署。

## 实际起点

`application/taskExecutionContext.ts` 已有可信对象、冻结输出及 AsyncLocalStorage。其原 intentId、token、persistence、legacyConnection、compatibility 和 brand 均保留；不能因加入宿主能力而破坏原兼容对象形状。

`TaskExecutionModule.claim`／`ProviderTaskExecutionModule.claimPersisted` 在真实 claim await 前进入原 claim-attach permit，在 durable 返回后 bind，并在失败时 leave。`attachTaskDriver` 还会先等待前任释放，再 claim、attach、创建 execution context。原 heartbeat 返回新的 immutable token 快照；receipt 应属于最初受理的 Task 执行，不能随 heartbeat 或后续异步调用重新取当前 grant。

Task adapter 已将 SO 的原 opaque receipt 和原数据库事务配对到 Task 自有端口，保留原方法与 receiver。`withTaskExecutionWrite`／`withTaskExecutionSerializable` 与 `withOwnedTaskWrite` 是原业务事务入口；Task owner 的 CAS、原业务 SQL 和错误优先级继续由它们的调用者决定。

当前静态普查有 58 个相关文件、124 个事务／写入候选点。该数字包含 transaction、fence 和同一操作内的嵌套调用，不是 124 个独立业务操作，也不表示逐项归类已完成。claim／intent／effect、heartbeat／release、node／wrapper、工作区、人工等待／协作、恢复和终态维护必须继续按实际语义区分，不能统一标为已发出回执。

## Task 自有捕获

Task application 新增 `taskHostWriteCapture.ts`。捕获函数接本模块 `TaskHostWriteContext` 与已准备的原 generation／reference，在首次异步工作前调用原 capture，返回本模块的 immutable opaque capture。原 port、receipt 和三个具名方法及 receiver 留在私有映射；业务层不接收 SO DTO、数据库、SQL callback 或 CS 字段。

捕获代表同一份原受理事实，不表示当前仍能派发。后续新工作／恢复由 SO 原事务参与者判断原 current 和持久阶段；已发出回执继续使用同一 capture。方法属性被替换、字符串 generation 相同或另一个 grant 到达，都不能替代原 capture。没有从查询快照、环境变量或当前全局 grant 自动补捕获的分支。

`createTaskExecutionContext` 增加可选的 composition 输入 `hostWriteCapture`，原 token／intent 验证先执行，再绑定合法 capture。capture 通过原 context 对象的私有 WeakMap 传递，返回对象的原字段、冻结状态及兼容形状不增加属性。native 未选择时没有 capture，行为保持。只允许从原可信 context 查询原绑定，不从 Task ID 或复制的对象重建。

## 三个具名的原事务入口

Task infrastructure 新增 `hostExecutionWriteTransaction.ts`，提供新工作、恢复和已发出回执三个具名事务 helper。每个 helper 接已捕获的事实、该 Task adapter 的原 transactionFor 及原业务体；数据库类型和原事务体只在 Task infrastructure 内，application 端口及跨模块 public 合同不暴露 SQL 执行面。

helper 沿原 write／serializable 两种事务原语选择对应档位。原业务体及原 Task owner 条件先完整执行；只有成功时，才把同一原 transaction 包装交给对应的原 consume 方法，等待真实 ACK，再从原事务返回。原业务错误对象、返回值及优先级不变，宿主参与者失败使全部原业务 SQL 回滚。重入沿原事务帧复用同一 handle；SERIALIZABLE 重放仍执行原纯数据库体，不在事务内进行网络、文件或 runtime 效果。

捕获与 transactionFor 必须来自同一完整 Task binding。缺少方法或跨 binding 的事务／receipt 不转为 native。native 的未选择路径调用原事务入口，保留原行为；选择后的调用者不能以缺少 capture 作为默认 native 的理由。

本片不把原通用事务入口默认归类成某一种操作，不改变原 Task 归属选择规则，不提前启用不完整的 selected Task 根。C2 将在实际操作入口捕获，逐项使用上述具名 helper，并完成原业务条件、原 SQL、错误、ACK 与真实资源效果的验收。

## C2 接线要求

claim 的 capture 在原 permit 受理后、首次持久 claim await 前固定；原完整 SQL 成功后消费 new-work，durable COMMIT 后才 bind 原 permit。返回的 claimed 对象保留原形状，由 Task 私有映射关联该捕获；attach／context／heartbeat／release 从原 claimed 或 token 关联取得该 capture，不重新向 SO 查询新 grant。

heartbeat 返回新 token 时显式保留原关联。已受理工作的 heartbeat、结果、终态与 release 使用原回执类别及原 owner／effect 条件；不得借该类别新建 intent、新 node 或新外部请求。恢复只在原 preparation 下消费 recovery，并保留 local-startup 与 durable-intent 区别。HTTP／schedule／event／webhook／child 新工作在 workspace 或 intent 效果前另受理原 named admission。

每一实际写操作必须归入新工作、恢复、已发出回执或资源控制面，并记录具体条件；资源编辑继续可用。原运行中的任务失权后停新派发，保留已经发出工作的实际 ACK；正常 cancel／provider pause 继续原规则。C2 未闭合前，不声称上述操作已全部改造。

## 本片验收和后续边界

- 原 execution context 的字段／brand、验证次序、兼容字段、冻结及 ALS 行为对拍。
- 原 receipt／方法／receiver 跨真实异步等待保持；新 grant 和原方法替换不改变原捕获。
- 双数据库原 write／serializable 的业务体先执行、宿主拒绝整体回滚、原错误对象优先、返回值保持。
- 原嵌套 handle、外层回滚及另一数据库／binding 拒绝；失权后的新工作与恢复拒绝，而原已发出回执可提交。
- native 未选择的原机制保持；selected 缺项不 fallback。只改 Task application／infrastructure 及必要 composition／types，CS DTO 不进入业务合同。

先完成本 C1 功能设计门与有限实现／发布；随后 C2 逐实际调用者接线、原 source inventory 语义闭合、19 owner 与实际 roots，最后完整 A-T7／A-G。所有新功能带回归，正式测试以 hosted exact-SHA CI 为准。本机只做自有格式／lint与纯静态核对；原失败、取消和已成功的未变候选门保留，不随无关 HEAD 前进重跑。
