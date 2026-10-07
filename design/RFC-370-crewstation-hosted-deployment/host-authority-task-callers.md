# RFC-370 Task 实际调用者 C2：先认领链，再收齐具名写操作

本设计沿已批准 H7／write-context D2／C1 实施。C1 只提供原捕获和三具名事务入口，实际 claim／heartbeat／driver／业务写入尚未接线。这里先固定原受理事实贯穿实际认领的机制；完整操作分类和全部调用者仍逐项验收，不把58文件／124事务候选当成124个已完成业务操作。CS DTO、网络、执行租约续约仅留在之后的独立 adapter。

## C2-W1 原认领与原回执关联

Task application 提供本模块的具名新工作受理口，返回原 TaskHostWriteCapture、原停止通知和完成回调。它只表达 Task 受理事实，不带 SO DTO、DB、SQL callback 或 CS 字段。Task composition 的独立 adapter 把 SO exact public admission 的原 generation／reference 交给同一个 Task write-context binding 捕获；capture 使用准备时保留的原 grant current，不从 lease 是否 complete 推导执行权。未选择的 native 原入口完整保留；selected 必须装配完整受理与事务 binding，缺项不 fallback。

TaskExecutionModule.claim 和 ProviderTaskExecutionModule.claimPersisted 仍先进入原 claim-attach permit。进入成功后、首次持久认领 await 前固定原 Task admission／capture；持久操作通过同一 Task infrastructure binding 的 new-work helper 执行原 SERIALIZABLE 体。原 pending-intent、维护 claim、owner 转移、epoch／revision、intent claim 全文先运行，成功后才同原事务消费 host receipt；拒绝整体回滚。COMMIT 后才创建原 token、绑定 permit，返回的 claimed 对象保持 intentId／token／permit 原形状。

若 permit 进入后原 admission 返回 unavailable，必须保留这一原拒绝事实，不等待新 grant、不重新捕获，也不能提前盖掉原 intent／owner 业务冲突。selected 持久认领的拒绝分支复用同一原 SERIALIZABLE SQL 体：原体抛错时仍传播原业务错误；原体成功后无条件抛出已捕获的 unavailable，使全部暂存 SQL 回滚。它不返回 token、不 bind／attach、不创建受理收据，不以 native 分支提交。本路径只有纯数据库体，没有 workspace／runtime 效果；完整 binding 缺失属于装配错误，仍明确拒绝。正常 admission 成功则沿 C1 new-work helper，不改变原业务体。

Task 自有私有映射把受理事实关联到原 claimed／token。失败时只按真实进度释放原 permit 与未形成 durable 工作的 admission；成功后受理事实持续属于该原 Task，不随新的当前 grant 迁移。原 claim 异常优先级、对象及业务条件保持。

DrizzleTaskOwnershipPersistence 的 selected 装配明确持有原 binding；claim 的 capture 是本次原受理输入，不能在 claim await 后读取当前 grant。native 构造和既有持久化端口调用兼容保持。heartbeat、markRecoveryRequired、releaseAfterStop 从原 token 的关联获得旧 capture，在原 owner 条件和原 SQL 成功后于同原事务 consumeIssuedAck。单语句 heartbeat 进入该明确具名原事务，不改变原 CAS／revision／lease／refreshOwnershipToken 结果；新 token 显式继承旧关联，不以身份字符串重建。read 保持纯读。

revokeExact、revokeOldDaemon、releaseRecovered 和外部恢复／控制写不得自动归为 ACK；它们不一定持有原 token。先保留原控制面，在 C2-W2 按 recovery／新控制工作及具体事务条件逐项接入，不借旧 ACK 派发新任务。

## Driver 的真实生命周期

attachTaskDriver 保留原状态／source-termination 判据、review mutation lock、awaitReleasedSettled、claim、tryAttach、permit leave、heartbeat 与原 execution context 兼容字段。创建 execution context 时只从原 claimed／token 关联取 capture；不重新 acquire grant。已有 native 路径仍无 host capture。

若 durable claim 已完成但 loss／pause 使 tryAttach 未成功，selected 分支不能只 complete admission 而遗留活 owner：按原精确 token 和 owner revision 执行具名 markRecoveryRequired ACK，再确认原受理退场；不伪造运行过的 runtime stop proof，不改 Task 为 interrupted，不触发普通 abortAll。原正常取消／provider pause 的机制继续原样。

成功附着的原 admission 在 driver 运行期间保留。releaseTaskDriverAndFinalize 按原顺序处理 unreaped evidence、registry release、停心跳、精确 effect 清算／outcome-unknown 或 owner release、registry settle 和 workspace finalize。只有原持久及实际清理 ACK 都完成，才能 complete 该原 admission；失败保留未结进度交原恢复处理，不把 finally 执行当成成功 ACK。重复 finally 仍依原 token／controller／registry 条件，不替现任完成。

## D2 原 registry 退场后的实际清理重试

首轮设计门有效稳定 FAIL，唯一 P2 C2-W1-DESIGN-R1-F01：原 registry.settle 已删除 token 与 taskIndex，随后 workspace finalize 失败，重复 finally 会在 tokenForTask=null 时提前返回；只写“保留未结进度”不能让同一 admission 收到后来真实 ACK。原22项及授权最小 registry supplemental 的完整 FAIL 和 root 实际消费保持，修正前未写 C2 生产。

selected Task 增加独立的 finalization progress，属于 Task infrastructure 和自己的具名 collection port。它在第一次退出的首个 await／registry.release 之前保存原 token、controller、intent、Task capture、admission 完成回调，以及原 persistence／workspace 方法和 receiver。progress 的身份是这一原受理工作，heartbeat 新 token 只关联同一对象，不按当前 Task id／grant 重新创建。它独立于 registry.entries／taskIndex 存活，记录实际获得的 stopResult 与 effect/owner transfer、registry settle、workspace finalize 的完成阶段；一个阶段只在真实 ACK 后记完成。

原正常 native 退出顺序和错误机制全文保持。selected 首次退出也保留原 registry.release、停心跳、transferOwnerRow、finally registry.settle 顺序，但 progress 在任何失败后均留存。旧 controller 的重复 finally 先查这份准确关联：即使原 registry 已退场，也能继续旧 progress；只有从来没有这一原关联时才沿原 stale/duplicate 返回，不把现任 controller 的工作交给旧调用者。

Task background 的所选 lifetime 同时持有具名 finalization collection：真实重试 pending 阶段，drain 等待这些原工作完成。即使停止新的 Task admission 和 polling，已受理的 finalization ACK 重试继续；它只调用保存的原方法/receiver/参数/capture，不能重新派发或获取新 grant。进度有串行的在途 promise，重复 finally、后台重试和 drain 复用同一次尝试；reject 保持原错误与 pending 状态并允许后来再次尝试，不缓存失败 promise 为永久结果。失败记录可查询，不能以 registry 空或定时器已停作为已清理证明。

已实际完成的阶段不重放。若 effect/owner SQL 的响应未能确认而其持久结果可能已提交，重试须读取原具名持久事实，按原 token 元组/intent/stop或outcome-unknown证据确认同一迁移；精确匹配的已完成状态才算 ACK，否则沿原业务拒绝，不凭当前 owner 猜旧工作已结。workspace 阶段沿原 cleanup/finalize 合同的准确工作区与原效果回执重试；不得因 taskId 相同去清理后来受理的工作区。

同一 Task 的 selected 新 attach 在取得新 admission／claim之前，先等待这一原 finalization progress 完成；这项等待放在原 review mutation lock 之外，避免等待后台同 Task 重试时自锁。native 仍用原 awaitReleasedSettled 行为。这样旧清理失败或仍在途时，不能以 registry 已 settle 提前让新 driver 使用该工作区。没有这一 Task 的 pending progress 时零额外清理；资源编辑/纯读不经此等待。

effect/owner 与 workspace 全部真实完成后，只调用原 admission.complete 一次，然后移除该 progress 和原 controller 的重试关联。失败期间不 complete，也不改用新 receipt。daemon 重启后的恢复仍须 C2-W2 从既有 durable intent/effect/workspace 事实完成 recovery 分类，不能声称复制内存关联便恢复了旧 receipt；本 D2 解决同一原 host lifecycle 内 registry 已退场的具体失败交错。

新增真实双 provider 交错：owner/effect失败且registry已settle后准确重试；owner ACK 成功但 workspace 第一次reject，旧finally重复和后台retry复用原progress，第二次真正ACK前 admission未完成；成功后complete一次/不重复已完成SQL；后台drain等待原工作；旧/现任controller区分；新selected attach在锁外等待而资源读写仍可用。原所有 native退出用例和C1原事务判据保持。上述 queue/collection/Taskbackground 接线与测试属于 C2-W1 必须完成，不能仅写端口后宣布本组通过。

## D3 原 driver 寿命屏障与锁内复核

D2 门有效稳定 FAIL，唯一 P2 是 attach 的真实等待窗口：首次锁外查询尚无 finalization progress，旧 finally 随后才建立 progress；锁内原 awaitReleasedSettled 在 registry.settle 时返回，而旧 workspace ACK 仍在途。root 已实际消费完整 R2 FAIL 后新增本段，原 D1／D2 全文及失败材料保持，尚无 C2 生产。

selected 的独立 collection 不只登记已经开始清理的 progress，也持有每个已附着原 driver 的寿命屏障。tryAttach 实际返回 attached 后，在同一同步段、任何下一 await 和 execution context 交出前，关联原 task/token/controller/admission 与一个完成 promise；以后原 finally 在这同一屏障上填入 D2 清理进度，不删除或替换原 promise。只有 D2 的全部真实 ACK 和原 admission.complete 成功后才 resolve 并移除。活跃但尚未进入 finally 的旧 driver 因而仍可被准确等待；后台不因屏障存在就伪造 stop proof 或提前执行清理。

selected attach 可以在原 review mutation lock 外先等待原屏障，但这只是前置优化。锁内仍运行原完整状态/source fence 读和 awaitReleasedSettled；在这些 await 之后、取得新 permit/admission 和实际 claim 之前，必须再次同步查询同一 Task 的原寿命屏障。发现旧屏障时，锁内返回私有 retry-after 结果并释放原锁，随后在锁外等待该准确 promise，完成后重新进入原锁，从原状态/source fence 读开始重跑原检查。不能在锁内等待清理，也不能把这一内部重试变成对调用方的 not-attached 或吞掉原错误。没有旧屏障才在同一同步段进入原 claim；整个原生产 attach 入口共用这一原任务锁，不新增绕行入口。

屏障不会在 owner release／registry.settle 时消失，所以初查后才开始 finally、异步原状态读期间开始 finally、awaitReleasedSettled 在 settle 后唤醒三种交错都只能进入锁外准确等待，不能提前 claim 或使用工作区。原 capture 在取得新 admission 时仍先于首次持久 await；等待期间不提前捕获新 grant，也不重用旧 ACK 派发。tryAttach 返回失败仍走已有的精确 recovery ACK 分支；不把尚未附着的工作伪装成已有 runtime。native 沿原 attach 与 registry 等待机制全文保持。

新增明确交错回归：旧 driver 已 attached，但锁外初查和原状态读已开始时尚未进入 finally；旧 finally 随后登记 progress、owner ACK 并 settle，workspace 阶段保持 pending／第一次 reject；原 registry waiter 已返回后新 selected claim 计数仍为零，原锁已释放且资源读写可用；后台精确重试到真正 workspace ACK 后，旧屏障仅 resolve 一次，新 attach 重入锁并重新核对状态/source fence，才允许首次新 admission／claim。完整 D2 的串行重试、原 controller 区分和 drain 等待回归继续保留。

## C2-W2 具名业务分类

新的 intent／续接 intent、node mint／激活、wrapper／新外部 effect prepare、runtime session claim／resume、workspace reserve／物化派发和人工 gate 派发均属于新执行工作；在输入／原业务条件之后且任何 workspace/runtime 效果之前受理，在原业务事务中 consumeNewWork。保留原 owner、source fence、effect journal、稳定 requestKey 和实际效果确认，不把事务外 current 查询当成最终消费。

已经实际发出的 process／code-host／workspace／runtime-session 结果、输出／事件、精确停止与终态落账属于原工作 ACK，必须有原 capture 及原 owner／effect receipt 条件。普通用户取消、复试、人工回答或重新派发继续按其真实触发动作区分控制／新工作／已发出收据；不能给整个方法族或通用 withTaskExecutionWrite 统一套 ACK。

boot orphan 修复、frame backfill、lease repair、recovery reconciliation 在原 preparing receipt 下使用 recovery，并保留 local-startup／durable-intent 区别。资源编辑、成员编辑、评审草稿／评论与纯读是资源控制面，不因执行失权关闭；实际 dispatch 或新 continuation 是另一具名动作。终态删除／归档／GC 的资源操作、已发出清理 ACK 和新资源效果分别保留实际边界。

124个候选中的 fence、嵌套 transaction 和同一操作的多笔 SQL 先归并到真实具名操作；同一方法如果包含不同动作，则分别定义受理和收据边界。分类表必须有双向源码守卫：真实生产入口到记录，以及记录到真实入口；无对应源码／条件／测试的一行不记完成。全文保留所有旧业务条件、错误、返回值和真实效果，不跨 owner 暗插新的公用 DB hook。

## 验收与进度边界

C2-W1 使用真实双 provider 原 claim 和 owner 行：permit-before-capture-before-await、原业务冲突优先、claim SQL 成功后 loss 全回滚、无 attach／无 intent claimed；成功原 token／claimed 形状保持；heartbeat 原 CAS 和新 token 原关联；draining 下原 ACK，禁止后续新派发；loss 与 tryAttach 交错时真实恢复 ACK；release 效果／owner／workspace 任一 ACK 未完成不得 complete 原 admission。保留原 normal pause/cancel 与 resource-only 行为。

C2-W1 有限通过不代表 C2-W2 分类、所有19 owner、三个实际 roots、早期恢复、named admission／UI、H7／A-T7／A-G 完成。只有完整阶段 A 验收后进入各层独立 CS adapters；M0 先实际部署，再 M1～M4 逐项接管。当前 AW 未部署 CS，RFC 继续进行。

## D4 认领事务结果未知时的原受理退场

D3 功能门已实际消费 PASS 后实施 C2，尚未 SOURCE 门或发布。源码核对发现当前初稿把“claim await 抛错”当成“没有形成 durable 工作”，直接 complete admission。原 PostgreSQL SERIALIZABLE 的 COMMIT 响应可能丢失；这时数据库已有 claimed owner/intent，原 token 又只能在 COMMIT 确认后交给调用方，不能以 thrown promise 推断未认领。D4 只补这一个失败退场机制，不改原事务隔离/自动重试、SQL/业务拒绝/错误对象、实际 driver 取消或恢复分类。

Task 新增自己的具名 failed-claim acknowledgement 端口。输入只含原 intentId、原 WorkerIdentity、原 TaskHostAdmittedWork；同步 capture 返回原 work、原 intent、原 Task scope 查询和 acknowledge 方法，不含数据库、SQL callback、SO/CS DTO 或新的执行 token。Task composition 从同一 selected Drizzle ownership 取得完整端口；selected 缺项在装配拒绝，native 沿原完整路径且零额外查询。capture 在原 permit 进入、原 admission acquire 后与首个持久 await 前完成，保留原方法/receiver，WorkerIdentity 使用传入原 claim SQL 的同一对象。

Task infrastructure 的捕获实例只记本次原 SQL 真实读到的 taskId 与真正完成的原 claim 体返回元组（epoch/revision/leaseUntil），不创建可执行 token、不改变任何原 SQL 条件。失败后，具名 ACK 查询原 intent 与该 task 的 owner，核对原 intentId、原 WorkerIdentity 和实际保存的认领元组。确定没有本次 durable 认领的原数据库事实才可确认退场。若读到这一原 claimed tuple/intent epoch，说明这次纯 SQL 认领存在，但调用方没有得到执行 token、尚未运行 runtime：只在这一原 ACK 内建立私有 trusted token 关联旧 work，按原精确 revision 调原 markRecoveryRequired，并消费原 issued-ACK；code 为 task-host-claim-result-unknown，proofDigest 为 null，不伪造 stop proof，也不把恢复 token交给认领调用方或用于新 dispatch。

认领体保存了原 epoch 等事实而数据库显示另一代 owner/intent、或当前事实不足以确认原未认领/精确退场时，保留原业务拒绝和 pending，不猜现任完成了旧工作。查询失败、原 recovery 写失败或响应不确定也保留同一捕获实例；实际 mark 输入的 revision/code/time 保存一次。后续只能通过该原 owner/intent/epoch、revision+1、code/null proof 和实际持久时间的精确回执确认已提交，不能重建当前 grant。原 capture 的所有操作保持在原旧 receipt 下。

Task 的同一 finalization collection 增加 failed-claim 进度，独立于 registry/controller。它在 catch 的首次 ACK await 前登记，持有原捕获实例、原方法/receiver、work 完成 promise 和错误。已知 scope 同 Task 的后续 selected attach 在已有 D3 锁内复核/锁外等待上一起观察；尚无 scope 的待确认认领通过该 collection 的未结 promise 阻止后续 selected attach，资源读写仍可用。后台旧 ACK loop 的 retryPending/drain 同时处理这类原进度，停止新的 polling/claim 后继续真实重试。

原 claim catch 保留原异常对象和 permit leave；先登记准确进度并尝试原 ACK，ACK reject 留在进度记录和后台重试，不取代原认领错误。只有真实未认领/精确 recovery ACK 后 complete 原 admission，并删除进度。确认过的原阶段不重放；重复异常交接或后台 drain 使用同一在途 promise。正常成功认领仍在 COMMIT 返回后才创建原 token/bind，并返回原 claimed 形状；D4 的私有恢复 token 永不冒充成功的 claim。

追加真实双 provider 回归：原业务冲突/receipt拒绝的完整回滚与真实未认领 ACK；原 COMMIT 结果丢失但同一 identity 的 owner/intent 已持久化，调用方仍收到原错误且零 attach/runtime；精确 recovery ACK 后才 complete；查询/写第一次失败后后台/drain 继续原捕获；mark 的响应丢失以原 tuple/proof 确认而不重复 SQL；另一代 owner 或不匹配 intent 不假完成，资源读写可用；旧 work/reference/method/receiver在后续修改后保持。D3 与当前 C2 所有既有测试和预算保留，新增套件仍交 hosted CI。D4 独立设计门实际消费 PASS 前不写这一补充的生产实现；当前 C2 主候选也不发布。

## D5 未提交判据与原事务的同步边界

D4 独立门的真实 FAIL 和两个授权最小 supplemental 完整保留。其 P2 是原 COMMIT 结果未知时，普通读取的 pending／旧 owner／无 owner 只表示该次读取尚未观察到原提交，不足以证明未认领。本段在 root 实际消费该完整 FAIL 后追加；D4 原文保持，D5 合同优先补足这项判据，不改全阶段或 CS adapter 的顺序。

具名 failed-claim capture 记录每次原事务体的 entered／rejected／fulfilled 时点，原 intent 实际读到的 taskId、原 owner 读取快照，以及完成全部原 claim SQL 后返回的原 taskId／epoch／revision／leaseUntil。它只记录原语句已经返回的事实，不创建执行 token；原 SQL／CAS／业务异常、SERIALIZABLE 和现有重试保持。body fulfilled 在原 callback 真正返回后记录；在首个 awaited SQL 前到失败交接期间仍未终结的 body 一律不能当作未认领。每次自动事务重试保留自己的完成及原快照事实，不能把前一轮 fulfilled 清掉而伪装为从未进入提交路径。

实际 provider 路径已经核对：SQLite 显式边界在 await body 成功后执行 COMMIT，体内 throw 进入 ROLLBACK；PostgreSQL 所委托的 SQLiteRemoteSession.transaction 同样只有 await body 成功才进入 COMMIT，catch 等待 ROLLBACK，自身失败并不向 caller 提供已回滚证明。D5 不以 thrown outer promise 或 ROLLBACK 被调用推断结果。只有所有已进入的 body 确已 reject、从无 fulfilled，或事务根本没有进入 body，且原调用已经交出原失败，才有“这个原调用不能在以后发送 COMMIT”的直接执行事实；仍需原具名 ACK 事务成功并核对没有原 identity 的 durable claimed owner／intent，才确认该未认领退场。任何 body 未终结、曾 fulfilled 而事实不足、或读取到同一 identity 的不同/不完整持久事实都继续 pending。

一旦原 body 曾 fulfilled，负面判断必须先等待其最后一笔原 intent claimed UPDATE 的锁释放。该 UPDATE 在 body 返回前已成功，持有原 intent 行写锁直到原事务 COMMIT／ROLLBACK 终结。具名 ACK 使用现有 DatabaseSession 的普通 write 事务：SQLite BEGIN IMMEDIATE 已等待原写者；PostgreSQL 先用现有 engine.lockAggregateRoot 锁定这同一原 intent 行，等待原行写者实际结束；取得锁后，才在同一事务中重新读取 intent 和 owner，使用 READ COMMITTED 的该次新读取。不能把锁前普通 SELECT、旧 snapshot 或未完成锁 await 的结果拿来完成。若原 intent 不再存在、scope 改变、锁或查询/ACK commit 失败，保持原 capture/pending，不猜原提交已结束。

锁后若原 intent 仍 pending，owner 完整内容与某次原认领实际读取的 before-owner 快照逐字段相同，且不存在本原 identity／元组的 claimed 事实，才证明原事务没有留下这次认领。原 owner 初始不存在时必须仍不存在；原 released owner 必须整行保持原快照。另一代 owner、不同 intent epoch、被改动的 before-owner 不是同一原未认领证明，继续 pending。具名 ACK 在同一 TaskHostWriteCapture 的 issued-ACK 下完成，ACK 自身提交确认前也不 complete admission。

锁后观察到某次原 body 返回的精确 claimed tuple 时继续 D4：原 WorkerIdentity 对象、intentId、taskId、epoch、revision、leaseUntil／原认领时间和 intent claimedEpoch 全部一致，才私有创建旧 work 的 recovery token，使用原 markRecoveryRequired 及其一次保存的 revision/code/time；原 mark 的 lost reply 仍只以同一 recovery 回执确认。此 token 永不交给正常 caller、registry 或新 runtime。额外 ACK 判据只属于这一具名失败认领合同，不推广为通用 DB hook，也不修改原 normal/native 路径。

追加真实回归锁定这项差额：COMMIT 仍可能在途时，普通读取的旧 pending／无 owner 不能让原 admission complete；行写者真实结束前，failed-claim ACK 和 drain 保持未结，其他资源读取/编辑可用；原提交完成后只观察同一 tuple并执行真实 recovery ACK，原回滚完成后只以锁后完整 before-owner／pending事实确认未认领。SQLite 的原同步提交与 PostgreSQL 的真实行锁分别按原 engine 能力测试，不用一个 fake query 回答冒充服务端事务终结。ROLLBACK 本身失败的 body-complete 场景继续 pending，直到这一原行锁及真实事实可确认；错误对象和原重试预算保持。D4 及现有 18 个 C2 回归全部保留，D5 功能设计门真正消费 PASS 后再实施这个补充。

## C2-W1 实现候选与正式验收边界

D1／D2／D4 原功能 FAIL 及 root 实际消费完整保留，D3 与 D5 有效稳定设计 PASS 已在相应生产接线前实际消费。当前 Task-owned admission、原 claim／heartbeat capture、driver 寿命屏障、失败认领和原 ACK 重试 collection 已接入两个模块形态；尚未在三个生产启动根选择，C2-W2 的业务写点分类、named admission、十九 owner 与 UI 继续，不能记 H7／A-G 完成。

失败认领保存每轮原 body 的 actual scope、完整 before-owner、tuple 和原输入时间／lease。曾 fulfilled 的未知 COMMIT 等待原 intent 行写者实际结束，再在同一普通 write 事务读取新事实及消费原 issued ACK；scope／时间或完整原快照不符保持 pending。recovery token 只属于原失败工作，原 mark 方法／receiver／输入保持；真实 recovery 和 workspace ACK 完成后才 complete 原 admission。当前错误仍回传原 claim 对象，permit先退出；未知 scope 的未结屏障在 D3 的锁外等待／锁内复核中阻止后续 selected attach，资源编辑保持可用。

新增真实双 provider 用例覆盖 COMMIT 在途／最终提交和真正回滚、原 released-owner 整行快照、联合改动时间的拒绝、未知 scope 等待，以及实际后台旧 ACK loop 在失权后继续精确重试／drain。PG 测试在原真实 pool 的保留连接上延迟服务端终结，使用另一个真实连接的 MVCC 读取和原 intent 行锁；SQLite 使用原同步提交／真实回滚。不以 fake query 回答证明事务终结。

所有原 native SQL／CAS／错误和测试预算保持，原 Windows workflow 全文可由逐项删除本批二十个对称触发路径及三个套件复原；历史 managed-process lost reply 用例保留原历史 attempts，使用原 aggregateEffectOutcome 核对一次真实效果完成。仅目标格式／lint、纯 AST／JSON／字节对拍；没有本机 AW tests／typecheck／build／services／E2E，whole census 尚未运行。SOURCE 独立功能门、配套门、上库及精确 SHA hosted CI 分别待验，不将设计 PASS 或静态对拍记为功能通过，AW 尚未部署 CS。

## D6 已发心跳的退场同步

SOURCE23-R1 有效稳定 FAIL 的唯一 P2 `H7-TASK-CALLERS-C2-W1-SOURCE23-F01` 已由 root 实际消费。原 timer 停止后，已发 heartbeat 仍可能占着 PostgreSQL owner 行锁；普通 read 读到旧 revision R，而清算等待 heartbeat 提交后读到 R+1，缓存的 R 会令全部原重试持续失败。原 69 项、完整回执与失败候选保留，尚未生成 census 或提交本批源码。本节仅提出修正设计，须独立设计门通过后实现。

selected driver 的 heartbeat 生命周期在开始 timer 时创建完整的 Task-owned 记录，保留原 token／work、实际 heartbeat 方法与 receiver、timer 和全部在途 Promise。每次原 timer 回调先检查该记录仍接收 heartbeat，随后同步调用原方法并立即登记实际 Promise；原错误仍 abort 同一 controller 并经原 logger 报告。停止时同步关闭该记录并清除原 timer，后续回调不能再发 heartbeat；保留记录至全部已经登记的 Promise 实际返回。原 native timer 与 stopHeartbeat 分支逐字保留，新增跟踪仅用于 selected 模式。

selected release 的依赖增加具名 `awaitHeartbeatAcks(tokenKey)`，在首次 await 之前捕获原函数及 receiver。清理仍先取得原 registry release／stopResult、执行原 stopHeartbeat，随后等待该原 driver 的全部在途 heartbeat 返回；任何等待或后续同步失败都保留在原 finalization progress，不 settle、complete 或释放后继 attach 屏障。方法拒绝本身不能证明服务端事务已经结束，因此还须下述具名同步操作，且保留原 heartbeat 的错误报告。

Task 自有的 private finalization fact 合同增加 `awaitHeartbeatWrites(token)`。所选 Drizzle adapter 在同一原 receipt／work 的 issued-ACK 普通事务内，用既有 `engineOf(tx).lockAggregateRoot` 锁原 `task_execution_owners.task_id`，然后沿原 transactionFor／consumeIssuedAck 提交。该锁等待同一原 owner writer 的真实 COMMIT／ROLLBACK；SQLite 沿原 BEGIN IMMEDIATE 边界。等待期间不持有 Task review mutation lock。只有这笔真实 ACK 返回后，清理才首次调用已经捕获的原 ownership.read 方法并固定 revision／stop proof。两次同步各自成功一次便保留 ACK，失败重试同一原 work；未知结果继续 pending。空 owner 或别的 owner 元组仍由原 read／同元组判据拒绝。

原纯 read 的缓存只能在上述同步之后建立。已经发出的清算、release、markRecoveryRequired 或 outcome-unknown 操作继续保留原参数、方法、receiver、时间、revision 和精确 lost-reply 确认；不把变化后的 revision 重新包装成已经发出的操作的成功回执。原 SQL、CAS、owner／effect／intent 判据、完成阶段与 workspace 重试规则保持。selected 清理中 release、heartbeat stop／drain、owner transfer、registry settle 和 workspace ACK 的顺序与每个失败的可重试边界分别验证。

同时将 provider background 的 generation 状态明确建模为完整的 `unselected | selected(lifetime)` 判别联合。构造时的 unselected 状态、每次真正 startAuthority 创建的完整 lifetime、旧 generation 的 canDispatch 身份比对及 drained 后替换均有显式分支；每个 handle 保留自己的原 lifetime。原 native mode、排队、普通 pause／close 和 loss quiesce 行为保持。T19b 原 scanner 与下降判据保持，通过实际状态建模消除新增 nullable holder；不新增例外或 placeholder debt。

回归继续使用真实双 provider、原 claim／driver／heartbeat timer、原 heartbeat SQL 与原 release／retry／drain：验证实际在途 heartbeat 时清理不读取或缓存旧 revision，Task 资源编辑仍可完成，完成后按同一原 work 收齐清理并仅 complete 一次；验证 heartbeat 原拒绝与重试边界。PG 另保留真实 owner UPDATE 的原 writer 连接，将服务端终结延后到 raw Promise 拒绝之后，分别真正 COMMIT／ROLLBACK；另一真实连接证明同步前的 MVCC revision，原 owner 行锁证明同步仍在等待，服务端终结后按实际新 revision 完成原 CAS。SQLite 使用真实提交／回滚与原 timer 回调，不以 fake row 代替这些事实。现有全部 32 个每 provider 案例、历史 attempts、原规则与 timeout 保留；新增案例明确列出自己的原预算。

D6 设计、修正后的 SOURCE、一次原 scoped census／配套门、精确发布和新 exact-SHA hosted CI 各自验收。C2-W2、所有十九 owner／三个 roots／UI、完整 H7／A-T7／A-G 与 CS M0～M4 继续；本节不提供这些阶段的完成证据。


## D6 设计门与修正候选

D6 DESIGN1-R6 已有效稳定 PASS，28 项（1 owned／21 control／6 evidence）、603,925 bytes，root 在修正源码前实际消费完整首末绑定；SOURCE23-R1 的原 P2 FAIL、回执与失败候选完整保留。selected 原 heartbeat timer 现保留完整 work／token／方法／receiver／timer／在途 Promise，停止派发后等待实际返回，再通过同一原 work 的 issued-ACK 事务等待 owner writer 的真实结束；成功同步后才读取并固定清理 revision。同步失败保留原 finalization，不 settle 或 complete，后续阶段仍按原方法、参数和精确回执重试。generation 使用实际 unselected／selected(lifetime) 状态，完整旧 handle 仅在 drained 后允许替换；原 T19b 规则未改。

原双 provider 32 案例及完整业务断言／历史 attempts／原预算逐项保留，新增 4 案例／provider：原 15s heartbeat timer 在途时收尾／drain 与资源编辑、同步 ACK 失败重试、真实 COMMIT 和 ROLLBACK 及 PG raw Promise 拒绝后仍持原 owner 行锁的服务端终结。新增 timer 案例使用 60s，同步失败案例 15s；没有改变既有案例预算。目标格式／ESLint 与 90 项纯 AST／字节对拍通过，未执行本机 AW tests、typecheck、build、service 或 E2E。修正源码 SOURCE23-R2、一次 scoped census／配套门、上库及 exact-SHA hosted CI 仍各自待验。
